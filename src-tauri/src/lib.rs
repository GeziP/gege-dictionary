mod clipboard_watcher;
mod content_filter;
mod db;
#[cfg(windows)]
mod dpapi;
mod glossary;
mod llm;
mod migrations;
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

fn normalize_selection(selection: &str, kind: &str) -> String {
    let collapsed = selection.split_whitespace().collect::<Vec<_>>().join(" ");
    if kind == "word" {
        collapsed.to_lowercase()
    } else {
        collapsed
    }
}

fn cache_ttl_days(settings: &serde_json::Value) -> i64 {
    settings
        .get("cacheTtlDays")
        .and_then(|v| v.as_i64())
        .filter(|days| matches!(*days, 0 | 7 | 30 | 90))
        .unwrap_or(30)
}

fn lookup_cache_key(
    selection: &str,
    context: &str,
    kind: &str,
    model: &str,
    enriched_template: &str,
) -> String {
    let normalized = normalize_selection(selection, kind);
    let normalized_context = context.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut template_hasher = Sha256::new();
    template_hasher.update(enriched_template.as_bytes());
    let template_hash = template_hasher.finalize();
    let raw = format!(
        "{}|{}|{}|{}|{:x}",
        normalized, normalized_context, kind, model, template_hash
    );
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(windows)]
fn migrate_api_key_storage(database: &db::Database) -> Result<(), String> {
    let mut settings = database.get_settings()?;
    let Some(provider) = settings.get_mut("provider").and_then(|p| p.as_object_mut()) else {
        return Ok(());
    };
    let key = provider
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if key.is_empty() {
        return Ok(());
    }

    if dpapi::is_encrypted(&key) {
        if let Err(e) = dpapi::decrypt(&key) {
            provider.insert("apiKey".into(), serde_json::Value::String(String::new()));
            settings.as_object_mut().map(|root| {
                root.insert(
                    "apiKeyError".into(),
                    serde_json::Value::String(
                        "API Key 无法在当前 Windows 用户下解密，请重新配置".into(),
                    ),
                )
            });
            database.save_settings(&settings)?;
            eprintln!("[startup] DPAPI decrypt failed; encrypted key was cleared: {e}");
        }
        return Ok(());
    }

    let encrypted = match dpapi::encrypt(&key) {
        Ok(encrypted) if dpapi::decrypt(&encrypted).ok().as_deref() == Some(key.as_str()) => {
            encrypted
        }
        Ok(_) => {
            provider.insert("apiKey".into(), serde_json::Value::String(String::new()));
            settings.as_object_mut().map(|root| {
                root.insert(
                    "apiKeyError".into(),
                    serde_json::Value::String("API Key 加密校验失败，请重新配置".into()),
                )
            });
            database.save_settings(&settings)?;
            return Err("API Key 自动加密校验失败，明文 Key 已清除".into());
        }
        Err(e) => {
            provider.insert("apiKey".into(), serde_json::Value::String(String::new()));
            settings.as_object_mut().map(|root| {
                root.insert(
                    "apiKeyError".into(),
                    serde_json::Value::String("API Key 加密失败，请重新配置".into()),
                )
            });
            database.save_settings(&settings)?;
            return Err(format!("API Key 自动加密失败，明文 Key 已清除: {e}"));
        }
    };
    provider.insert("apiKey".into(), serde_json::Value::String(encrypted));
    if let Some(root) = settings.as_object_mut() {
        root.remove("apiKeyError");
    }
    database.save_settings(&settings)?;
    eprintln!("[startup] Migrated plaintext API Key to DPAPI storage");
    Ok(())
}

