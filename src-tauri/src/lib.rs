mod anki;
mod clipboard_watcher;
mod content_filter;
mod db;
#[cfg(windows)]
mod dpapi;
mod enrich;
mod glossary;
mod insights;
mod llm;
mod lookup;
mod migrations;
mod ocr;
mod review;
mod tts;
mod watch_switch;
mod word_import;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// Puts the position of the "划词即查" switch (`true` is on) on the tray menu's check mark.
type WatchMarker = Arc<dyn Fn(bool) + Send + Sync>;

pub(crate) struct AppState {
    pub db: Mutex<db::Database>,
    pub last_capture: Mutex<Option<serde_json::Value>>,
    /// "划词即查" on or off, and the pause that can be running on it.
    pub watch: watch_switch::WatchSwitch,
    /// Set once the tray exists. It is a closure, not the menu item itself: the item carries
    /// the whole Tauri runtime with it, which would make every test binary load the system
    /// dialogs (and fail to start without the manifest an installed app has).
    pub show_watch_mark: Mutex<Option<WatchMarker>>,
    pub last_looked_up: Mutex<Option<clipboard_watcher::ClipboardFingerprint>>,
    pub startup_warnings: Mutex<Vec<db::StartupWarning>>,
}

impl AppState {
    /// Makes the tray menu's check mark say where the "划词即查" switch is. Clicking the item
    /// flips the mark by itself, but nothing else does (a pause, the settings page), and
    /// `AppHandle::menu` is the app-wide menu, not the tray's.
    pub(crate) fn show_watch_state(&self) {
        // Cloned out of the lock first: setting the mark waits for the UI thread, which may
        // itself be waiting for this lock.
        let show = self
            .show_watch_mark
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(show) = show {
            show(self.watch.is_on());
        }
    }
}

fn default_data_dir_from(app_data: Option<PathBuf>, known_data_dir: Option<PathBuf>) -> PathBuf {
    app_data
        .or(known_data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("GegeDic")
}

fn default_data_dir() -> PathBuf {
    default_data_dir_from(
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty()),
        dirs::data_dir(),
    )
}

fn set_data_dir_setting(
    settings: &mut serde_json::Value,
    data_dir: &std::path::Path,
) -> Result<(), String> {
    let root = settings
        .as_object_mut()
        .ok_or("新数据库设置格式无效，迁移已取消")?;
    root.insert(
        "dataDir".into(),
        serde_json::Value::String(data_dir.to_string_lossy().to_string()),
    );
    Ok(())
}

pub(crate) fn normalize_selection(selection: &str, kind: &str) -> String {
    let collapsed = selection.split_whitespace().collect::<Vec<_>>().join(" ");
    if kind == "word" {
        collapsed.to_lowercase()
    } else {
        collapsed
    }
}

pub(crate) fn cache_ttl_days(settings: &serde_json::Value) -> i64 {
    settings
        .get("cacheTtlDays")
        .and_then(|v| v.as_i64())
        .filter(|days| matches!(*days, 0 | 7 | 30 | 90))
        .unwrap_or(30)
}

/// Whether answered lookups are remembered in the history: on, unless the user turned it off.
pub(crate) fn history_enabled(settings: &serde_json::Value) -> bool {
    settings
        .get("historyEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn ocr_settings(settings: &serde_json::Value) -> (bool, String) {
    let ocr = settings.get("ocr");
    let enabled = ocr
        .and_then(|o| o.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let hotkey = ocr
        .and_then(|o| o.get("hotkey"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Control+Shift+O")
        .to_string();
    (enabled, hotkey)
}

fn apply_ocr_hotkey(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let (enabled, hotkey) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        ocr_settings(&settings)
    };
    // Drop the well-known default and the configured combo so re-apply is idempotent.
    for candidate in ["Control+Shift+O", hotkey.as_str()] {
        if let Ok(sc) = candidate.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = app.global_shortcut().unregister(sc);
        }
    }
    if !enabled {
        return Ok(());
    }
    let sc = hotkey
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("无效热键「{hotkey}」: {e}"))?;
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(sc, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = open_ocr_select_window(&app_handle);
            }
        })
        .map_err(|e| format!("注册 OCR 热键失败: {e}"))
}

#[tauri::command]
async fn apply_ocr_hotkey_from_settings(app: AppHandle) -> Result<(), String> {
    apply_ocr_hotkey(&app)
}

/// Where the settings keep each of the two model services - the main one and the backup - and
/// where they note why a stored API key could not be used. Both are stored alike.
struct ProviderKey {
    /// The settings object that describes the service.
    settings_key: &'static str,
    /// The settings entry that tells the user why the stored key could not be used.
    error_key: &'static str,
    /// How the service is introduced in an error that is not shown next to its own fields.
    #[cfg_attr(not(windows), allow(dead_code))]
    label: &'static str,
}

const PROVIDER_KEYS: [ProviderKey; 2] = [
    ProviderKey {
        settings_key: "provider",
        error_key: "apiKeyError",
        label: "",
    },
    ProviderKey {
        settings_key: "backupProvider",
        error_key: "backupApiKeyError",
        label: "备用模型的 ",
    },
];

/// What migrating one stored API key did.
#[cfg(windows)]
enum KeyMigration {
    /// Nothing to do: there is no key, or it is encrypted and can be read.
    Untouched,
    /// The settings changed and are to be saved.
    Changed,
    /// The key could not be made safe, so it was cleared from the settings (which are to be
    /// saved, too). This says why.
    Failed(String),
}

/// Throw a stored key away and say why, where the settings page shows it.
#[cfg(windows)]
fn reject_stored_key(settings: &mut serde_json::Value, provider: &ProviderKey, reason: &str) {
    if let Some(entry) = settings
        .get_mut(provider.settings_key)
        .and_then(|entry| entry.as_object_mut())
    {
        entry.insert("apiKey".into(), serde_json::Value::String(String::new()));
    }
    if let Some(root) = settings.as_object_mut() {
        root.insert(
            provider.error_key.into(),
            serde_json::Value::String(reason.into()),
        );
    }
}

