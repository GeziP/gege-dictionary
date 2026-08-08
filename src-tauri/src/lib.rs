mod clipboard_watcher;
mod content_filter;
mod db;
#[cfg(windows)]
mod dpapi;
mod llm;
mod tts;

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

pub struct AppState {
    pub db: Mutex<db::Database>,
    pub last_capture: Mutex<Option<serde_json::Value>>,
    pub clipboard_enabled: Arc<AtomicBool>,
    pub last_looked_up: Mutex<String>,
}

#[tauri::command]
async fn get_all_words(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_words()
}

#[tauri::command]
async fn search_words(
    state: tauri::State<'_, AppState>,
    query: String,
    tag: Option<String>,
    source: Option<String>,
    mastery: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.search_words(&query, tag.as_deref(), source.as_deref(), mastery.as_deref())
}

#[tauri::command]
async fn save_word(
    state: tauri::State<'_, AppState>,
    word: serde_json::Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_word(&word)
}

#[tauri::command]
async fn update_word(
    state: tauri::State<'_, AppState>,
    id: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_word(&id, &patch)
}

#[tauri::command]
async fn delete_words(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_words(&ids)
}

#[tauri::command]
async fn get_all_tags(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_tags()
}

#[tauri::command]
async fn get_settings(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut settings = db.get_settings()?;

    // Decrypt API key for the frontend
    #[cfg(windows)]
    if let Some(provider) = settings.get_mut("provider").and_then(|p| p.as_object_mut()) {
        if let Some(key_val) = provider.get("apiKey").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            if dpapi::is_encrypted(&key_val) {
                match dpapi::decrypt(&key_val) {
                    Ok(plain) => { provider.insert("apiKey".to_string(), serde_json::Value::String(plain)); }
                    Err(e) => {
                        eprintln!("[get_settings] DPAPI decrypt failed: {e}, clearing key");
                        provider.insert("apiKey".to_string(), serde_json::Value::String(String::new()));
                    }
                }
            }
        }
    }

    Ok(settings)
}

#[tauri::command]
async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let mut settings = settings;

    // Encrypt API key before storage
    #[cfg(windows)]
    if let Some(provider) = settings.get_mut("provider").and_then(|p| p.as_object_mut()) {
        if let Some(key_val) = provider.get("apiKey").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            if !key_val.is_empty() && !dpapi::is_encrypted(&key_val) {
                match dpapi::encrypt(&key_val) {
                    Ok(encrypted) => { provider.insert("apiKey".to_string(), serde_json::Value::String(encrypted)); }
                    Err(e) => eprintln!("[save_settings] DPAPI encrypt warning: {e}"),
                }
            }
        }
    }

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_settings(&settings)
}

#[tauri::command]
async fn get_templates(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_templates()
}

#[tauri::command]
async fn save_template(
    state: tauri::State<'_, AppState>,
    template: serde_json::Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_template(&template)
}

#[tauri::command]
async fn get_usage(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_usage()
}

#[tauri::command]
async fn increment_usage(
    state: tauri::State<'_, AppState>,
    tokens: u32,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.increment_usage(tokens)
}

