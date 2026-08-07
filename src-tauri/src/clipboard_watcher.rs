use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::Manager;

use crate::AppState;

fn get_foreground_window_title() -> String {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
    }
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return String::new();
        }
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 {
            return String::new();
        }
        std::ffi::OsString::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .into_owned()
    }
}

pub fn start(app_handle: tauri::AppHandle, enabled: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut last_text = String::new();
        let mut cooldown_until = std::time::Instant::now();

        loop {
            thread::sleep(Duration::from_millis(500));

            if !enabled.load(Ordering::Relaxed) {
                continue;
            }
            if std::time::Instant::now() < cooldown_until {
                continue;
            }

            let mut triggered = false;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                triggered = poll_once(&app_handle, &mut last_text);
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

fn poll_once(app_handle: &tauri::AppHandle, last_text: &mut String) -> bool {
    let current = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().unwrap_or_default(),
        Err(_) => return false,
    };

    let trimmed = current.trim().to_string();
    if trimmed.is_empty() || trimmed == *last_text {
        return false;
    }
    *last_text = trimmed.clone();

    if !is_english_text(last_text) {
        return false;
    }

    let state = app_handle.state::<AppState>();
    if let Ok(ll) = state.last_looked_up.lock() {
        if *ll == trimmed {
            eprintln!("[clipboard] skipping already looked-up text");
            return false;
        }
    }

    let kind = detect_kind(last_text);
    let win_title = get_foreground_window_title();
    eprintln!("[clipboard] detected: {last_text:?} kind={kind} from={win_title:?}");

    let capture_data = serde_json::json!({
        "selection": *last_text,
        "context": *last_text,
        "sourceApp": win_title,
        "sourceTitle": win_title,
        "kind": kind,
        "method": "clipboard",
    });

    let state = app_handle.state::<AppState>();
    if let Ok(mut lc) = state.last_capture.lock() {
        *lc = Some(capture_data);
    }
    if let Ok(mut ll) = state.last_looked_up.lock() {
        *ll = trimmed.clone();
    }

    if let Some(win) = app_handle.get_webview_window("lookup") {
        let _ = win.close();
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let is_long = kind == "paragraph";
    let app_h = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        let (w, h) = if is_long { (560.0, 700.0) } else { (420.0, 560.0) };
        let _ = tauri::WebviewWindowBuilder::new(
            &app_h,
            "lookup",
            tauri::WebviewUrl::App("lookup".into()),
        )
        .title("鸽鸽词典")
        .inner_size(w, h)
        .center()
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .focused(true)
        .build();
    });

    true
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

pub fn lookup_clipboard(app_handle: &tauri::AppHandle, last_capture: &Mutex<Option<serde_json::Value>>) {
    let text = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().unwrap_or_default().trim().to_string(),
        Err(_) => return,
    };

    if text.is_empty() {
        return;
    }

    let state = app_handle.state::<AppState>();
    if let Ok(ll) = state.last_looked_up.lock() {
        if *ll == text {
            eprintln!("[clipboard] skipping duplicate lookup: {:?}", &text[..text.len().min(40)]);
            if let Some(win) = app_handle.get_webview_window("lookup") {
                let _ = win.set_focus();
            }
            return;
        }
    }

    if let Ok(mut ll) = state.last_looked_up.lock() {
        *ll = text.clone();
    }

    let kind = detect_kind(&text);
    let win_title = get_foreground_window_title();

    let capture_data = serde_json::json!({
        "selection": text,
        "context": text,
        "sourceApp": win_title,
        "sourceTitle": win_title,
        "kind": kind,
        "method": "clipboard_manual",
    });

    if let Ok(mut lc) = last_capture.lock() {
        *lc = Some(capture_data);
    }

    if let Some(win) = app_handle.get_webview_window("lookup") {
        let _ = win.close();
        std::thread::sleep(Duration::from_millis(150));
    }

    let is_long = kind == "paragraph";
    let app_h = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        let (w, h) = if is_long { (560.0, 700.0) } else { (420.0, 560.0) };
        let _ = tauri::WebviewWindowBuilder::new(
            &app_h,
            "lookup",
            tauri::WebviewUrl::App("lookup".into()),
        )
        .title("鸽鸽词典")
        .inner_size(w, h)
        .center()
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .focused(true)
        .build();
    });
}