/// Make sure the API key of one service is stored encrypted: a plaintext key is encrypted, and
/// one that cannot be read by this Windows user is cleared, never kept.
#[cfg(windows)]
fn migrate_provider_key(settings: &mut serde_json::Value, provider: &ProviderKey) -> KeyMigration {
    let key = settings
        .get(provider.settings_key)
        .and_then(|entry| entry.get("apiKey"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if key.is_empty() {
        return KeyMigration::Untouched;
    }

    if dpapi::is_encrypted(&key) {
        return match dpapi::decrypt(&key) {
            Ok(_) => KeyMigration::Untouched,
            Err(e) => {
                reject_stored_key(
                    settings,
                    provider,
                    "API Key 无法在当前 Windows 用户下解密，请重新配置",
                );
                eprintln!(
                    "[startup] {}: DPAPI decrypt failed; encrypted key was cleared: {e}",
                    provider.settings_key
                );
                KeyMigration::Changed
            }
        };
    }

    match dpapi::encrypt(&key) {
        Ok(encrypted) if dpapi::decrypt(&encrypted).ok().as_deref() == Some(key.as_str()) => {
            if let Some(entry) = settings
                .get_mut(provider.settings_key)
                .and_then(|entry| entry.as_object_mut())
            {
                entry.insert("apiKey".into(), serde_json::Value::String(encrypted));
            }
            if let Some(root) = settings.as_object_mut() {
                root.remove(provider.error_key);
            }
            eprintln!(
                "[startup] Migrated plaintext {} API Key to DPAPI storage",
                provider.settings_key
            );
            KeyMigration::Changed
        }
        Ok(_) => {
            reject_stored_key(settings, provider, "API Key 加密校验失败，请重新配置");
            KeyMigration::Failed(format!(
                "{}API Key 自动加密校验失败，明文 Key 已清除",
                provider.label
            ))
        }
        Err(e) => {
            reject_stored_key(settings, provider, "API Key 加密失败，请重新配置");
            KeyMigration::Failed(format!(
                "{}API Key 自动加密失败，明文 Key 已清除: {e}",
                provider.label
            ))
        }
    }
}

#[cfg(windows)]
fn migrate_api_key_storage(database: &db::Database) -> Result<(), String> {
    let mut settings = database.get_settings()?;
    let mut changed = false;
    let mut failure = None;
    for provider in &PROVIDER_KEYS {
        match migrate_provider_key(&mut settings, provider) {
            KeyMigration::Untouched => {}
            KeyMigration::Changed => changed = true,
            KeyMigration::Failed(reason) => {
                changed = true;
                failure.get_or_insert(reason);
            }
        }
    }
    if changed {
        database.save_settings(&settings)?;
    }
    failure.map_or(Ok(()), Err)
}

pub(crate) fn record_event(
    state: &tauri::State<'_, AppState>,
    event: &str,
    extra: serde_json::Value,
) {
    if let Ok(db) = state.db.lock() {
        let _ = db.record_local_event(event, &extra);
    }
}

pub(crate) fn record_event_handle(app: &tauri::AppHandle, event: &str, extra: serde_json::Value) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(db) = state.db.lock() {
            let _ = db.record_local_event(event, &extra);
        }
    }
}

#[tauri::command]
async fn get_local_metrics(
    state: tauri::State<'_, AppState>,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_local_metrics(days.unwrap_or(7))
}

#[tauri::command]
async fn clear_local_metrics(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_local_metrics()
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

/// Saves the outcome of a lookup. A word that is already in the library is
/// merged with it (the user's mastery, note, tags and Anki link survive) rather
/// than overwritten, and the document as stored is returned.
#[tauri::command]
async fn save_word(
    state: tauri::State<'_, AppState>,
    word: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_lookup_result(&word)
}

/// Puts a word back exactly as given. Undo and rollback need a plain overwrite
/// to return to the state from before a merge; `save_word` would merge again.
#[tauri::command]
async fn restore_word(
    state: tauri::State<'_, AppState>,
    word: serde_json::Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_word(&word)
}

/// The saved word for a lemma (case/whitespace-insensitive), if any. Lets the
/// lookup window ask about one word instead of loading the whole library.
#[tauri::command]
async fn find_word_by_lemma(
    state: tauri::State<'_, AppState>,
    lemma: String,
    kind: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.find_word_by_lemma(&lemma, kind.as_deref())
}

/// One transactional change (mastery, tags to add/remove) for many words.
#[tauri::command]
async fn batch_update_words(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    patch: db::BatchWordPatch,
) -> Result<db::BatchUpdateReport, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.batch_update_words(&ids, &patch)
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
    // "correct", "hard" or "wrong".
    answer: String,
) -> Result<serde_json::Value, String> {
    let answer =
        review::Answer::parse(&answer).ok_or_else(|| format!("未知的复习答案：{answer}"))?;
    let outcome = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.submit_review(&word_id, answer)?
    };
    record_event(
        &state,
        "review_card_answered",
        serde_json::json!({ "result": answer.as_str() }),
    );
    Ok(outcome)
}

/// Streak, activity chart, mastery and review figures, and a few short rankings.
#[tauri::command]
async fn get_learning_insights(
    state: tauri::State<'_, AppState>,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.learning_insights(days.unwrap_or(30))
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
    let result = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_reading_sessions(gap_minutes, limit, offset)?
    };
    if offset == 0 {
        record_event(&state, "reading_session_viewed", serde_json::json!({}));
    }
    Ok(result)
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

/// Never send a stored API key to the WebView: only a placeholder where there is a key that can
/// be used, and a flag that says so. Both model services are treated alike.
#[cfg(windows)]
fn redact_api_keys(settings: &mut serde_json::Value) {
    for provider in &PROVIDER_KEYS {
        let Some(entry) = settings
            .get_mut(provider.settings_key)
            .and_then(|entry| entry.as_object_mut())
        else {
            continue;
        };
        let stored = entry
            .get("apiKey")
            .and_then(|value| value.as_str())
            .map(|key| key.to_string());
        // What the page is shown in place of the key (if the key is to be replaced at all), and
        // whether there is a key it can rely on.
        let (shown, has_key) = match stored {
            None => (None, false),
            Some(key) if dpapi::is_encrypted(&key) => match dpapi::decrypt(&key) {
                Ok(_) => (Some(lookup::API_KEY_PLACEHOLDER), true),
                Err(e) => {
                    eprintln!(
                        "[get_settings] {}: DPAPI decrypt failed: {e}, clearing key",
                        provider.settings_key
                    );
                    (Some(""), false)
                }
            },
            Some(key) => {
                let has_key = !key.is_empty();
                (has_key.then_some(lookup::API_KEY_PLACEHOLDER), has_key)
            }
        };
        if let Some(shown) = shown {
            entry.insert("apiKey".into(), serde_json::Value::String(shown.into()));
        }
        entry.insert("hasApiKey".into(), serde_json::Value::Bool(has_key));
    }
}

#[tauri::command]
async fn get_settings(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Read under the lock; decrypting (to tell whether a key can be used) is done without it.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut settings = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_settings()?
    };

    #[cfg(windows)]
    redact_api_keys(&mut settings);

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

