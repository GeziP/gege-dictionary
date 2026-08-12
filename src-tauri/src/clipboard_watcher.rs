use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::Manager;

use crate::content_filter;
use crate::AppState;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipboardFingerprint {
    pub sequence: u32,
    pub text: String,
}

fn should_skip_lookup(last: Option<&ClipboardFingerprint>, sequence: u32, text: &str) -> bool {
    last.is_some_and(|previous| previous.sequence == sequence && previous.text == text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_clipboard_sequence_is_deduplicated_but_recopy_is_allowed() {
        let previous = ClipboardFingerprint {
            sequence: 7,
            text: "same text".into(),
        };
        assert!(should_skip_lookup(Some(&previous), 7, "same text"));
        assert!(!should_skip_lookup(Some(&previous), 8, "same text"));
        assert!(!should_skip_lookup(Some(&previous), 7, "new text"));
    }
}

fn clipboard_sequence_number() -> u32 {
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    // SAFETY: this is a side-effect-free Win32 query with no pointers.
    unsafe { GetClipboardSequenceNumber() }
}

fn get_foreground_window_info() -> (String, String) {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, process_id: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn QueryFullProcessImageNameW(
            process: isize,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return (String::new(), String::new());
        }

        // Window title
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = if len > 0 {
            std::ffi::OsString::from_wide(&buf[..len as usize])
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        };

        // Process name
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let process_name = if pid != 0 {
            let handle = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if handle != 0 {
                let mut name_buf = [0u16; 260];
                let mut size = name_buf.len() as u32;
                let ok = QueryFullProcessImageNameW(handle, 0, name_buf.as_mut_ptr(), &mut size);
                CloseHandle(handle);
                if ok != 0 {
                    let path = std::ffi::OsString::from_wide(&name_buf[..size as usize])
                        .to_string_lossy()
                        .into_owned();
                    path.rsplit('\\').next().unwrap_or(&path).to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        (title, process_name)
    }
}

const DEFAULT_BLACKLIST: &[&str] = &[
    "1password",
    "keepass",
    "bitwarden",
    "lastpass",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "code.exe",
    "devenv.exe",
    "idea64.exe",
];

fn is_blacklisted(process_name: &str, window_title: &str, custom_blacklist: &[String]) -> bool {
    let proc_lower = process_name.to_lowercase();
    let title_lower = window_title.to_lowercase();

    for entry in DEFAULT_BLACKLIST {
        if proc_lower.contains(entry) || title_lower.contains(entry) {
            return true;
        }
    }
    for entry in custom_blacklist {
        let e = entry.to_lowercase();
        if proc_lower.contains(&e) || title_lower.contains(&e) {
            return true;
        }
    }
    false
}

pub fn start(app_handle: tauri::AppHandle, enabled: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut last_text = String::new();
        let mut last_sequence = clipboard_sequence_number();
        let mut cooldown_until = std::time::Instant::now();
        let mut last_clipboard_poll = std::time::Instant::now() - Duration::from_millis(500);
        let mut last_mode_check = std::time::Instant::now() - Duration::from_millis(500);
        let mut mode = "smart".to_string();
        let mut ctrl_c_was_down = false;
        let mut first_ctrl_c: Option<std::time::Instant> = None;

        loop {
            thread::sleep(Duration::from_millis(50));

            if !enabled.load(Ordering::Relaxed) {
                continue;
            }
            let now = std::time::Instant::now();
            if now.duration_since(last_mode_check) >= Duration::from_millis(500) {
                mode = get_trigger_mode(&app_handle).0;
                if mode == "manual" {
                    mode = "double".into();
                }
                last_mode_check = now;
            }
            if mode == "double" {
                let ctrl_c_down = is_ctrl_c_down();
                if ctrl_c_down && !ctrl_c_was_down {
                    if first_ctrl_c.is_some_and(|first| {
                        now.duration_since(first) <= Duration::from_millis(700)
                    }) {
                        let state = app_handle.state::<AppState>();
                        lookup_clipboard(&app_handle, &state.last_capture);
                        first_ctrl_c = None;
                    } else {
                        first_ctrl_c = Some(now);
                    }
                }
                ctrl_c_was_down = ctrl_c_down;
                continue;
            }
            if now.duration_since(last_clipboard_poll) < Duration::from_millis(500) {
                continue;
            }
            last_clipboard_poll = now;
            if std::time::Instant::now() < cooldown_until {
                continue;
            }

            let mut triggered = false;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                triggered = poll_once(&app_handle, &mut last_text, &mut last_sequence);
            }));
            if let Err(e) = result {
                eprintln!("[clipboard] recovered from panic: {e:?}");
            }
            if triggered {
                cooldown_until = std::time::Instant::now() + Duration::from_secs(3);
            }
        }
    });
}