#[tauri::command]
async fn get_all_words(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
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
    db.search_words(
        &query,
        tag.as_deref(),
        source.as_deref(),
        mastery.as_deref(),
    )
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
async fn delete_words(state: tauri::State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_words(&ids)
}

#[tauri::command]
async fn get_review_queue(
    state: tauri::State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_review_queue(limit)
}

#[tauri::command]
async fn submit_review(
    state: tauri::State<'_, AppState>,
    word_id: String,
    correct: bool,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.submit_review(&word_id, correct)
}

#[tauri::command]
async fn get_review_stats(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_review_stats()
}

#[tauri::command]
async fn reset_review_state(
    state: tauri::State<'_, AppState>,
    word_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.reset_review_state(&word_id)
}

#[tauri::command]
async fn add_words_to_review(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<u32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.add_words_to_review(&ids)
}

#[tauri::command]
async fn get_reading_sessions(
    state: tauri::State<'_, AppState>,
    gap_minutes: u32,
    limit: u32,
    offset: u32,
) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_reading_sessions(gap_minutes, limit, offset)
}

#[tauri::command]
async fn get_session_words(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_session_words(&session_id)
}

#[tauri::command]
async fn tag_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    tags: Vec<String>,
) -> Result<u32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.tag_session(&session_id, &tags)
}

#[tauri::command]
async fn add_session_to_review(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<u32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.add_session_to_review(&session_id)
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
        if let Some(key_val) = provider
            .get("apiKey")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        {
            if dpapi::is_encrypted(&key_val) {
                match dpapi::decrypt(&key_val) {
                    Ok(plain) => {
                        provider.insert("apiKey".to_string(), serde_json::Value::String(plain));
                    }
                    Err(e) => {
                        eprintln!("[get_settings] DPAPI decrypt failed: {e}, clearing key");
                        provider.insert(
                            "apiKey".to_string(),
                            serde_json::Value::String(String::new()),
                        );
                    }
                }
            }
        }
    }

    Ok(settings)
}

#[cfg(windows)]
fn secure_api_key_for_storage(incoming: &str, stored: &str) -> Result<String, String> {
    if incoming.is_empty() || dpapi::is_encrypted(incoming) {
        return Ok(incoming.to_string());
    }
    if dpapi::is_encrypted(stored) && dpapi::decrypt(stored).ok().as_deref() == Some(incoming) {
        return Ok(stored.to_string());
    }
    let encrypted = dpapi::encrypt(incoming)
        .map_err(|error| format!("API Key 加密失败，设置未保存: {error}"))?;
    let decrypted = dpapi::decrypt(&encrypted)
        .map_err(|error| format!("API Key 加密校验失败，设置未保存: {error}"))?;
    if decrypted != incoming {
        return Err("API Key 加密校验失败，设置未保存".into());
    }
    Ok(encrypted)
}

#[tauri::command]
async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let mut settings = settings;

    if let Some(domain) = settings
        .get("activeDomainProfile")
        .and_then(|value| value.as_str())
    {
        if !glossary::DOMAINS.contains(&domain) {
            return Err(format!("未知领域 Profile：{domain}"));
        }
    }
    if let Some(style) = settings
        .get("analysisStyle")
        .and_then(|value| value.as_str())
    {
        if !glossary::STYLES.contains(&style) {
            return Err(format!("未知解析风格：{style}"));
        }
    }

    // Reuse the existing ciphertext when the plaintext key did not change.
    // This avoids invoking DPAPI for unrelated settings edits and remains safe
    // when Windows is locked or the credential service is temporarily busy.
    #[cfg(windows)]
    let stored_key = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_settings()?
            .get("provider")
            .and_then(|provider| provider.get("apiKey"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    };

    #[cfg(windows)]
    if let Some(provider) = settings.get_mut("provider").and_then(|p| p.as_object_mut()) {
        if let Some(key_val) = provider
            .get("apiKey")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        {
            eprintln!(
                "[save_settings] apiKey len={}, already_encrypted={}",
                key_val.len(),
                dpapi::is_encrypted(&key_val)
            );
            let secured = secure_api_key_for_storage(&key_val, &stored_key)?;
            provider.insert("apiKey".to_string(), serde_json::Value::String(secured));
        }
    }

    if let Some(root) = settings.as_object_mut() {
        root.remove("apiKeyError");
    }

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_settings(&settings)
}