/// Make the API keys of settings that came from the settings page ready to be stored. The page
/// only holds the placeholder for a key it was given, so the placeholder - and an empty key, which
/// never deletes one - keep the ciphertext that is stored for that service; a key that was typed
/// in is encrypted, unless it is the one that is stored already. That avoids invoking DPAPI for
/// unrelated edits, and keeps saving possible when Windows is locked or the credential service
/// is busy.
#[cfg(windows)]
fn secure_api_keys_for_storage(
    settings: &mut serde_json::Value,
    stored: &serde_json::Value,
) -> Result<(), String> {
    for provider in &PROVIDER_KEYS {
        let stored_key = stored
            .get(provider.settings_key)
            .and_then(|entry| entry.get("apiKey"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let Some(entry) = settings
            .get_mut(provider.settings_key)
            .and_then(|entry| entry.as_object_mut())
        else {
            continue;
        };
        let Some(incoming) = entry
            .get("apiKey")
            .and_then(|value| value.as_str())
            .map(|key| key.to_string())
        else {
            continue;
        };

        let secured = if lookup::is_placeholder_api_key(&incoming)
            || (incoming.is_empty() && !stored_key.is_empty())
        {
            eprintln!(
                "[save_settings] {}: placeholder/empty apiKey; keeping stored ciphertext",
                provider.settings_key
            );
            stored_key.to_string()
        } else {
            eprintln!(
                "[save_settings] {}: apiKey len={}, already_encrypted={}",
                provider.settings_key,
                incoming.len(),
                dpapi::is_encrypted(&incoming)
            );
            secure_api_key_for_storage(&incoming, stored_key)
                .map_err(|error| format!("{}{error}", provider.label))?
        };
        entry.insert("apiKey".into(), serde_json::Value::String(secured));
    }
    Ok(())
}

/// Drop what only travels to the settings page and is never stored: whether a key is stored, and
/// why one could not be used.
fn strip_key_status(settings: &mut serde_json::Value) {
    for provider in &PROVIDER_KEYS {
        if let Some(entry) = settings
            .get_mut(provider.settings_key)
            .and_then(|entry| entry.as_object_mut())
        {
            entry.remove("hasApiKey");
        }
        if let Some(root) = settings.as_object_mut() {
            root.remove(provider.error_key);
        }
    }
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

    // The stored settings are read first, and the lock is let go of before DPAPI is called:
    // it can be slow, and nothing else should wait for it.
    #[cfg(windows)]
    {
        let stored = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.get_settings()?
        };
        secure_api_keys_for_storage(&mut settings, &stored)?;
    }
    strip_key_status(&mut settings);

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
async fn preview_word_import(
    content: String,
    format: String,
) -> Result<word_import::WordImportPreview, String> {
    word_import::preview_word_import(&content, &format)
}

#[tauri::command]
async fn import_words(
    state: tauri::State<'_, AppState>,
    content: String,
    format: String,
    mapping: std::collections::HashMap<String, String>,
) -> Result<word_import::WordImportResult, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.import_words(&content, &format, &mapping)
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

/// Read `text` aloud. Resolves when playback finishes (or is superseded or
/// stopped), so the UI can reflect the real speaking state.
#[tauri::command]
async fn speak_text(text: String, voice: String, rate: f64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || tts::speak_blocking(&text, &voice, rate))
        .await
        .map_err(|e| format!("朗读任务失败: {e}"))?
}

#[tauri::command]
async fn stop_speaking() -> Result<(), String> {
    tts::stop();
    Ok(())
}

#[tauri::command]
async fn list_voices() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(tts::list_voices)
        .await
        .map_err(|e| format!("语音列表任务失败: {e}"))?
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
async fn export_database_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let default_name = format!(
        "gege-export-{}.db",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let selected = rfd::AsyncFileDialog::new()
        .set_title("导出完整数据库快照")
        .set_file_name(&default_name)
        .add_filter("SQLite 数据库", &["db"])
        .save_file()
        .await;
    let Some(file) = selected else {
        return Ok(None);
    };
    let destination = file.path().to_path_buf();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let current = std::path::Path::new(db.path())
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(db.path()));
    let requested = destination
        .canonicalize()
        .unwrap_or_else(|_| destination.clone());
    if current == requested {
        return Err("导出目标不能是当前数据库文件".into());
    }
    db.snapshot_to(&destination)?;
    Ok(Some(destination.to_string_lossy().to_string()))
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
async fn get_startup_warnings(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<db::StartupWarning>, String> {
    let warnings = state.startup_warnings.lock().map_err(|e| e.to_string())?;
    Ok(warnings.clone())
}

#[tauri::command]
async fn clear_cache(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_cache()
}

/// The lookup history, newest first.
#[tauri::command]
async fn get_lookup_history(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_history()
}

#[tauri::command]
async fn delete_lookup_history(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<u64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_history(&ids)
}

#[tauri::command]
async fn clear_lookup_history(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_history()
}

/// Open the lookup window on a history entry. It asks exactly what was asked the first time,
/// so an answer that is still cached appears at once and costs nothing.
#[tauri::command]
async fn reopen_lookup_from_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let question = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.history_lookup(id)?
    }
    .ok_or("这条历史记录已经不存在了")?;
    let kind = question
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("word")
        .to_string();
    let mut capture = question;
    if let Some(object) = capture.as_object_mut() {
        object.insert("method".into(), serde_json::json!("history"));
    }
    if let Ok(mut last) = state.last_capture.lock() {
        *last = Some(capture);
    }
    clipboard_watcher::open_or_reuse_lookup_public(&app, kind == "paragraph");
    Ok(())
}

#[tauri::command]
async fn backup_database(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::backup_database(&db)
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
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    db::restore_backup(&mut db, &backup_name)
}

#[tauri::command]
async fn change_data_dir(
    state: tauri::State<'_, AppState>,
    new_dir: String,
) -> Result<db::DataDirChangeResult, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db::change_data_dir(&db, &new_dir)?;
    let activate = (|| -> Result<db::Database, String> {
        let new_db = db::Database::open(&result.new_db_path)
            .map_err(|e| format!("打开新数据库失败: {e}"))?;
        let mut settings = new_db.get_settings()?;
        set_data_dir_setting(
            &mut settings,
            std::path::Path::new(&result.new_db_path)
                .parent()
                .unwrap_or(std::path::Path::new(&new_dir)),
        )?;
        new_db.save_settings(&settings)?;
        let default_dir = default_data_dir();
        let normalized_new_dir = std::path::Path::new(&result.new_db_path)
            .parent()
            .ok_or("无法解析新数据目录")?;
        db::persist_configured_data_dir(&default_dir, normalized_new_dir)?;
        Ok(new_db)
    })();
    match activate {
        Ok(new_db) => {
            if !result.warnings.is_empty() {
                if let Ok(mut warnings) = state.startup_warnings.lock() {
                    warnings.extend(result.warnings.iter().cloned().map(|message| {
                        db::StartupWarning {
                            kind: "migration-backup".into(),
                            message,
                        }
                    }));
                }
            }
            *db = new_db;
            Ok(result)
        }
        Err(error) => {
            db::cleanup_migration_target(&result);
            Err(error)
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
        let sel = val.get("selection").and_then(|v| v.as_str()).unwrap_or("");
        let kind = val.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        eprintln!(
            "[get_last_capture] returned {}",
            lookup::selection_meta(sel, kind)
        );
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
    let on = state.watch.toggle();
    state.show_watch_state();
    Ok(on)
}

#[tauri::command]
async fn get_clipboard_watch_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.watch.is_on())
}

#[tauri::command]
async fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("复制失败: {e}"))
}

/// Show and focus the main window (used from lookup empty-state CTA).
#[tauri::command]
async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }
    Err("主窗口不存在".into())
}

#[tauri::command]
fn get_ocr_status() -> serde_json::Value {
    ocr::get_ocr_status()
}