#[tauri::command]
async fn lookup_word(
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    kind: String,
) -> Result<serde_json::Value, String> {
    let (base_url, api_key, model, protocol, temperature, max_tokens, timeout_secs, template_body, template_name) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        let provider = settings
            .get("provider")
            .ok_or("No provider configured")?
            .clone();
        let templates = db.get_templates()?;
        let scope = match kind.as_str() {
            "paragraph" => "paragraph",
            "sentence" => "sentence",
            _ => "word",
        };
        let matched = templates
            .iter()
            .find(|t| {
                let s = t.get("scope").and_then(|v| v.as_str()).unwrap_or("");
                s == scope
            })
            .or_else(|| templates.iter().find(|t| {
                let s = t.get("scope").and_then(|v| v.as_str()).unwrap_or("");
                s == "all"
            }))
            .or(templates.first());
        let tpl_body = matched.map(|t| {
            t.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string()
        }).unwrap_or_default();
        let tpl_name = matched.map(|t| {
            t.get("name").and_then(|v| v.as_str()).unwrap_or("未知模板").to_string()
        }).unwrap_or_else(|| "无匹配模板".to_string());
        let tpl_scope = matched.map(|t| {
            t.get("scope").and_then(|v| v.as_str()).unwrap_or("").to_string()
        }).unwrap_or_default();

        let mut mt = provider.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(1200) as u32;
        let mut ts = provider.get("timeoutSeconds")
            .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
            .unwrap_or(60);
        if kind == "paragraph" {
            mt = mt.max(4000);
            ts = ts.max(120);
        }

        let raw_key = provider.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
        #[cfg(windows)]
        let api_key_decrypted = dpapi::decrypt(&raw_key).unwrap_or(raw_key.clone());
        #[cfg(not(windows))]
        let api_key_decrypted = raw_key;

        (
            provider.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            api_key_decrypted,
            provider.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            provider.get("protocol").and_then(|v| v.as_str()).unwrap_or("openai").to_string(),
            provider.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.3),
            mt,
            ts,
            tpl_body,
            format!("{} [{}]", tpl_name, tpl_scope),
        )
    };

    eprintln!("[lookup_word] selection={selection:?}, kind={kind:?}, model={model:?}, protocol={protocol:?}, timeout={timeout_secs}s, tpl_len={}", template_body.len());

    let normalized = selection.trim().to_lowercase();
    let tpl_hash = {
        let mut h = Sha256::new();
        h.update(template_body.as_bytes());
        let bytes = h.finalize();
        format!("{:02x}{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2], bytes[3])
    };
    let cache_key = {
        let raw = format!("{}|{}|{}|{}", normalized, kind, model, tpl_hash);
        let mut h = Sha256::new();
        h.update(raw.as_bytes());
        format!("{:x}", h.finalize())
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(mut cached) = db.get_cache(&cache_key)? {
            eprintln!("[lookup_word] cache HIT");
            if let Some(obj) = cached.as_object_mut() {
                obj.insert("fromCache".to_string(), serde_json::Value::Bool(true));
            }
            return Ok(cached);
        }
    }
    eprintln!("[lookup_word] cache miss, calling LLM...");

    let full_text = llm::stream_lookup(
        &base_url, &api_key, &model, &protocol,
        temperature, max_tokens, timeout_secs,
        &selection, &context, &kind, &template_body,
    ).await.map_err(|e| {
        eprintln!("[lookup_word] LLM ERROR: {e}");
        e
    })?;

    eprintln!("[lookup_word] LLM OK, len={}", full_text.len());

    let mut entry = llm::parse_entry(&full_text, &selection, &kind).map_err(|e| {
        eprintln!("[lookup_word] parse FAIL: {e}");
        format!("JSON 解析失败: {e}")
    })?;

    if let Some(obj) = entry.as_object_mut() {
        obj.insert("_templateName".to_string(), serde_json::Value::String(template_name.clone()));
    }

    let db_path = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.path().to_string()
    };
    if let Ok(db) = db::Database::open(&db_path) {
        let _ = db.set_cache(&cache_key, &model, &entry);
    }

    eprintln!("[lookup_word] done, returning entry");
    Ok(entry)
}

