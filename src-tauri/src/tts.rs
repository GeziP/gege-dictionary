//! Text-to-speech through the Windows System.Speech engine (PowerShell bridge).
//!
//! Security model: user-controlled strings (the text to read and the voice
//! name) are NEVER interpolated into the PowerShell script. The script is a
//! compile-time constant and receives its inputs through environment
//! variables, so no quoting or escaping scheme is involved at all.
//!
//! The previous implementation spliced the text into a single-quoted
//! PowerShell string and only doubled ASCII `'`. PowerShell also treats the
//! typographic quotes U+2018/U+2019/U+201A/U+201B as single-quote delimiters,
//! so ordinary copied text such as `don’t` broke the script and a crafted
//! selection could run arbitrary commands.
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Upper bound on characters handed to the speech engine in one request.
const MAX_SPEAK_CHARS: usize = 4000;
const POLL_INTERVAL: Duration = Duration::from_millis(40);

const ENV_TEXT: &str = "GEGE_TTS_TEXT";
const ENV_VOICE: &str = "GEGE_TTS_VOICE";
const ENV_RATE: &str = "GEGE_TTS_RATE";

const SPEAK_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $want = $env:GEGE_TTS_VOICE
  if ([string]::IsNullOrWhiteSpace($want)) { $want = 'Zira' }
  foreach ($v in $s.GetInstalledVoices()) {
    if ($v.VoiceInfo.Name.IndexOf($want, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $s.SelectVoice($v.VoiceInfo.Name)
      break
    }
  }
} catch {}
$s.Rate = [int]$env:GEGE_TTS_RATE
$s.Speak($env:GEGE_TTS_TEXT)
"#;

const LIST_VOICES_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
"#;

struct Playback {
    token: u64,
    child: Child,
}

/// The one utterance that may currently be playing. A new request replaces
/// (and silences) it, so rapid clicks never stack voices on top of each other.
static PLAYBACK: Mutex<Option<Playback>> = Mutex::new(None);
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
static VOICES: OnceLock<Vec<String>> = OnceLock::new();

fn powershell(script: &'static str) -> Command {
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Normalise text for the speech engine: control characters (including NUL,
/// which environment variables cannot carry) become spaces, runs of
/// whitespace collapse, and the result is capped without splitting a
/// character. `None` means there is nothing to say.
fn sanitize_text(text: &str) -> Option<String> {
    let mut out = String::with_capacity(text.len().min(MAX_SPEAK_CHARS));
    let mut pending_space = false;
    let mut chars = 0usize;
    for ch in text.chars() {
        if ch.is_whitespace() || ch.is_control() {
            pending_space = !out.is_empty();
            continue;
        }
        if chars >= MAX_SPEAK_CHARS {
            break;
        }
        if pending_space {
            out.push(' ');
            chars += 1;
            pending_space = false;
            if chars >= MAX_SPEAK_CHARS {
                break;
            }
        }
        out.push(ch);
        chars += 1;
    }
    // A separator may have consumed the last slot of the budget.
    out.truncate(out.trim_end().len());
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Map the UI speed multiplier (1.0 = normal) to the SAPI range [-10, 10].
fn sapi_rate(rate: f64) -> i32 {
    (((rate - 1.0) * 5.0).round() as i32).clamp(-10, 10)
}

fn speak_command(text: &str, voice: &str, rate: f64) -> Command {
    let mut command = powershell(SPEAK_SCRIPT);
    command
        .env(ENV_TEXT, text)
        .env(ENV_VOICE, sanitize_text(voice).unwrap_or_default())
        .env(ENV_RATE, sapi_rate(rate).to_string());
    command
}

/// Silence whatever is currently being read, if anything.
pub fn stop() {
    if let Ok(mut slot) = PLAYBACK.lock() {
        if let Some(mut playback) = slot.take() {
            let _ = playback.child.kill();
        }
    }
}

/// Start reading `text`, replacing any utterance already in progress.
/// Returns the playback token, or `None` when there was nothing to say.
fn start(text: &str, voice: &str, rate: f64) -> Result<Option<u64>, String> {
    let Some(text) = sanitize_text(text) else {
        return Ok(None);
    };
    let mut command = speak_command(&text, voice, rate);
    let mut slot = PLAYBACK
        .lock()
        .map_err(|_| "朗读状态不可用".to_string())?;
    if let Some(mut previous) = slot.take() {
        let _ = previous.child.kill();
    }
    let child = command
        .spawn()
        .map_err(|e| format!("TTS 启动失败: {e}"))?;
    let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    *slot = Some(Playback { token, child });
    Ok(Some(token))
}

/// Read `text` aloud and return once playback has actually finished.
///
/// Returns `Ok(())` when playback completes or is superseded/stopped by
/// another request, and `Err` when the speech engine itself fails.
pub fn speak_blocking(text: &str, voice: &str, rate: f64) -> Result<(), String> {
    let Some(token) = start(text, voice, rate)? else {
        return Ok(());
    };
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let mut slot = PLAYBACK
            .lock()
            .map_err(|_| "朗读状态不可用".to_string())?;
        let state = match slot.as_mut() {
            Some(playback) if playback.token == token => playback.child.try_wait(),
            // Superseded by a newer request or stopped explicitly.
            _ => return Ok(()),
        };
        match state {
            Ok(None) => {}
            Ok(Some(status)) => {
                *slot = None;
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("TTS 进程异常退出（{status}）"))
                };
            }
            Err(e) => {
                *slot = None;
                return Err(format!("TTS 状态查询失败: {e}"));
            }
        }
    }
}