/// Recognize a screen region (physical pixels) and return text.
/// Caller then feeds text into the shared lookup pipeline.
#[tauri::command]
async fn ocr_recognize_region(
    state: tauri::State<'_, AppState>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    language: Option<String>,
) -> Result<serde_json::Value, String> {
    let lang = language
        .as_deref()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let text = tokio::task::spawn_blocking(move || {
        ocr::recognize_screen_region(x, y, width, height, lang.as_deref())
    })
    .await
    .map_err(|e| format!("OCR 任务失败: {e}"))??;

    if let Ok(db) = state.db.lock() {
        if text.trim().is_empty() {
            let _ =
                db.record_local_event("ocr_filtered", &serde_json::json!({ "reason": "empty" }));
        } else {
            let kind = clipboard_watcher::detect_kind_public(text.trim());
            let _ = db.record_local_event("ocr_triggered", &serde_json::json!({ "kind": kind }));
        }
    }

    let truncated = text.chars().take(ocr::max_ocr_chars()).collect::<String>();
    let was_truncated = truncated.chars().count() < text.chars().count();
    let kind = clipboard_watcher::detect_kind_public(truncated.trim());
    Ok(serde_json::json!({
        "text": truncated,
        "truncated": was_truncated,
        "length": truncated.chars().count(),
        "kind": kind,
    }))
}

fn open_ocr_select_window(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let settings = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.get_settings()?
        };
        let (enabled, _) = ocr_settings(&settings);
        if !enabled {
            return Err("截图取词已关闭，请在设置中启用".into());
        }
    }
    if let Some(win) = app.get_webview_window("ocr-select") {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let app_h = app.clone();
    app.run_on_main_thread(move || {
        let built = tauri::WebviewWindowBuilder::new(
            &app_h,
            "ocr-select",
            tauri::WebviewUrl::App("ocr-select".into()),
        )
        .title("截图取词")
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .focused(true)
        .build();
        if let Ok(win) = built {
            // Fullscreen the monitor under the cursor so multi-display capture
            // and client→physical mapping stay on the same screen.
            if let Ok(cursor) = app_h.cursor_position() {
                if let Ok(Some(monitor)) = app_h.monitor_from_point(cursor.x, cursor.y) {
                    let origin = monitor.position();
                    let size = monitor.size();
                    let _ = win.set_position(tauri::PhysicalPosition::new(origin.x, origin.y));
                    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
                }
            }
            let _ = win.set_fullscreen(true);
        }
    })
    .map_err(|e| format!("打开框选窗失败: {e}"))
}

/// Open the fullscreen region picker overlay.
#[tauri::command]
async fn start_ocr_capture(app: tauri::AppHandle) -> Result<(), String> {
    open_ocr_select_window(&app)
}

/// Store OCR text as last_capture and open/reuse the lookup window.
#[tauri::command]
async fn set_ocr_capture_and_lookup(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("空文本".into());
    }
    if content_filter::should_reject(&trimmed) {
        if let Some(reason) = content_filter::reject_reason(&trimmed) {
            if let Ok(db) = state.db.lock() {
                let _ = db.record_local_event(
                    "ocr_filtered",
                    &serde_json::json!({ "reason": reason.as_str() }),
                );
            }
            return Err(format!("内容被过滤（{}），未发送", reason.as_str()));
        }
    }
    let kind = clipboard_watcher::detect_kind_public(&trimmed);
    let source_title = {
        let title = ocr::foreground_window_title();
        if title.trim().is_empty() {
            "截图取词".to_string()
        } else {
            title
        }
    };
    let capture = serde_json::json!({
        "selection": trimmed,
        "context": "",
        "kind": kind,
        "sourceApp": "screenshot",
        "sourceTitle": source_title,
        "method": "ocr",
    });
    if let Ok(mut lc) = state.last_capture.lock() {
        *lc = Some(capture);
    }
    clipboard_watcher::open_or_reuse_lookup_public(&app, kind == "paragraph");
    Ok(())
}

#[tauri::command]
fn get_anki_config(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let settings = db.get_settings()?;
    Ok(serde_json::json!(anki::AnkiConfig::from_settings(
        &settings
    )))
}

#[tauri::command]
async fn test_anki_connection(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        anki::AnkiConfig::from_settings(&settings)
    };
    if !config.enabled {
        return Err("请先启用 Anki Connect".into());
    }
    anki::test_connection(&config).await
}

#[tauri::command]
async fn list_anki_decks(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        anki::AnkiConfig::from_settings(&settings)
    };
    if !config.enabled {
        return Err("请先启用 Anki Connect".into());
    }
    anki::list_decks(&config).await
}

#[tauri::command]
async fn list_anki_models(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        anki::AnkiConfig::from_settings(&settings)
    };
    if !config.enabled {
        return Err("请先启用 Anki Connect".into());
    }
    anki::list_models(&config).await
}

#[tauri::command]
async fn send_words_to_anki(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let (config, items) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        let config = anki::AnkiConfig::from_settings(&settings);
        // Pair every word with its *own* id. The words found need not line up
        // with `ids` (unknown ids are skipped and the library sorts by date),
        // and the note ids Anki reports are saved under whichever id sits in
        // the pair, so pairing by position wrote them onto the wrong words.
        let items = db
            .get_words_in_order(&ids)?
            .into_iter()
            .filter_map(|word| {
                let id = word.get("id")?.as_str()?.to_string();
                Some((id, word))
            })
            .collect::<Vec<(String, serde_json::Value)>>();
        (config, items)
    };
    if items.is_empty() {
        return Err("没有可发送的词条：所选词条不存在或已被删除".into());
    }
    let mut report = anki::send_words(&config, &items).await?;
    if let Ok(db) = state.db.lock() {
        // Remember which note each word became, so sending it again is
        // recognised as a duplicate. One transaction for the whole batch, and
        // a failure is reported instead of silently dropped.
        let pairs = anki_note_pairs(&report);
        if !pairs.is_empty() {
            if let Err(error) = db.set_anki_note_ids(&pairs) {
                push_report_error(
                    &mut report,
                    format!("已发送到 Anki，但未能记录笔记 ID，再次发送可能产生重复: {error}"),
                );
            }
        }
        let added = report.get("added").and_then(|v| v.as_u64()).unwrap_or(0);
        if added > 0 {
            let _ = db.record_local_event("anki_send_ok", &serde_json::json!({ "count": added }));
        }
        if let Some(errors) = report.get("errors").and_then(|v| v.as_array()) {
            if !errors.is_empty() {
                let _ = db.record_local_event(
                    "anki_send_fail",
                    &serde_json::json!({ "count": errors.len() }),
                );
            }
        }
    }
    Ok(report)
}