#[tauri::command]
async fn lookup_word_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    kind: String,
    request_id: String,
) -> Result<(), String> {
    let (base_url, api_key, model, protocol, temperature, max_tokens, timeout_secs, template_body, template_name) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        let provider = settings
            .get("provider")
            .ok_or("No provider configured")?
            .clone();
        let templates = db.get_templates()?;
        let scope = match kind.as_str() {
            "paragraph" => "paragraph",
            "sentence" => "sentence",
            _ => "word",
        };
        let matched = templates
            .iter()
            .find(|t| t.get("scope").and_then(|v| v.as_str()).unwrap_or("") == scope)
            .or_else(|| templates.iter().find(|t| t.get("scope").and_then(|v| v.as_str()).unwrap_or("") == "all"))
            .or(templates.first());
        let tpl_body = matched.map(|t| t.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string()).unwrap_or_default();
        let tpl_name = matched.map(|t| t.get("name").and_then(|v| v.as_str()).unwrap_or("未知模板").to_string()).unwrap_or_else(|| "无匹配模板".to_string());
        let tpl_scope = matched.map(|t| t.get("scope").and_then(|v| v.as_str()).unwrap_or("").to_string()).unwrap_or_default();

        let mut mt = provider.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(1200) as u32;
        let mut ts = provider.get("timeoutSeconds").and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64))).unwrap_or(60);
        if kind == "paragraph" { mt = mt.max(4000); ts = ts.max(120); }

        let raw_key = provider.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
        #[cfg(windows)]
        let api_key_decrypted = dpapi::decrypt(&raw_key).unwrap_or(raw_key.clone());
        #[cfg(not(windows))]
        let api_key_decrypted = raw_key;

        (
            provider.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            api_key_decrypted,
            provider.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            provider.get("protocol").and_then(|v| v.as_str()).unwrap_or("openai").to_string(),
            provider.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.3),
            mt, ts, tpl_body,
            format!("{} [{}]", tpl_name, tpl_scope),
        )
    };

    // Check cache
    let normalized = selection.trim().to_lowercase();
    let tpl_hash = {
        let mut h = Sha256::new();
        h.update(template_body.as_bytes());
        let bytes = h.finalize();
        format!("{:02x}{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2], bytes[3])
    };
    let cache_key = {
        let raw = format!("{}|{}|{}|{}", normalized, kind, model, tpl_hash);
        let mut h = Sha256::new();
        h.update(raw.as_bytes());
        format!("{:x}", h.finalize())
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(mut cached) = db.get_cache(&cache_key)? {
            if let Some(obj) = cached.as_object_mut() {
                obj.insert("fromCache".to_string(), serde_json::Value::Bool(true));
                obj.insert("_templateName".to_string(), serde_json::Value::String(template_name.clone()));
            }
            let _ = app.emit("lookup://done", serde_json::json!({
                "requestId": request_id,
                "entry": cached,
            }));
            return Ok(());
        }
    }

    let rid = request_id.clone();
    let app_clone = app.clone();

    let result = llm::stream_lookup_sse(
        &base_url, &api_key, &model, &protocol,
        temperature, max_tokens, timeout_secs,
        &selection, &context, &kind, &template_body,
        |delta| {
            let _ = app_clone.emit("lookup://delta", serde_json::json!({
                "requestId": rid,
                "delta": delta,
            }));
        },
    ).await;

    match result {
        Ok(full_text) => {
            match llm::parse_entry(&full_text, &selection, &kind) {
                Ok(mut entry) => {
                    if let Some(obj) = entry.as_object_mut() {
                        obj.insert("_templateName".to_string(), serde_json::Value::String(template_name));
                    }
                    // Cache
                    let db_path = {
                        let db = state.db.lock().map_err(|e| e.to_string())?;
                        db.path().to_string()
                    };
                    if let Ok(db) = db::Database::open(&db_path) {
                        let _ = db.set_cache(&cache_key, &model, &entry);
                    }
                    let _ = app.emit("lookup://done", serde_json::json!({
                        "requestId": request_id,
                        "entry": entry,
                    }));
                }
                Err(e) => {
                    let _ = app.emit("lookup://error", serde_json::json!({
                        "requestId": request_id,
                        "error": format!("JSON 解析失败: {e}"),
                    }));
                }
            }
        }
        Err(e) => {
            let _ = app.emit("lookup://error", serde_json::json!({
                "requestId": request_id,
                "error": e,
            }));
        }
    }

    Ok(())
}

#[tauri::command]
async fn test_connection(
    base_url: String,
    api_key: String,
    model: String,
    protocol: Option<String>,
) -> Result<serde_json::Value, String> {
    let proto = protocol.as_deref().unwrap_or("openai");
    llm::test_connection(&base_url, &api_key, &model, proto).await
}