fn query_voices() -> Result<Vec<String>, String> {
    let output = powershell(LIST_VOICES_SCRIPT)
        .output()
        .map_err(|e| format!("无法列出语音: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法列出语音: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

/// Installed voice names. Cached for the process lifetime because spawning
/// PowerShell and loading System.Speech costs around a second.
pub fn list_voices() -> Result<Vec<String>, String> {
    if let Some(voices) = VOICES.get() {
        return Ok(voices.clone());
    }
    let voices = query_voices()?;
    if !voices.is_empty() {
        let _ = VOICES.set(voices.clone());
    }
    Ok(voices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    const LEFT: char = '\u{2018}';
    const RIGHT: char = '\u{2019}';

    fn hex(text: &str) -> String {
        text.bytes().map(|b| format!("{b:02X}")).collect()
    }

    #[test]
    fn sanitize_collapses_whitespace_and_strips_control_characters() {
        assert_eq!(
            sanitize_text("  hello \r\n\t world \u{0}!  ").as_deref(),
            Some("hello world !")
        );
        assert_eq!(sanitize_text("a\u{7}b").as_deref(), Some("a b"));
    }

    #[test]
    fn sanitize_returns_none_when_there_is_nothing_to_say() {
        assert_eq!(sanitize_text(""), None);
        assert_eq!(sanitize_text(" \r\n\t \u{0} "), None);
    }

    #[test]
    fn sanitize_caps_length_on_a_character_boundary() {
        let long = "语".repeat(MAX_SPEAK_CHARS + 500);
        let out = sanitize_text(&long).unwrap();
        assert_eq!(out.chars().count(), MAX_SPEAK_CHARS);
        let spaced = "ab ".repeat(MAX_SPEAK_CHARS);
        let out = sanitize_text(&spaced).unwrap();
        assert!(out.chars().count() <= MAX_SPEAK_CHARS);
        assert!(!out.ends_with(' '));
    }

    #[test]
    fn sapi_rate_maps_and_clamps() {
        assert_eq!(sapi_rate(1.0), 0);
        assert_eq!(sapi_rate(1.4), 2);
        assert_eq!(sapi_rate(100.0), 10);
        assert_eq!(sapi_rate(-100.0), -10);
        assert_eq!(sapi_rate(f64::NAN), 0);
    }

    #[test]
    fn user_text_never_reaches_the_script_only_the_environment() {
        let hostile = format!("a{RIGHT}); Write-Output INJECTED; ({LEFT}b '; calc; '");
        let command = speak_command(&hostile, &format!("Zira{RIGHT};calc"), 1.0);

        let args: Vec<&OsStr> = command.get_args().collect();
        let script = args.last().unwrap().to_string_lossy();
        assert_eq!(script, SPEAK_SCRIPT, "the script must stay a constant");
        for arg in &args {
            let arg = arg.to_string_lossy();
            assert!(!arg.contains("INJECTED"), "text leaked into args: {arg}");
            assert!(!arg.contains("calc"), "voice leaked into args: {arg}");
        }

        let env = |key: &str| {
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new(key))
                .and_then(|(_, value)| value)
                .map(|value| value.to_string_lossy().into_owned())
        };
        assert_eq!(env(ENV_TEXT).as_deref(), Some(hostile.as_str()));
        assert_eq!(env(ENV_RATE).as_deref(), Some("0"));
        assert!(env(ENV_VOICE).unwrap().contains("calc"));
    }

    #[test]
    fn speak_script_reads_every_input_from_the_environment_only() {
        for key in [ENV_TEXT, ENV_VOICE, ENV_RATE] {
            assert!(
                SPEAK_SCRIPT.contains(&format!("$env:{key}")),
                "the script must read {key} from the environment"
            );
        }
        for placeholder in ["{text}", "{voice}", "{rate}", "{0}", "{1}"] {
            assert!(!SPEAK_SCRIPT.contains(placeholder), "template marker {placeholder}");
            assert!(!LIST_VOICES_SCRIPT.contains(placeholder));
        }
    }

    /// Runs real PowerShell with the same transport the speech path uses and
    /// echoes the received bytes back as hex, so nothing in the payload can
    /// be interpreted, re-encoded or lost along the way.
    #[cfg(windows)]
    #[test]
    fn environment_transport_is_byte_exact_in_powershell() {
        const ECHO_HEX: &str = "$b=[System.Text.Encoding]::UTF8.GetBytes($env:GEGE_TTS_TEXT); \
                                [BitConverter]::ToString($b).Replace('-','')";
        let payloads = [
            format!("don{RIGHT}t stop, it{RIGHT}s {LEFT}fine{RIGHT}"),
            format!("a{RIGHT}); Write-Output INJECTED_MARKER; ({LEFT}b"),
            "quote ' double \" backtick ` dollar $(Get-Date) $env:USERNAME".to_string(),
            "中文，混合 English — “curly” 😀".to_string(),
        ];
        for payload in payloads {
            let mut command = powershell(ECHO_HEX);
            command.env(ENV_TEXT, &payload);
            let output = command.output().expect("powershell should start");
            let echoed = String::from_utf8_lossy(&output.stdout).trim().to_string();
            assert_eq!(echoed, hex(&payload), "payload was altered: {payload}");
            assert!(!echoed.contains("INJECTED"));
        }
    }

    #[test]
    fn stop_with_nothing_playing_is_a_no_op() {
        stop();
        stop();
    }

    #[test]
    fn speaking_empty_text_succeeds_without_spawning_anything() {
        assert!(speak_blocking("  \u{0} \n ", "", 1.0).is_ok());
        assert!(PLAYBACK.lock().unwrap().is_none());
    }
}