/// The `(wordId, noteId)` pairs of an Anki send report; entries Anki gave no
/// note id for (failures) are left out.
fn anki_note_pairs(report: &serde_json::Value) -> Vec<(String, i64)> {
    report
        .get("results")
        .and_then(|results| results.as_array())
        .map(|results| {
            results
                .iter()
                .filter_map(|item| {
                    Some((
                        item.get("wordId")?.as_str()?.to_string(),
                        item.get("noteId")?.as_i64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn push_report_error(report: &mut serde_json::Value, message: String) {
    if let Some(object) = report.as_object_mut() {
        let errors = object
            .entry("errors")
            .or_insert_with(|| serde_json::json!([]));
        if let Some(list) = errors.as_array_mut() {
            list.push(serde_json::Value::String(message));
        }
    }
}

/// How long "暂停 30 分钟" in the tray menu pauses the clipboard watcher.
const PAUSE_MINUTES: u64 = 30;

fn setup_tray(app: &tauri::App, ocr_enabled: bool) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<AppState>();
    let watch_item = CheckMenuItem::with_id(
        app,
        "watch",
        "划词即查",
        true,
        state.watch.is_on(),
        None::<&str>,
    )?;
    if let Ok(mut slot) = state.show_watch_mark.lock() {
        let mark = watch_item.clone();
        *slot = Some(Arc::new(move |on| {
            let _ = mark.set_checked(on);
        }));
    }
    let pause30_item = MenuItem::with_id(app, "pause30", "暂停 30 分钟", true, None::<&str>)?;
    let lookup_item =
        MenuItem::with_id(app, "lookup_clip", "查词（读取剪贴板）", true, None::<&str>)?;
    let ocr_item = MenuItem::with_id(
        app,
        "ocr_capture",
        "截图取词 (Ctrl+Shift+O)",
        ocr_enabled,
        None::<&str>,
    )?;
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出鸽鸽词典", true, None::<&str>)?;
    let menu = Menu::new(app)?;
    menu.append(&watch_item)?;
    menu.append(&pause30_item)?;
    menu.append(&lookup_item)?;
    if ocr_enabled {
        menu.append(&ocr_item)?;
    }
    menu.append(&show_item)?;
    menu.append(&quit_item)?;

    let icon_bytes = include_bytes!("../icons/icon.png");
    let icon = Image::from_bytes(icon_bytes)?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("鸽鸽词典 — 复制英文即查词")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "watch" => {
                let state = app.state::<AppState>();
                let on = state.watch.toggle();
                // The click has flipped the check mark already; this makes it say what the
                // switch says, which differs while a pause is running.
                state.show_watch_state();
                if let Ok(db) = state.db.lock() {
                    if let Ok(mut settings) = db.get_settings() {
                        if let Some(root) = settings.as_object_mut() {
                            root.insert("clipboardWatch".into(), serde_json::Value::Bool(on));
                        }
                        let _ = db.save_settings(&settings);
                    }
                };
            }
            "pause30" => {
                let state = app.state::<AppState>();
                // A pause is not remembered across restarts, and nothing is paused when the
                // user has turned the watcher off.
                if let Some(mark) = state.watch.pause() {
                    state.show_watch_state();
                    let app_handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(PAUSE_MINUTES * 60));
                        let state = app_handle.state::<AppState>();
                        // Only if the user has not touched the switch (or paused again) since.
                        if state.watch.end_pause(mark) {
                            state.show_watch_state();
                        }
                    });
                }
            }
            "lookup_clip" => {
                let state = app.state::<AppState>();
                clipboard_watcher::lookup_clipboard(app, &state.last_capture);
            }
            "ocr_capture" => match open_ocr_select_window(app) {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("ocr_capture: {e}");
                }
            },
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

fn push_startup_warning(app: &AppHandle, kind: impl Into<String>, message: impl Into<String>) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut warnings) = state.startup_warnings.lock() {
            warnings.push(db::StartupWarning {
                kind: kind.into(),
                message: message.into(),
            });
        }
    }
}

fn check_auto_backup(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let enabled = state
        .db
        .lock()
        .ok()
        .and_then(|database| database.get_settings().ok())
        .and_then(|settings| settings.get("autoBackup").and_then(|value| value.as_bool()))
        .unwrap_or(true);
    if !enabled {
        return;
    }
    let Ok(database) = state.db.lock() else {
        push_startup_warning(app, "auto-backup", "自动备份无法获取数据库锁");
        return;
    };
    let path = database.path().to_string();
    match db::has_auto_backup_today(&path) {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            push_startup_warning(app, "auto-backup", format!("检查自动备份失败: {error}"));
            return;
        }
    }
    if let Err(error) = db::backup_database(&database) {
        push_startup_warning(app, "auto-backup", format!("自动备份失败: {error}"));
    }
}

fn validate_relocated_database(path: &std::path::Path) -> Result<(), String> {
    if database_file_is_startup_candidate(path) {
        Ok(())
    } else {
        Err(format!(
            "数据库 {} 完整性检查失败或 schema 版本不受支持",
            path.display()
        ))
    }
}

fn resolve_startup_data_dir(
    default_dir: &std::path::Path,
) -> Result<(std::path::PathBuf, Vec<db::StartupWarning>), String> {
    let (configured, configured_error) = match db::read_configured_data_dir(default_dir) {
        Ok(configured) => (configured, None),
        Err(error) => (Some(default_dir.to_path_buf()), Some(error)),
    };
    let Some(mut configured_dir) = configured else {
        return Ok((default_dir.to_path_buf(), Vec::new()));
    };
    if configured_error.is_none() && configured_data_dir_has_database(&configured_dir) {
        return Ok((configured_dir, Vec::new()));
    }
    let mut configured_error = configured_error.unwrap_or_default();
    if !configured_error.is_empty() {
        eprintln!("[startup] data directory pointer could not be read: {configured_error}");
    }

    loop {
        let choice = rfd::MessageDialog::new()
            .set_title("鸽鸽词典数据目录不可用")
            .set_description(format!(
                "已配置的数据目录不存在或无法访问：{} {}\n\n选择“是”重试，“否”重新定位已有 gege.db，“取消”退出或重置到默认目录。",
                configured_dir.display(),
                configured_error
            ))
            .set_buttons(rfd::MessageButtons::YesNoCancel)
            .show();
        match choice {
            rfd::MessageDialogResult::Yes => {
                if configured_error.is_empty() {
                    if configured_data_dir_has_database(&configured_dir) {
                        return Ok((configured_dir, Vec::new()));
                    }
                } else {
                    match db::read_configured_data_dir(default_dir) {
                        Ok(Some(candidate)) => {
                            configured_dir = candidate;
                            configured_error.clear();
                        }
                        Ok(None) => return Ok((default_dir.to_path_buf(), Vec::new())),
                        Err(error) => configured_error = error,
                    }
                }
            }
            rfd::MessageDialogResult::No => {
                if let Some(selected) = rfd::FileDialog::new()
                    .set_title("重新定位已有 gege.db")
                    .pick_folder()
                {
                    let candidate = selected.join(db::DB_FILENAME);
                    match validate_relocated_database(&candidate) {
                        Ok(()) => {
                            db::persist_configured_data_dir(default_dir, &selected)?;
                            return Ok((selected, Vec::new()));
                        }
                        Err(error) => {
                            rfd::MessageDialog::new()
                                .set_title("无法使用该数据库")
                                .set_description(error)
                                .set_level(rfd::MessageLevel::Error)
                                .show();
                        }
                    }
                }
            }
            rfd::MessageDialogResult::Cancel => {
                let reset = rfd::MessageDialog::new()
                    .set_title("重置到默认数据目录？")
                    .set_description(format!(
                        "默认目录可能比原目录旧：{}\n确认后只切换指针，不删除原目录。",
                        default_dir.display()
                    ))
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .show();
                if reset == rfd::MessageDialogResult::Yes {
                    fs::create_dir_all(default_dir)
                        .map_err(|e| format!("创建默认数据目录失败: {e}"))?;
                    db::persist_configured_data_dir(default_dir, default_dir)?;
                    return Ok((
                        default_dir.to_path_buf(),
                        vec![db::StartupWarning {
                            kind: "data-dir-reset".into(),
                            message: "已明确重置到默认数据目录，默认库可能较旧".into(),
                        }],
                    ));
                }
                return Err("用户取消数据目录恢复".into());
            }
            rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Custom(_) => {}
        }
    }
}