fn is_ctrl_c_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
    }
    const VK_CONTROL: i32 = 0x11;
    const VK_C: i32 = 0x43;
    unsafe {
        (GetAsyncKeyState(VK_CONTROL) as u16 & 0x8000) != 0
            && (GetAsyncKeyState(VK_C) as u16 & 0x8000) != 0
    }
}

fn get_trigger_mode(app_handle: &tauri::AppHandle) -> (String, Vec<String>) {
    let state = app_handle.state::<AppState>();
    if let Ok(db) = state.db.lock() {
        if let Ok(settings) = db.get_settings() {
            let mode = settings
                .get("clipboardMode")
                .and_then(|v| v.as_str())
                .unwrap_or("smart")
                .to_string();
            let blacklist = settings
                .get("clipboardBlacklist")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            return (mode, blacklist);
        }
    }
    ("smart".to_string(), Vec::new())
}

fn poll_once(
    app_handle: &tauri::AppHandle,
    last_text: &mut String,
    last_sequence: &mut u32,
) -> bool {
    let current = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().unwrap_or_default(),
        Err(_) => return false,
    };

    let sequence = clipboard_sequence_number();
    let trimmed = current.trim().to_string();
    if trimmed.is_empty() || (sequence == *last_sequence && trimmed == *last_text) {
        return false;
    }
    *last_sequence = sequence;
    *last_text = trimmed.clone();

    let (mode, blacklist) = get_trigger_mode(app_handle);

    // "manual" mode: only trigger via tray/hotkey, never auto
    if mode == "manual" {
        return false;
    }

    if !is_english_text(last_text) {
        return false;
    }

    // "smart" mode: apply content filter and blacklist
    let (win_title, proc_name) = get_foreground_window_info();
    if mode == "smart" {
        if content_filter::should_reject(last_text) {
            eprintln!(
                "[clipboard] rejected by content filter: {:?}",
                &last_text[..last_text.len().min(40)]
            );
            return false;
        }

        if is_blacklisted(&proc_name, &win_title, &blacklist) {
            eprintln!("[clipboard] blacklisted app: {proc_name} / {win_title}");
            return false;
        }
    }

    let state = app_handle.state::<AppState>();
    if let Ok(ll) = state.last_looked_up.lock() {
        if should_skip_lookup(ll.as_ref(), sequence, &trimmed) {
            eprintln!("[clipboard] skipping already looked-up text");
            return false;
        }
    }

    let kind = detect_kind(last_text);
    eprintln!(
        "[clipboard] detected: {:?} kind={kind} from={win_title:?}",
        &last_text[..last_text.len().min(60)]
    );

    let capture_data = serde_json::json!({
        "selection": *last_text,
        "context": *last_text,
        "sourceApp": proc_name,
        "sourceTitle": win_title,
        "kind": kind,
        "method": "clipboard",
    });

    let state = app_handle.state::<AppState>();
    if let Ok(mut lc) = state.last_capture.lock() {
        *lc = Some(capture_data);
    }
    if let Ok(mut ll) = state.last_looked_up.lock() {
        *ll = Some(ClipboardFingerprint {
            sequence,
            text: trimmed.clone(),
        });
    }

    open_or_reuse_lookup(app_handle, kind == "paragraph");
    true
}