#[tauri::command]
async fn save_analysis_preferences(
    state: tauri::State<'_, AppState>,
    domain: String,
    style: String,
) -> Result<(), String> {
    if !glossary::DOMAINS.contains(&domain.as_str()) {
        return Err(format!("未知领域 Profile：{domain}"));
    }
    if !glossary::STYLES.contains(&style.as_str()) {
        return Err(format!("未知解析风格：{style}"));
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut settings = db.get_settings()?;
    let root = settings.as_object_mut().ok_or("设置格式无效")?;
    root.insert(
        "activeDomainProfile".into(),
        serde_json::Value::String(domain),
    );
    root.insert("analysisStyle".into(), serde_json::Value::String(style));
    db.save_settings(&settings)
}

#[tauri::command]
async fn get_templates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
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
async fn list_glossary_terms(
    state: tauri::State<'_, AppState>,
    query: Option<String>,
    domain: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_glossary_terms(
        query.as_deref(),
        domain.as_deref(),
        limit.unwrap_or(20),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
async fn save_glossary_term(
    state: tauri::State<'_, AppState>,
    term: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_glossary_term(&term)
}

#[tauri::command]
async fn delete_glossary_terms(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<u32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_glossary_terms(&ids)
}

#[tauri::command]
async fn import_glossary(
    state: tauri::State<'_, AppState>,
    content: String,
    format: String,
    conflict_policy: String,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.import_glossary(&content, &format, &conflict_policy)
}

#[tauri::command]
async fn export_glossary(
    state: tauri::State<'_, AppState>,
    format: String,
    domain: Option<String>,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.export_glossary(&format, domain.as_deref())
}

#[tauri::command]
async fn preview_glossary_matches(
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    domain: String,
) -> Result<Vec<glossary::GlossaryTerm>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.find_glossary_matches(&selection, &context, &domain)
}

#[tauri::command]
async fn get_usage(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_usage()
}

#[tauri::command]
async fn increment_usage(state: tauri::State<'_, AppState>, tokens: u32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.increment_usage(tokens)
}

#[tauri::command]
async fn lookup_word(
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    kind: String,
    force_refresh: bool,
) -> Result<serde_json::Value, String> {
    let (
        base_url,
        api_key,
        model,
        protocol,
        temperature,
        max_tokens,
        timeout_secs,
        template_body,
        template_name,
        cache_ttl,
    ) = {
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
            .or_else(|| {
                templates.iter().find(|t| {
                    let s = t.get("scope").and_then(|v| v.as_str()).unwrap_or("");
                    s == "all"
                })
            })
            .or(templates.first());
        let tpl_body = matched
            .map(|t| {
                t.get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default();
        let tpl_name = matched
            .map(|t| {
                t.get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知模板")
                    .to_string()
            })
            .unwrap_or_else(|| "无匹配模板".to_string());
        let tpl_scope = matched
            .map(|t| {
                t.get("scope")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default();
        let domain = settings
            .get("activeDomainProfile")
            .and_then(|value| value.as_str())
            .filter(|value| glossary::DOMAINS.contains(value))
            .unwrap_or("general");
        let style = settings
            .get("analysisStyle")
            .and_then(|value| value.as_str())
            .filter(|value| glossary::STYLES.contains(value))
            .unwrap_or("standard");
        let glossary_matches = db.find_glossary_matches(&selection, &context, domain)?;
        if !glossary_matches.is_empty() {
            eprintln!(
                "[lookup_word] glossary_term_applied count={}, domain={domain}",
                glossary_matches.len()
            );
        }
        let tpl_body = glossary::enrich_template(&tpl_body, domain, style, &glossary_matches);

        let base_url_value = provider
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut mt = provider
            .get("maxTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(1200) as u32;
        let mut ts = provider
            .get("timeoutSeconds")
            .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
            .unwrap_or(60);
        if kind == "paragraph" {
            mt = mt.max(4000);
            ts = ts.max(120);
        }
        if base_url_value.to_ascii_lowercase().contains("deepseek.com") {
            mt = mt.max(3000);
        }

        let raw_key = provider
            .get("apiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        eprintln!(
            "[lookup_word] raw_key starts_with dpapi={}, len={}",
            raw_key.starts_with("dpapi:"),
            raw_key.len()
        );
        #[cfg(windows)]
        let api_key_decrypted = match dpapi::decrypt(&raw_key) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("[lookup_word] DPAPI decrypt FAILED: {e}");
                raw_key.clone()
            }
        };
        #[cfg(not(windows))]
        let api_key_decrypted = raw_key;

        (
            base_url_value,
            api_key_decrypted,
            provider
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            provider
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("openai")
                .to_string(),
            provider
                .get("temperature")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.3),
            mt,
            ts,
            tpl_body,
            format!("{} [{}]", tpl_name, tpl_scope),
            cache_ttl_days(&settings),
        )
    };

    if api_key.starts_with("dpapi:") {
        return Err("API Key 解密失败，请到设置页重新输入".to_string());
    }
    eprintln!("[lookup_word] selection={selection:?}, kind={kind:?}, model={model:?}, protocol={protocol:?}, timeout={timeout_secs}s, tpl_len={}", template_body.len());

    let cache_key = lookup_cache_key(&selection, &context, &kind, &model, &template_body);
    if !force_refresh {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(mut cached) = db.get_cache(&cache_key, cache_ttl)? {
            eprintln!("[lookup_word] cache HIT");
            if let Some(obj) = cached.as_object_mut() {
                obj.insert("fromCache".to_string(), serde_json::Value::Bool(true));
            }
            return Ok(cached);
        }
    }
    eprintln!("[lookup_word] cache miss, calling LLM...");

    let full_text = llm::stream_lookup(
        &base_url,
        &api_key,
        &model,
        &protocol,
        temperature,
        max_tokens,
        timeout_secs,
        &selection,
        &context,
        &kind,
        &template_body,
    )
    .await
    .map_err(|e| {
        eprintln!("[lookup_word] LLM ERROR: {e}");
        e
    })?;

    eprintln!("[lookup_word] LLM OK, len={}", full_text.len());

    let mut entry = llm::parse_entry(&full_text, &selection, &kind).map_err(|e| {
        eprintln!("[lookup_word] parse FAIL: {e}");
        format!("JSON 解析失败: {e}")
    })?;

    if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "_templateName".to_string(),
            serde_json::Value::String(template_name.clone()),
        );
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
    force_refresh: bool,
) -> Result<(), String> {
    let (
        base_url,
        api_key,
        model,
        protocol,
        temperature,
        max_tokens,
        timeout_secs,
        template_body,
        template_name,
        cache_ttl,
    ) = {
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
            .or_else(|| {
                templates
                    .iter()
                    .find(|t| t.get("scope").and_then(|v| v.as_str()).unwrap_or("") == "all")
            })
            .or(templates.first());
        let tpl_body = matched
            .map(|t| {
                t.get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default();
        let tpl_name = matched
            .map(|t| {
                t.get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知模板")
                    .to_string()
            })
            .unwrap_or_else(|| "无匹配模板".to_string());
        let tpl_scope = matched
            .map(|t| {
                t.get("scope")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default();
        let domain = settings
            .get("activeDomainProfile")
            .and_then(|value| value.as_str())
            .filter(|value| glossary::DOMAINS.contains(value))
            .unwrap_or("general");
        let style = settings
            .get("analysisStyle")
            .and_then(|value| value.as_str())
            .filter(|value| glossary::STYLES.contains(value))
            .unwrap_or("standard");
        let glossary_matches = db.find_glossary_matches(&selection, &context, domain)?;
        if !glossary_matches.is_empty() {
            eprintln!(
                "[lookup_stream] glossary_term_applied count={}, domain={domain}",
                glossary_matches.len()
            );
        }
        let tpl_body = glossary::enrich_template(&tpl_body, domain, style, &glossary_matches);

        let base_url_value = provider
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut mt = provider
            .get("maxTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(1200) as u32;
        let mut ts = provider
            .get("timeoutSeconds")
            .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
            .unwrap_or(60);
        if kind == "paragraph" {
            mt = mt.max(4000);
            ts = ts.max(120);
        }
        if base_url_value.to_ascii_lowercase().contains("deepseek.com") {
            mt = mt.max(3000);
        }

        let raw_key = provider
            .get("apiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        eprintln!(
            "[lookup_stream] raw_key starts_with dpapi={}, len={}",
            raw_key.starts_with("dpapi:"),
            raw_key.len()
        );
        #[cfg(windows)]
        let api_key_decrypted = match dpapi::decrypt(&raw_key) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("[lookup_stream] DPAPI decrypt FAILED: {e}");
                raw_key.clone()
            }
        };
        #[cfg(not(windows))]
        let api_key_decrypted = raw_key;

        (
            base_url_value,
            api_key_decrypted,
            provider
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            provider
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("openai")
                .to_string(),
            provider
                .get("temperature")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.3),
            mt,
            ts,
            tpl_body,
            format!("{} [{}]", tpl_name, tpl_scope),
            cache_ttl_days(&settings),
        )
    };

    if api_key.starts_with("dpapi:") {
        return Err("API Key 解密失败，请到设置页重新输入".to_string());
    }

    // Check cache
    let cache_key = lookup_cache_key(&selection, &context, &kind, &model, &template_body);
    if !force_refresh {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(mut cached) = db.get_cache(&cache_key, cache_ttl)? {
            if let Some(obj) = cached.as_object_mut() {
                obj.insert("fromCache".to_string(), serde_json::Value::Bool(true));
                obj.insert(
                    "_templateName".to_string(),
                    serde_json::Value::String(template_name.clone()),
                );
            }
            let _ = app.emit(
                "lookup://done",
                serde_json::json!({
                    "requestId": request_id,
                    "entry": cached,
                    "fromCache": true,
                }),
            );
            return Ok(());
        }
    }

    eprintln!(
        "[lookup_stream] starting SSE, key_len={}, url={base_url}",
        api_key.len()
    );

    let rid = request_id.clone();
    let app_clone = app.clone();
    let mut extractor = llm::IncrementalJsonExtractor::new();

    let result = llm::stream_lookup_sse(
        &base_url,
        &api_key,
        &model,
        &protocol,
        temperature,
        max_tokens,
        timeout_secs,
        &selection,
        &context,
        &kind,
        &template_body,
        |delta| {
            for (field, value) in extractor.push(delta) {
                let _ = app_clone.emit(
                    "lookup://delta",
                    serde_json::json!({
                        "requestId": rid,
                        "field": field,
                        "value": value,
                    }),
                );
            }
        },
    )
    .await;

    match result {
        Ok(full_text) => match llm::parse_entry(&full_text, &selection, &kind) {
            Ok(mut entry) => {
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert(
                        "_templateName".to_string(),
                        serde_json::Value::String(template_name),
                    );
                }
                let db_path = {
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    db.path().to_string()
                };
                if let Ok(db) = db::Database::open(&db_path) {
                    let _ = db.set_cache(&cache_key, &model, &entry);
                }
                let _ = app.emit(
                    "lookup://done",
                    serde_json::json!({
                        "requestId": request_id,
                        "entry": entry,
                        "raw": full_text,
                        "fromCache": false,
                    }),
                );
                Ok(())
            }
            Err(e) => {
                let err_msg = format!("JSON 解析失败: {e}");
                let _ = app.emit(
                    "lookup://error",
                    serde_json::json!({
                        "requestId": request_id,
                        "stage": "parse",
                        "message": err_msg,
                        "retryable": true,
                    }),
                );
                Err(err_msg)
            }
        },
        Err(e) => {
            eprintln!("[lookup_stream] SSE failed: {e}");
            let _ = app.emit(
                "lookup://error",
                serde_json::json!({
                    "requestId": request_id,
                    "stage": "stream",
                    "message": e,
                    "retryable": true,
                }),
            );
            Err(e)
        }
    }
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
async fn clear_cache(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_cache()
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
            let activate = (|| -> Result<db::Database, String> {
                let new_db = db::Database::open(&new_db_path)
                    .map_err(|e| format!("打开新数据库失败: {e}"))?;
                let mut settings = new_db.get_settings()?;
                if let Some(root) = settings.as_object_mut() {
                    root.insert("dataDir".into(), serde_json::Value::String(new_dir.clone()));
                }
                new_db.save_settings(&settings)?;
                let default_dir = dirs::data_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("GegeDic");
                db::persist_configured_data_dir(&default_dir, std::path::Path::new(&new_dir))?;
                Ok(new_db)
            })();
            match activate {
                Ok(new_db) => {
                    let mut db = state.db.lock().map_err(|e| e.to_string())?;
                    *db = new_db;
                    Ok(new_db_path)
                }
                Err(e) => {
                    let fallback = db::Database::open(&old_path)
                        .map_err(|e2| format!("迁移启用失败且无法恢复原数据库: {e} / {e2}"))?;
                    let mut db = state.db.lock().map_err(|e| e.to_string())?;
                    *db = fallback;
                    Err(e)
                }
            }
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
    let dialog = rfd::AsyncFileDialog::new().set_title(title.as_deref().unwrap_or("选择数据目录"));
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
            std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
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

#[tauri::command]
async fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("复制失败: {e}"))
}

fn setup_tray(
    app: &tauri::App,
    clipboard_enabled: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error>> {
    let watch_item = CheckMenuItem::with_id(
        app,
        "watch",
        "划词即查",
        true,
        clipboard_enabled.load(Ordering::Relaxed),
        None::<&str>,
    )?;
    let pause30_item = MenuItem::with_id(app, "pause30", "暂停 30 分钟", true, None::<&str>)?;
    let lookup_item =
        MenuItem::with_id(app, "lookup_clip", "查词（读取剪贴板）", true, None::<&str>)?;
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
                let state = app.state::<AppState>();
                if let Ok(db) = state.db.lock() {
                    if let Ok(mut settings) = db.get_settings() {
                        if let Some(root) = settings.as_object_mut() {
                            root.insert("clipboardWatch".into(), serde_json::Value::Bool(next));
                        }
                        let _ = db.save_settings(&settings);
                    }
                };
            }
            "pause30" => {
                cb_flag.store(false, Ordering::Relaxed);
                if let Some(item) = app.menu().and_then(|m| m.get("watch")) {
                    let check = item.as_check_menuitem_unchecked();
                    let _ = check.set_checked(false);
                }
                let flag = cb_flag.clone();
                let app_handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(30 * 60));
                    flag.store(true, Ordering::Relaxed);
                    if let Some(item) = app_handle.menu().and_then(|m| m.get("watch")) {
                        let check = item.as_check_menuitem_unchecked();
                        let _ = check.set_checked(true);
                    }
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
    let default_data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("GegeDic");

    std::fs::create_dir_all(&default_data_dir).expect("Failed to create data directory");
    let data_dir = db::resolve_configured_data_dir(&default_data_dir);
    std::fs::create_dir_all(&data_dir).expect("Failed to create configured data directory");

    let db_path = db::resolve_db_path(&data_dir);
    let database = db::Database::open(db_path.to_str().unwrap()).expect("Failed to open database");
    database
        .initialize()
        .expect("Failed to initialize database");

    #[cfg(windows)]
    if let Err(e) = migrate_api_key_storage(&database) {
        eprintln!("[startup] API Key storage migration failed: {e}");
    }

    let ttl_days = database
        .get_settings()
        .map(|settings| cache_ttl_days(&settings))
        .unwrap_or(30);
    match database.cleanup_cache(ttl_days) {
        Ok(n) if n > 0 => eprintln!("[startup] Cleaned {n} expired/excess cache entries"),
        Err(e) => eprintln!("[startup] Cache cleanup error: {e}"),
        _ => {}
    }

    let clipboard_watch_enabled = database
        .get_settings()
        .ok()
        .and_then(|settings| settings.get("clipboardWatch").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    let clipboard_enabled = Arc::new(AtomicBool::new(clipboard_watch_enabled));

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            get_review_queue,
            submit_review,
            get_review_stats,
            reset_review_state,
            add_words_to_review,
            get_reading_sessions,
            get_session_words,
            tag_session,
            add_session_to_review,
            get_all_tags,
            get_settings,
            save_settings,
            save_analysis_preferences,
            get_templates,
            save_template,
            list_glossary_terms,
            save_glossary_term,
            delete_glossary_terms,
            import_glossary,
            export_glossary,
            preview_glossary_matches,
            get_usage,
            increment_usage,
            lookup_word,
            lookup_word_stream,
            test_connection,
            speak_text,
            list_voices,
            export_words_data,
            get_db_stats,
            clear_cache,
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
            copy_text,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_normalization_preserves_sentence_case() {
        assert_eq!(
            normalize_selection("  Hello\n  World  ", "word"),
            "hello world"
        );
        assert_eq!(
            normalize_selection("  Hello\n  World  ", "sentence"),
            "Hello World"
        );
    }

    #[test]
    fn cache_key_tracks_context_and_enrichment() {
        let base = lookup_cache_key("deadlock", "thread A", "word", "model", "standard");
        assert_ne!(
            base,
            lookup_cache_key("deadlock", "thread B", "word", "model", "standard")
        );
        assert_ne!(
            base,
            lookup_cache_key("deadlock", "thread A", "word", "model", "deep+glossary")
        );
        assert_eq!(
            base,
            lookup_cache_key(" DEADLOCK ", "thread   A", "word", "model", "standard")
        );
    }

    #[cfg(windows)]
    #[test]
    fn unchanged_api_key_reuses_existing_ciphertext() {
        let ciphertext = dpapi::encrypt("sk-stable-key").unwrap();
        assert_eq!(
            secure_api_key_for_storage("sk-stable-key", &ciphertext).unwrap(),
            ciphertext
        );
        assert_eq!(secure_api_key_for_storage("", &ciphertext).unwrap(), "");
    }

    #[cfg(windows)]
    #[test]
    fn plaintext_api_key_is_migrated_to_dpapi() {
        let database = db::Database::open_memory().unwrap();
        database.initialize().unwrap();
        let mut settings = database.get_settings().unwrap();
        settings["provider"]["apiKey"] = serde_json::Value::String("sk-test-migration".into());
        database.save_settings(&settings).unwrap();

        migrate_api_key_storage(&database).unwrap();
        let stored = database.get_settings().unwrap();
        let encrypted = stored["provider"]["apiKey"].as_str().unwrap();
        assert!(dpapi::is_encrypted(encrypted));
        assert_eq!(dpapi::decrypt(encrypted).unwrap(), "sk-test-migration");
    }

    #[cfg(windows)]
    #[test]
    fn invalid_dpapi_key_is_cleared_without_crashing() {
        let database = db::Database::open_memory().unwrap();
        database.initialize().unwrap();
        let mut settings = database.get_settings().unwrap();
        settings["provider"]["apiKey"] = serde_json::Value::String("dpapi:v1:not-base64!".into());
        database.save_settings(&settings).unwrap();

        migrate_api_key_storage(&database).unwrap();
        let stored = database.get_settings().unwrap();
        assert_eq!(stored["provider"]["apiKey"], "");
        assert!(stored["apiKeyError"].as_str().is_some());
    }
}