fn configured_data_dir_has_database(directory: &std::path::Path) -> bool {
    if !directory.is_dir() {
        return false;
    }
    let primary = directory.join(db::DB_FILENAME);
    if primary.is_file() {
        return database_file_is_startup_candidate(&primary);
    }
    database_file_is_startup_candidate(&directory.join(db::LEGACY_DB_FILENAME))
}

fn database_file_is_startup_candidate(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|connection| {
            let integrity = connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?;
            if integrity != "ok" {
                return Ok(false);
            }
            let has_words = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='words')",
                [],
                |row| row.get::<_, bool>(0),
            )?;
            if !has_words {
                return Ok(false);
            }
            let schema =
                connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
            if schema > migrations::LATEST_SCHEMA_VERSION {
                return Ok(false);
            }
            if schema == migrations::LATEST_SCHEMA_VERSION {
                drop(connection);
                return Ok(db::validate_database_file(path).is_ok());
            }

            // Older databases are migrated on the next startup, but they
            // still need the legacy words contract that the migrations and
            // post-migration indexes depend on. Do not treat an arbitrary
            // table named `words` as a valid configured database.
            let required_words_columns = [
                "id",
                "lemma",
                "translation",
                "pos",
                "context_meaning",
                "explanation",
                "source_app",
                "source_title",
                "mastery",
                "kind",
                "saved_at",
                "updated_at",
                "lookups",
                "data",
            ];
            let mut statement = connection.prepare("PRAGMA table_info(words)")?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            if required_words_columns
                .iter()
                .any(|column| !columns.iter().any(|actual| actual == column))
            {
                return Ok(false);
            }
            Ok(true)
        })
        .is_ok_and(|result| result)
}