fn open_or_reuse_lookup(app_handle: &tauri::AppHandle, is_long: bool) {
    let (w, h) = if is_long {
        (560.0, 700.0)
    } else {
        (420.0, 560.0)
    };

    if let Some(win) = app_handle.get_webview_window("lookup") {
        // Reuse existing window: navigate and resize
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: w,
            height: h,
        }));
        position_lookup_window(app_handle, &win, w, h);
        let _ = win.show();
        let _ = win.eval("window.location.reload()");
        return;
    }

    let app_h = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        let _ = tauri::WebviewWindowBuilder::new(
            &app_h,
            "lookup",
            tauri::WebviewUrl::App("lookup".into()),
        )
        .title("鸽鸽词典")
        .inner_size(w, h)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map(|win| position_lookup_window(&app_h, &win, w, h));
    });
}

fn position_lookup_window(
    app_handle: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    logical_width: f64,
    logical_height: f64,
) {
    let Ok(cursor) = app_handle.cursor_position() else {
        return;
    };
    let Ok(Some(monitor)) = app_handle.monitor_from_point(cursor.x, cursor.y) else {
        return;
    };
    let scale = monitor.scale_factor();
    let width = logical_width * scale;
    let height = logical_height * scale;
    let origin = monitor.position();
    let size = monitor.size();
    let left = origin.x as f64 + 8.0;
    let top = origin.y as f64 + 8.0;
    let right = origin.x as f64 + size.width as f64 - 8.0;
    let bottom = origin.y as f64 + size.height as f64 - 8.0;
    let mut x = cursor.x + 14.0;
    let mut y = cursor.y + 20.0;
    if x + width > right {
        x = cursor.x - width - 14.0;
    }
    if y + height > bottom {
        y = cursor.y - height - 14.0;
    }
    x = x.clamp(left, (right - width).max(left));
    y = y.clamp(top, (bottom - height).max(top));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x as i32, y as i32,
    )));
}

fn is_english_text(text: &str) -> bool {
    let len = text.len();
    if len == 0 || len > 5000 {
        return false;
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        return false;
    }
    if text.starts_with('{') || text.starts_with('[') || text.starts_with('<') {
        return false;
    }
    let ascii_letters = text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if ascii_letters == 0 {
        return false;
    }
    let ratio = ascii_letters as f64 / len as f64;
    ratio > 0.4
}

fn detect_kind(text: &str) -> &'static str {
    let word_count = text.split_whitespace().count();
    if word_count >= 30 {
        "paragraph"
    } else if word_count >= 6 {
        "sentence"
    } else if word_count > 1 {
        "phrase"
    } else {
        "word"
    }
}

pub fn lookup_clipboard(
    app_handle: &tauri::AppHandle,
    last_capture: &Mutex<Option<serde_json::Value>>,
) {
    let text = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().unwrap_or_default().trim().to_string(),
        Err(_) => return,
    };

    if text.is_empty() {
        return;
    }
    let sequence = clipboard_sequence_number();

    let state = app_handle.state::<AppState>();
    if let Ok(ll) = state.last_looked_up.lock() {
        if should_skip_lookup(ll.as_ref(), sequence, &text) {
            eprintln!(
                "[clipboard] skipping duplicate lookup: {:?}",
                &text[..text.len().min(40)]
            );
            return;
        }
    }

    if let Ok(mut ll) = state.last_looked_up.lock() {
        *ll = Some(ClipboardFingerprint {
            sequence,
            text: text.clone(),
        });
    }

    let kind = detect_kind(&text);
    let (win_title, proc_name) = get_foreground_window_info();

    let capture_data = serde_json::json!({
        "selection": text,
        "context": text,
        "sourceApp": proc_name,
        "sourceTitle": win_title,
        "kind": kind,
        "method": "clipboard_manual",
    });

    if let Ok(mut lc) = last_capture.lock() {
        *lc = Some(capture_data);
    }

    open_or_reuse_lookup(app_handle, kind == "paragraph");
}