#[tauri::command]
async fn speak_text(text: String, voice: String, rate: f64) -> Result<(), String> {
    tts::speak(&text, &voice, rate)
}

#[tauri::command]
async fn list_voices() -> Result<Vec<String>, String> {
    tts::list_voices()
}

#[tauri::command]
async fn export_words_data(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    format: String,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let words = if ids.is_empty() {
        db.get_all_words()?
    } else {
        db.get_words_by_ids(&ids)?
    };
    db::export_words(&words, &format)
}

#[tauri::command]
async fn get_db_stats(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let stats = db.get_stats()?;
    let db_path = db.path().to_string();
    let size_bytes = db::get_db_size(&db_path);
    let data_dir = db::get_data_dir(&db_path);
    let mut result = stats;
    if let Some(obj) = result.as_object_mut() {
        obj.insert("sizeBytes".to_string(), serde_json::json!(size_bytes));
        obj.insert("dataDir".to_string(), serde_json::json!(data_dir));
    }
    Ok(result)
}

#[tauri::command]
async fn backup_database(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let db_path = db.path().to_string();
    drop(db);
    db::backup_database(&db_path)
}

#[tauri::command]
async fn list_backups(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let db_path = db.path().to_string();
    drop(db);
    db::list_backups(&db_path)
}

#[tauri::command]
async fn restore_backup(
    state: tauri::State<'_, AppState>,
    backup_name: String,
) -> Result<(), String> {
    let db_path = {
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        let path = db.path().to_string();
        *db = db::Database::open_memory().map_err(|e| format!("创建临时数据库失败: {e}"))?;
        path
    };
    db::restore_backup(&db_path, &backup_name)?;
    let new_db = db::Database::open(&db_path).map_err(|e| format!("重新打开数据库失败: {e}"))?;
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    *db = new_db;
    Ok(())
}

#[tauri::command]
async fn change_data_dir(
    state: tauri::State<'_, AppState>,
    new_dir: String,
) -> Result<String, String> {
    let old_path = {
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        let path = db.path().to_string();
        *db = db::Database::open_memory().map_err(|e| format!("创建临时数据库失败: {e}"))?;
        path
    };
    match db::change_data_dir(&old_path, &new_dir) {
        Ok(new_db_path) => {
            let new_db = db::Database::open(&new_db_path)
                .map_err(|e| format!("打开新数据库失败: {e}"))?;
            let mut db = state.db.lock().map_err(|e| e.to_string())?;
            *db = new_db;
            Ok(new_db_path)
        }
        Err(e) => {
            let fallback = db::Database::open(&old_path)
                .map_err(|e2| format!("迁移失败且无法恢复原数据库: {e} / {e2}"))?;
            let mut db = state.db.lock().map_err(|e| e.to_string())?;
            *db = fallback;
            Err(e)
        }
    }
}

#[tauri::command]
async fn open_data_folder(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let data_dir = db::get_data_dir(db.path());
    drop(db);
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&data_dir)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn get_last_capture(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let capture = state.last_capture.lock().map_err(|e| e.to_string())?;
    let val = capture.clone().unwrap_or(serde_json::Value::Null);
    if val.is_null() {
        eprintln!("[get_last_capture] returned NULL");
    } else {
        let sel = val.get("selection").and_then(|v| v.as_str()).unwrap_or("?");
        eprintln!("[get_last_capture] returned selection={sel:?}");
    }
    Ok(val)
}