pub fn run() {
    let default_data_dir = default_data_dir();

    if let Err(error) = std::fs::create_dir_all(&default_data_dir) {
        rfd::MessageDialog::new()
            .set_title("鸽鸽词典无法启动")
            .set_description(format!("无法创建默认数据目录：{error}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
        return;
    }
    let (data_dir, startup_warnings) = match resolve_startup_data_dir(&default_data_dir) {
        Ok(result) => result,
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("鸽鸽词典无法启动")
                .set_description(error)
                .set_level(rfd::MessageLevel::Error)
                .show();
            return;
        }
    };
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        rfd::MessageDialog::new()
            .set_title("鸽鸽词典无法启动")
            .set_description(format!("无法访问配置的数据目录：{error}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
        return;
    }

    let db_path = db::resolve_db_path(&data_dir);
    let database = match db::Database::open(db_path.to_str().unwrap()) {
        Ok(database) => database,
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("鸽鸽词典无法启动")
                .set_description(format!("无法打开数据目录中的数据库：{error}"))
                .set_level(rfd::MessageLevel::Error)
                .show();
            return;
        }
    };
    if let Err(error) = database.initialize() {
        rfd::MessageDialog::new()
            .set_title("鸽鸽词典无法启动")
            .set_description(format!("数据库初始化失败：{error}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
        return;
    }

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
    match database.cleanup_local_events(90) {
        Ok(n) if n > 0 => eprintln!("[startup] Cleaned {n} expired local_events rows"),
        Err(e) => eprintln!("[startup] local_events cleanup error: {e}"),
        _ => {}
    }

    let clipboard_watch_enabled = database
        .get_settings()
        .ok()
        .and_then(|settings| settings.get("clipboardWatch").and_then(|v| v.as_bool()))
        .unwrap_or(true);

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            db: Mutex::new(database),
            last_capture: Mutex::new(None),
            watch: watch_switch::WatchSwitch::new(clipboard_watch_enabled),
            show_watch_mark: Mutex::new(None),
            last_looked_up: Mutex::new(None),
            startup_warnings: Mutex::new(startup_warnings),
        })
        .manage(enrich::Enrichment::default())
        .invoke_handler(tauri::generate_handler![
            get_all_words,
            search_words,
            save_word,
            restore_word,
            get_lookup_history,
            delete_lookup_history,
            clear_lookup_history,
            reopen_lookup_from_history,
            find_word_by_lemma,
            batch_update_words,
            update_word,
            delete_words,
            get_review_queue,
            submit_review,
            get_review_stats,
            get_learning_insights,
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
            preview_word_import,
            import_words,
            export_glossary,
            preview_glossary_matches,
            get_usage,
            get_local_metrics,
            clear_local_metrics,
            lookup::lookup_word,
            lookup::lookup_word_stream,
            lookup::test_connection,
            enrich::get_enrichment_status,
            enrich::start_enrichment,
            enrich::pause_enrichment,
            enrich::resume_enrichment,
            enrich::stop_enrichment,
            speak_text,
            stop_speaking,
            list_voices,
            export_words_data,
            export_database_snapshot,
            get_db_stats,
            get_startup_warnings,
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
            get_ocr_status,
            ocr_recognize_region,
            start_ocr_capture,
            set_ocr_capture_and_lookup,
            show_main_window,
            get_anki_config,
            test_anki_connection,
            list_anki_decks,
            list_anki_models,
            send_words_to_anki,
            apply_ocr_hotkey_from_settings,
        ])
        .setup(move |app| {
            let ocr_enabled = app
                .state::<AppState>()
                .db
                .lock()
                .ok()
                .and_then(|db| db.get_settings().ok())
                .map(|settings| ocr_settings(&settings).0)
                .unwrap_or(true);
            setup_tray(app, ocr_enabled)?;
            let _ = apply_ocr_hotkey(app.handle());
            let minimized = std::env::args().any(|arg| arg == "--minimized");
            if let Some(window) = app.get_webview_window("main") {
                if minimized {
                    // The runtime may apply the window's initial visibility after
                    // `setup` returns. Queue the hide on the UI thread as well as
                    // applying it immediately so autostart never flashes a window.
                    let deferred_window = window.clone();
                    let _ = window.hide();
                    let _ = window.run_on_main_thread(move || {
                        let _ = deferred_window.hide();
                    });
                    let delayed_app = app.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        for delay_ms in [50_u64, 250, 1_000] {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            if let Some(window) = delayed_app.get_webview_window("main") {
                                let deferred_window = window.clone();
                                let _ = window.hide();
                                let _ = window.run_on_main_thread(move || {
                                    let _ = deferred_window.hide();
                                });
                            }
                        }
                    });
                } else {
                    let deferred_window = window.clone();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.run_on_main_thread(move || {
                        let _ = deferred_window.show();
                        let _ = deferred_window.set_focus();
                    });
                }
            }
            check_auto_backup(app.app_handle());
            let backup_handle = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    check_auto_backup(&backup_handle);
                }
            });
            clipboard_watcher::start(
                app.app_handle().clone(),
                app.state::<AppState>().watch.flag(),
            );
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

    const LEGACY_WORDS_SCHEMA: &str = r#"
        CREATE TABLE words (
            id TEXT PRIMARY KEY,
            lemma TEXT NOT NULL,
            translation TEXT,
            pos TEXT,
            context_meaning TEXT,
            explanation TEXT,
            source_app TEXT,
            source_title TEXT,
            mastery TEXT DEFAULT 'new',
            kind TEXT DEFAULT 'word',
            saved_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            lookups INTEGER DEFAULT 1,
            data TEXT NOT NULL
        );
        PRAGMA user_version = 0;
    "#;

    #[test]
    fn history_is_on_unless_the_user_turned_it_off() {
        assert!(
            history_enabled(&serde_json::json!({})),
            "older settings have no key"
        );
        assert!(history_enabled(
            &serde_json::json!({ "historyEnabled": true })
        ));
        assert!(!history_enabled(
            &serde_json::json!({ "historyEnabled": false })
        ));
        assert!(
            history_enabled(&serde_json::json!({ "historyEnabled": "no" })),
            "only a real boolean switches it off"
        );
    }

    #[test]
    fn anki_note_pairs_keep_only_results_that_have_a_note_id() {
        let report = serde_json::json!({
            "added": 2,
            "errors": [],
            "results": [
                { "wordId": "a", "noteId": 11, "lemma": "a", "status": "added" },
                { "wordId": "b", "noteId": null, "lemma": "b", "status": "failed" },
                { "noteId": 33 },
                { "wordId": "d", "noteId": 44 }
            ]
        });
        assert_eq!(
            anki_note_pairs(&report),
            vec![("a".to_string(), 11), ("d".to_string(), 44)]
        );
        assert!(anki_note_pairs(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn report_errors_are_appended_even_when_the_report_had_none() {
        let mut report = serde_json::json!({ "added": 1 });
        push_report_error(&mut report, "first".into());
        push_report_error(&mut report, "second".into());
        assert_eq!(report["errors"], serde_json::json!(["first", "second"]));
        assert_eq!(report["added"], 1);
    }

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
    fn migration_requires_object_settings_to_update_data_dir() {
        let mut settings = serde_json::json!({"theme": "dark"});
        set_data_dir_setting(&mut settings, std::path::Path::new(r"D:\Data")).unwrap();
        assert_eq!(settings["dataDir"], r"D:\Data");

        let mut malformed = serde_json::json!([]);
        assert!(set_data_dir_setting(&mut malformed, std::path::Path::new(r"D:\Data")).is_err());
    }

    #[test]
    fn startup_does_not_accept_configured_directory_without_database_file() {
        let root = std::env::temp_dir().join(format!(
            "gege-startup-directory-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(!configured_data_dir_has_database(&root));
        let connection = rusqlite::Connection::open(root.join(db::DB_FILENAME)).unwrap();
        drop(connection);
        assert!(!configured_data_dir_has_database(&root));
        let database = db::Database::open(root.join(db::DB_FILENAME).to_str().unwrap()).unwrap();
        database.initialize().unwrap();
        assert!(configured_data_dir_has_database(&root));
        drop(database);
        std::fs::write(root.join(db::DB_FILENAME), b"corrupt").unwrap();
        let _ = std::fs::remove_file(root.join(format!("{}-wal", db::DB_FILENAME)));
        let _ = std::fs::remove_file(root.join(format!("{}-shm", db::DB_FILENAME)));
        assert!(!configured_data_dir_has_database(&root));
        let legacy =
            db::Database::open(root.join(db::LEGACY_DB_FILENAME).to_str().unwrap()).unwrap();
        legacy.initialize().unwrap();
        assert!(!configured_data_dir_has_database(&root));
        // Windows cannot remove a folder while a connection still holds a file in it open.
        drop(legacy);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn isolated_appdata_override_is_used_for_the_default_directory() {
        let override_root = std::path::PathBuf::from(r"C:\temp\gege-smoke-appdata");
        let known_root = std::path::PathBuf::from(r"C:\Users\test\AppData\Roaming");
        assert_eq!(
            default_data_dir_from(Some(override_root.clone()), Some(known_root)),
            override_root.join("GegeDic")
        );
    }

    #[test]
    fn relocation_rejects_database_with_schema_version_but_missing_contract() {
        let root = std::env::temp_dir().join(format!(
            "gege-relocation-schema-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(db::DB_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(&format!(
                "PRAGMA user_version = {}; CREATE TABLE words (id TEXT);",
                migrations::LATEST_SCHEMA_VERSION
            ))
            .unwrap();
        drop(connection);

        assert!(validate_relocated_database(&path).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relocation_accepts_older_valid_database_for_migration() {
        let root = std::env::temp_dir().join(format!(
            "gege-relocation-legacy-schema-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(db::DB_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(LEGACY_WORDS_SCHEMA).unwrap();
        drop(connection);

        assert!(validate_relocated_database(&path).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relocation_rejects_older_database_without_words_contract() {
        let root = std::env::temp_dir().join(format!(
            "gege-relocation-incomplete-legacy-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(db::DB_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT); PRAGMA user_version = 0;",
            )
            .unwrap();
        drop(connection);

        assert!(validate_relocated_database(&path).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn configured_older_database_is_selected_for_startup_migration() {
        let root = std::env::temp_dir().join(format!(
            "gege-startup-legacy-schema-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let default_dir = root.join("default");
        let selected_dir = root.join("selected");
        std::fs::create_dir_all(&selected_dir).unwrap();
        let path = selected_dir.join(db::DB_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(LEGACY_WORDS_SCHEMA).unwrap();
        drop(connection);
        db::persist_configured_data_dir(&default_dir, &selected_dir).unwrap();

        let (resolved, warnings) = resolve_startup_data_dir(&default_dir).unwrap();
        assert_eq!(resolved, selected_dir);
        assert!(warnings.is_empty());
        let database = db::Database::open(path.to_str().unwrap()).unwrap();
        database.initialize().unwrap();
        let reopened = rusqlite::Connection::open(&path).unwrap();
        let version: i64 = reopened
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, migrations::LATEST_SCHEMA_VERSION);
        drop(reopened);
        drop(database);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn startup_rejects_latest_version_without_schema_contract() {
        let root =
            std::env::temp_dir().join(format!("gege-startup-schema-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(db::DB_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TABLE words (id TEXT); PRAGMA user_version = {};",
                migrations::LATEST_SCHEMA_VERSION
            ))
            .unwrap();
        drop(connection);

        assert!(!configured_data_dir_has_database(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn database_initialization_rejects_latest_version_missing_schema_contract() {
        let root =
            std::env::temp_dir().join(format!("gege-init-schema-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(db::DB_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(LEGACY_WORDS_SCHEMA).unwrap();
        connection
            .pragma_update(None, "user_version", migrations::LATEST_SCHEMA_VERSION)
            .unwrap();
        drop(connection);

        let database = db::Database::open(path.to_str().unwrap()).unwrap();
        assert!(database.initialize().is_err());
        drop(database);
        let _ = std::fs::remove_dir_all(&root);
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
        // Nothing was said about a service that has no key.
        assert!(stored.get("backupApiKeyError").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_plaintext_backup_key_is_migrated_to_dpapi_like_the_main_key() {
        let database = db::Database::open_memory().unwrap();
        database.initialize().unwrap();
        let mut settings = database.get_settings().unwrap();
        settings["provider"]["apiKey"] = serde_json::Value::String("sk-main-plain".into());
        settings["backupProvider"] =
            serde_json::json!({ "enabled": true, "apiKey": "sk-backup-plain" });
        database.save_settings(&settings).unwrap();

        migrate_api_key_storage(&database).unwrap();

        let stored = database.get_settings().unwrap();
        for (service, plain) in [
            ("provider", "sk-main-plain"),
            ("backupProvider", "sk-backup-plain"),
        ] {
            let encrypted = stored[service]["apiKey"].as_str().unwrap();
            assert!(dpapi::is_encrypted(encrypted), "{service}");
            assert_eq!(dpapi::decrypt(encrypted).unwrap(), plain, "{service}");
        }
        // The rest of the backup is as it was left.
        assert_eq!(stored["backupProvider"]["enabled"], true);
        assert!(stored.get("apiKeyError").is_none() && stored.get("backupApiKeyError").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn an_unreadable_backup_key_is_cleared_with_its_own_error_and_the_main_key_is_left_alone() {
        let database = db::Database::open_memory().unwrap();
        database.initialize().unwrap();
        let main_key = dpapi::encrypt("sk-main-secret").unwrap();
        let mut settings = database.get_settings().unwrap();
        settings["provider"]["apiKey"] = serde_json::Value::String(main_key.clone());
        settings["backupProvider"] =
            serde_json::json!({ "enabled": true, "apiKey": "dpapi:v1:not-base64!" });
        database.save_settings(&settings).unwrap();

        migrate_api_key_storage(&database).unwrap();

        let stored = database.get_settings().unwrap();
        assert_eq!(stored["backupProvider"]["apiKey"], "");
        assert!(stored["backupApiKeyError"].as_str().is_some());
        assert_eq!(stored["provider"]["apiKey"], main_key.as_str());
        assert!(stored.get("apiKeyError").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn the_page_only_ever_gets_a_placeholder_for_either_key() {
        let mut settings = serde_json::json!({
            "provider": { "apiKey": dpapi::encrypt("sk-main-secret").unwrap(), "model": "m" },
            "backupProvider": { "apiKey": dpapi::encrypt("sk-backup-secret").unwrap(), "enabled": true },
        });

        redact_api_keys(&mut settings);

        for service in ["provider", "backupProvider"] {
            assert_eq!(
                settings[service]["apiKey"],
                lookup::API_KEY_PLACEHOLDER,
                "{service}"
            );
            assert_eq!(settings[service]["hasApiKey"], true, "{service}");
        }
        let sent = settings.to_string();
        for secret in ["sk-main-secret", "sk-backup-secret", "dpapi:"] {
            assert!(!sent.contains(secret), "{secret} must not reach the page");
        }
        assert_eq!(settings["provider"]["model"], "m");
        assert_eq!(settings["backupProvider"]["enabled"], true);
    }

    #[cfg(windows)]
    #[test]
    fn what_cannot_be_used_is_reported_as_no_key_and_what_is_missing_stays_missing() {
        let mut settings = serde_json::json!({
            "provider": { "apiKey": "dpapi:v1:not-base64!" },
            "backupProvider": { "apiKey": "", "enabled": false },
        });
        redact_api_keys(&mut settings);
        assert_eq!(
            (
                settings["provider"]["apiKey"].as_str(),
                settings["provider"]["hasApiKey"].as_bool()
            ),
            (Some(""), Some(false))
        );
        assert_eq!(
            (
                settings["backupProvider"]["apiKey"].as_str(),
                settings["backupProvider"]["hasApiKey"].as_bool()
            ),
            (Some(""), Some(false))
        );

        // A plaintext key that is still waiting for its migration is not shown either.
        let mut leftover = serde_json::json!({ "provider": { "apiKey": "sk-plain" } });
        redact_api_keys(&mut leftover);
        assert_eq!(leftover["provider"]["apiKey"], lookup::API_KEY_PLACEHOLDER);
        assert!(!leftover.to_string().contains("sk-plain"));

        // A backup that was never set up is not made up by the redaction.
        assert!(leftover.get("backupProvider").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_placeholder_from_the_page_keeps_the_ciphertext_of_its_own_service() {
        let main_key = dpapi::encrypt("sk-main-secret").unwrap();
        let backup_key = dpapi::encrypt("sk-backup-secret").unwrap();
        let stored = serde_json::json!({
            "provider": { "apiKey": main_key },
            "backupProvider": { "apiKey": backup_key },
        });
        let mut incoming = serde_json::json!({
            "provider": { "apiKey": lookup::API_KEY_PLACEHOLDER, "hasApiKey": true, "model": "m2" },
            // The page cleared the field, which never deletes a stored key.
            "backupProvider": { "apiKey": "", "hasApiKey": false, "enabled": true },
            "apiKeyError": "old", "backupApiKeyError": "old",
        });

        secure_api_keys_for_storage(&mut incoming, &stored).unwrap();
        strip_key_status(&mut incoming);

        assert_eq!(incoming["provider"]["apiKey"], stored["provider"]["apiKey"]);
        assert_eq!(
            incoming["backupProvider"]["apiKey"],
            stored["backupProvider"]["apiKey"]
        );
        assert_eq!(incoming["provider"]["model"], "m2");
        assert_eq!(incoming["backupProvider"]["enabled"], true);
        // What only travels to the page is not stored.
        for gone in ["apiKeyError", "backupApiKeyError"] {
            assert!(incoming.get(gone).is_none(), "{gone}");
        }
        for service in ["provider", "backupProvider"] {
            assert!(incoming[service].get("hasApiKey").is_none(), "{service}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_typed_backup_key_is_encrypted_without_touching_the_main_key() {
        let main_key = dpapi::encrypt("sk-main-secret").unwrap();
        let stored = serde_json::json!({ "provider": { "apiKey": main_key } });
        let mut incoming = serde_json::json!({
            "provider": { "apiKey": lookup::API_KEY_PLACEHOLDER },
            "backupProvider": { "apiKey": "sk-new-backup", "enabled": true },
        });

        secure_api_keys_for_storage(&mut incoming, &stored).unwrap();

        assert_eq!(incoming["provider"]["apiKey"], stored["provider"]["apiKey"]);
        let backup = incoming["backupProvider"]["apiKey"].as_str().unwrap();
        assert!(dpapi::is_encrypted(backup));
        assert_eq!(dpapi::decrypt(backup).unwrap(), "sk-new-backup");
        assert!(!incoming.to_string().contains("sk-new-backup"));
    }

    #[cfg(windows)]
    #[test]
    fn a_backup_that_was_never_set_up_is_saved_without_a_key_and_without_dpapi() {
        let stored = serde_json::json!({ "provider": { "apiKey": "" } });
        let mut incoming = serde_json::json!({
            "provider": { "apiKey": "" },
            "backupProvider": { "apiKey": "", "enabled": false },
        });

        secure_api_keys_for_storage(&mut incoming, &stored).unwrap();

        assert_eq!(incoming["backupProvider"]["apiKey"], "");
        assert_eq!(incoming["provider"]["apiKey"], "");
        // The placeholder is never kept as if it were a key.
        let mut stale =
            serde_json::json!({ "backupProvider": { "apiKey": lookup::API_KEY_PLACEHOLDER } });
        secure_api_keys_for_storage(&mut stale, &stored).unwrap();
        assert_eq!(stale["backupProvider"]["apiKey"], "");
    }
}
