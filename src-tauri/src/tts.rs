use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub fn speak(text: &str, voice: &str, rate: f64) -> Result<(), String> {
    let rate_int = ((rate - 1.0) * 5.0).round() as i32;
    let rate_clamped = rate_int.clamp(-10, 10);

    let escaped_text = text.replace('\'', "''").replace('\n', " ");
    let voice_filter = if voice.is_empty() { "Zira".to_string() } else { voice.replace('\'', "''") };

    let script = format!(
        r#"Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try {{ $voices = $s.GetInstalledVoices() | Where-Object {{ $_.VoiceInfo.Name -like '*{voice_filter}*' }}; if ($voices) {{ $s.SelectVoice($voices[0].VoiceInfo.Name) }} }} catch {{}}; $s.Rate = {rate_clamped}; $s.Speak('{escaped_text}')"#
    );

    Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", &script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("TTS 启动失败: {e}"))?;

    Ok(())
}

pub fn list_voices() -> Result<Vec<String>, String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NoLogo",
            "-Command",
            r#"Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"#,
        ])
        .output()
        .map_err(|e| format!("Failed to list voices: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let voices: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    Ok(voices)
}