#[tauri::command]
async fn pick_folder(title: Option<String>) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_title(title.as_deref().unwrap_or("选择数据目录"));
    let result = dialog.pick_folder().await;
    Ok(result.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn save_file_dialog(
    default_name: String,
    content: String,
    filter_name: Option<String>,
    filter_ext: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("导出文件")
        .set_file_name(&default_name);
    if let (Some(name), Some(exts)) = (&filter_name, &filter_ext) {
        let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name, &ext_refs);
    }
    let result = dialog.save_file().await;
    match result {
        Some(handle) => {
            let path = handle.path().to_string_lossy().to_string();
            std::fs::write(&path, content.as_bytes())
                .map_err(|e| format!("写入文件失败: {e}"))?;
            Ok(Some(path))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn toggle_clipboard_watch(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let prev = state.clipboard_enabled.load(Ordering::Relaxed);
    let next = !prev;
    state.clipboard_enabled.store(next, Ordering::Relaxed);
    Ok(next)
}

#[tauri::command]
async fn get_clipboard_watch_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.clipboard_enabled.load(Ordering::Relaxed))
}

fn setup_tray(app: &tauri::App, clipboard_enabled: Arc<AtomicBool>) -> Result<(), Box<dyn std::error::Error>> {
    let watch_item = CheckMenuItem::with_id(app, "watch", "划词即查", true, true, None::<&str>)?;
    let pause30_item = MenuItem::with_id(app, "pause30", "暂停 30 分钟", true, None::<&str>)?;
    let lookup_item = MenuItem::with_id(app, "lookup_clip", "查词（读取剪贴板）", true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出鸽鸽词典", true, None::<&str>)?;
    let menu = Menu::new(app)?;
    menu.append(&watch_item)?;
    menu.append(&pause30_item)?;
    menu.append(&lookup_item)?;
    menu.append(&show_item)?;
    menu.append(&quit_item)?;

    let icon_bytes = include_bytes!("../icons/icon.png");
    let icon = Image::from_bytes(icon_bytes)?;

    let cb_flag = clipboard_enabled.clone();
    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("鸽鸽词典 — 复制英文即查词")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "watch" => {
                let prev = cb_flag.load(Ordering::Relaxed);
                let next = !prev;
                cb_flag.store(next, Ordering::Relaxed);
                if let Some(item) = app.menu().and_then(|m| m.get("watch")) {
                    let check = item.as_check_menuitem_unchecked();
                    let _ = check.set_checked(next);
                }
            }
            "pause30" => {
                cb_flag.store(false, Ordering::Relaxed);
                if let Some(item) = app.menu().and_then(|m| m.get("watch")) {
                    let check = item.as_check_menuitem_unchecked();
                    let _ = check.set_checked(false);
                }
                let flag = cb_flag.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(30 * 60));
                    flag.store(true, Ordering::Relaxed);
                });
            }
            "lookup_clip" => {
                let state = app.state::<AppState>();
                clipboard_watcher::lookup_clipboard(app, &state.last_capture);
            }
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub fn run() {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("GegeDic");

    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let db_path = db::resolve_db_path(&data_dir);
    let database = db::Database::open(db_path.to_str().unwrap())
        .expect("Failed to open database");
    database.initialize().expect("Failed to initialize database");

    match database.cleanup_cache() {
        Ok(n) if n > 0 => eprintln!("[startup] Cleaned {n} expired/excess cache entries"),
        Err(e) => eprintln!("[startup] Cache cleanup error: {e}"),
        _ => {}
    }

    let clipboard_enabled = Arc::new(AtomicBool::new(true));

    tauri::Builder::default()
        .manage(AppState {
            db: Mutex::new(database),
            last_capture: Mutex::new(None),
            clipboard_enabled: clipboard_enabled.clone(),
            last_looked_up: Mutex::new(String::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_all_words,
            search_words,
            save_word,
            update_word,
            delete_words,
            get_all_tags,
            get_settings,
            save_settings,
            get_templates,
            save_template,
            get_usage,
            increment_usage,
            lookup_word,
            lookup_word_stream,
            test_connection,
            speak_text,
            list_voices,
            export_words_data,
            get_db_stats,
            backup_database,
            list_backups,
            restore_backup,
            change_data_dir,
            open_data_folder,
            pick_folder,
            save_file_dialog,
            get_last_capture,
            toggle_clipboard_watch,
            get_clipboard_watch_status,
        ])
        .setup(move |app| {
            let cb = clipboard_enabled.clone();
            setup_tray(app, cb.clone())?;
            clipboard_watcher::start(app.app_handle().clone(), cb);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Error while running GegeDic");
}
