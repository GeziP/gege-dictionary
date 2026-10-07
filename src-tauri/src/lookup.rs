#[cfg(windows)]
use crate::dpapi;
use crate::glossary;
use crate::llm;
use crate::AppState;

use sha2::{Digest, Sha256};
use tauri::Emitter;

pub(crate) const API_KEY_PLACEHOLDER: &str = "••••••••";

pub(crate) fn is_placeholder_api_key(value: &str) -> bool {
    value == API_KEY_PLACEHOLDER || value.chars().all(|c| c == '•' || c == '*') && value.len() >= 4
}

pub(crate) fn lookup_cache_key(
    selection: &str,
    context: &str,
    kind: &str,
    model: &str,
    enriched_template: &str,
) -> String {
    let normalized = crate::normalize_selection(selection, kind);
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

pub(crate) fn should_fallback_stream(saw_content: bool) -> bool {
    !saw_content
}

/// Make sure a lookup error reaches the UI carrying a code. Errors from `llm.rs` already
/// have the one chosen from the real cause (HTTP status, kind of transport error, ...);
/// anything else is `unknown` - the wording of a message is never enough to invent a code.
pub(crate) fn classify_lookup_error(err: &str) -> String {
    if llm::error_code(err).is_some() {
        err.trim_start().to_string()
    } else {
        llm::coded("unknown", err)
    }
}

struct PreparedLookup {
    base_url: String,
    api_key: String,
    model: String,
    protocol: String,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    template_body: String,
    template_name: String,
    cache_key: String,
    cache_hit: Option<serde_json::Value>,
}

fn decrypt_provider_api_key(raw_key: &str, log_prefix: &str) -> String {
    eprintln!(
        "[{log_prefix}] stored key is DPAPI-encrypted={}",
        raw_key.starts_with("dpapi:")
    );
    #[cfg(windows)]
    {
        match dpapi::decrypt(raw_key) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("[{log_prefix}] DPAPI decrypt FAILED: {e}");
                raw_key.to_string()
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = log_prefix;
        raw_key.to_string()
    }
}

pub(crate) fn annotate_lookup_entry(entry: &mut serde_json::Value, template_name: &str) {
    if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "_templateName".to_string(),
            serde_json::Value::String(template_name.to_string()),
        );
    }
}

/// How a lookup was answered, which decides what it cost.
#[derive(Clone, Copy)]
enum Answer<'a> {
    /// Served from the local cache: still a lookup the user made, but it cost nothing.
    Cache,
    /// The model replied `raw` to `prompt`.
    Model { prompt: &'a str, raw: &'a str },
}

/// The one place a successful lookup is wrapped up, whichever of the five ways it succeeded.
/// A fresh answer is tagged with its template and cached; every answer counts towards usage.
fn finish_lookup(
    state: &tauri::State<'_, AppState>,
    prepared: &PreparedLookup,
    mut entry: serde_json::Value,
    answer: Answer<'_>,
) -> serde_json::Value {
    let tokens = match answer {
        Answer::Cache => 0,
        Answer::Model { prompt, raw } => {
            annotate_lookup_entry(&mut entry, &prepared.template_name);
            llm::estimate_lookup_tokens(prompt, raw)
        }
    };
    match state.db.lock() {
        Ok(db) => {
            if matches!(answer, Answer::Model { .. }) {
                if let Err(e) = db.set_cache(&prepared.cache_key, &prepared.model, &entry) {
                    eprintln!("[lookup] could not cache the answer: {e}");
                }
            }
            if let Err(e) = db.record_lookup(tokens) {
                eprintln!("[lookup] could not record usage: {e}");
            }
        }
        Err(_) => eprintln!("[lookup] database lock poisoned; answer neither cached nor counted"),
    }
    entry
}

pub(crate) fn selection_meta(selection: &str, kind: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(selection.as_bytes());
    let digest = hasher.finalize();
    let head = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    format!("len={} kind={kind} head_hash={head:08x}", selection.len())
}

/// Shared preflight for non-streaming and streaming lookup commands.
/// Resolves provider/template/glossary, DPAPI key, cache key, and optional cache hit.
fn prepare_lookup(
    state: &tauri::State<'_, AppState>,
    selection: &str,
    context: &str,
    kind: &str,
    force_refresh: bool,
    log_prefix: &str,
) -> Result<PreparedLookup, String> {
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
            .ok_or_else(|| llm::coded("no_key", "尚未配置模型服务，请到设置页填写"))?
            .clone();
        let templates = db.get_templates()?;
        let scope = match kind {
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
        let glossary_matches = db.find_glossary_matches(selection, context, domain)?;
        if !glossary_matches.is_empty() {
            eprintln!(
                "[{log_prefix}] glossary_term_applied count={}, domain={domain}",
                glossary_matches.len()
            );
            let _ = db.record_local_event(
                "glossary_term_applied",
                &serde_json::json!({ "count_bucket": glossary_matches.len().min(10).to_string() }),
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
        let api_key_decrypted = decrypt_provider_api_key(&raw_key, log_prefix);

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
            crate::cache_ttl_days(&settings),
        )
    };

    if api_key.trim().is_empty() {
        return Err(llm::coded("no_key", "尚未配置 API Key，请到设置页填写"));
    }
    if api_key.starts_with("dpapi:") {
        return Err(llm::coded("no_key", "API Key 解密失败，请到设置页重新输入"));
    }

    let cache_key = lookup_cache_key(selection, context, kind, &model, &template_body);
    let mut cache_hit = None;
    if !force_refresh {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(mut cached) = db.get_cache(&cache_key, cache_ttl)? {
            let _ = db.record_local_event("lookup_cache_hit", &serde_json::json!({ "kind": kind }));
            if let Some(obj) = cached.as_object_mut() {
                obj.insert("fromCache".to_string(), serde_json::Value::Bool(true));
                obj.insert(
                    "_templateName".to_string(),
                    serde_json::Value::String(template_name.clone()),
                );
            }
            cache_hit = Some(cached);
        } else {
            let _ =
                db.record_local_event("lookup_cache_miss", &serde_json::json!({ "kind": kind }));
        }
    } else {
        let _ = state.db.lock().map(|db| {
            db.record_local_event("lookup_cache_miss", &serde_json::json!({ "kind": kind }))
        });
    }

    Ok(PreparedLookup {
        base_url,
        api_key,
        model,
        protocol,
        temperature,
        max_tokens,
        timeout_secs,
        template_body,
        template_name,
        cache_key,
        cache_hit,
    })
}

pub(crate) fn resolve_api_key_for_request(
    state: &tauri::State<'_, AppState>,
    api_key: &str,
) -> Result<String, String> {
    if !api_key.is_empty() && !is_placeholder_api_key(api_key) {
        return Ok(api_key.to_string());
    }
    #[cfg(windows)]
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let stored = db
            .get_settings()?
            .get("provider")
            .and_then(|p| p.get("apiKey"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if stored.is_empty() {
            return Err(llm::coded("no_key", "尚未配置 API Key"));
        }
        if dpapi::is_encrypted(&stored) {
            return dpapi::decrypt(&stored)
                .map_err(|e| llm::coded("no_key", format!("API Key 解密失败，请重新输入（{e}）")));
        }
        return Ok(stored);
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        if api_key.is_empty() || is_placeholder_api_key(api_key) {
            return Err(llm::coded("no_key", "尚未配置 API Key"));
        }
        Ok(api_key.to_string())
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn lookup_word(
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    kind: String,
    force_refresh: bool,
) -> Result<serde_json::Value, String> {
    let mut prepared = prepare_lookup(
        &state,
        &selection,
        &context,
        &kind,
        force_refresh,
        "lookup_word",
    )?;

    if let Some(cached) = prepared.cache_hit.take() {
        eprintln!("[lookup_word] cache HIT");
        return Ok(finish_lookup(&state, &prepared, cached, Answer::Cache));
    }

    eprintln!(
        "[lookup_word] {} model={:?} protocol={:?} timeout={}s tpl_len={}, cache miss, calling LLM...",
        selection_meta(&selection, &kind),
        prepared.model,
        prepared.protocol,
        prepared.timeout_secs,
        prepared.template_body.len()
    );

    let full_text = llm::stream_lookup(
        &prepared.base_url,
        &prepared.api_key,
        &prepared.model,
        &prepared.protocol,
        prepared.temperature,
        prepared.max_tokens,
        prepared.timeout_secs,
        &selection,
        &context,
        &kind,
        &prepared.template_body,
    )
    .await
    .map_err(|e| {
        let classified = classify_lookup_error(&e);
        eprintln!("[lookup_word] LLM ERROR: {classified}");
        classified
    })?;

    eprintln!("[lookup_word] LLM OK, len={}", full_text.len());

    let entry = llm::parse_entry(&full_text, &selection, &kind).map_err(|e| {
        eprintln!("[lookup_word] parse FAIL: {e}");
        classify_lookup_error(&e)
    })?;

    let prompt = llm::build_prompt(&prepared.template_body, &selection, &context);
    let answer = Answer::Model {
        prompt: &prompt,
        raw: &full_text,
    };
    eprintln!("[lookup_word] done, returning entry");
    Ok(finish_lookup(&state, &prepared, entry, answer))
}

#[tauri::command]
pub async fn lookup_word_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    kind: String,
    request_id: String,
    force_refresh: bool,
) -> Result<(), String> {
    let mut prepared = prepare_lookup(
        &state,
        &selection,
        &context,
        &kind,
        force_refresh,
        "lookup_stream",
    )?;

    if let Some(cached) = prepared.cache_hit.take() {
        eprintln!("[lookup_stream] cache HIT");
        let entry = finish_lookup(&state, &prepared, cached, Answer::Cache);
        let _ = app.emit(
            "lookup://done",
            serde_json::json!({
                "requestId": request_id,
                "entry": entry,
                "fromCache": true,
            }),
        );
        return Ok(());
    }

    eprintln!("[lookup_stream] starting SSE, url={}", prepared.base_url);

    let rid = request_id.clone();
    let app_clone = app.clone();
    let mut extractor = llm::IncrementalJsonExtractor::new();
    let mut saw_stream_content = false;
    let stream_started = std::time::Instant::now();
    let mut first_field_logged = false;
    let app_for_metrics = app.clone();
    let kind_for_metrics = kind.clone();
    let prompt = llm::build_prompt(&prepared.template_body, &selection, &context);

    let result = llm::stream_lookup_sse(
        &prepared.base_url,
        &prepared.api_key,
        &prepared.model,
        &prepared.protocol,
        prepared.temperature,
        prepared.max_tokens,
        prepared.timeout_secs,
        &selection,
        &context,
        &kind,
        &prepared.template_body,
        |delta| {
            if !delta.is_empty() {
                saw_stream_content = true;
            }
            let fields = extractor.push(delta);
            if !fields.is_empty() && !first_field_logged {
                first_field_logged = true;
                let ms = stream_started.elapsed().as_millis() as u64;
                let bucket = match ms {
                    0..=499 => "0-500",
                    500..=999 => "500-1000",
                    1000..=1999 => "1000-2000",
                    _ => "2000+",
                };
                crate::record_event_handle(
                    &app_for_metrics,
                    "lookup_stream_first_field",
                    serde_json::json!({
                        "ms_bucket": bucket,
                        "kind": kind_for_metrics,
                    }),
                );
            }
            for (field, value) in fields {
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
    .await
    .map_err(|e| classify_lookup_error(&e));

    match result {
        Ok(full_text) => match llm::parse_entry(&full_text, &selection, &kind) {
            Ok(entry) => {
                let answer = Answer::Model {
                    prompt: &prompt,
                    raw: &full_text,
                };
                let entry = finish_lookup(&state, &prepared, entry, answer);
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
                let err_msg = classify_lookup_error(&e);
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
            if should_fallback_stream(saw_stream_content) {
                eprintln!("[lookup_stream] falling back to one non-streaming request");
                crate::record_event_handle(&app, "lookup_stream_fallback", serde_json::json!({}));
                match llm::stream_lookup(
                    &prepared.base_url,
                    &prepared.api_key,
                    &prepared.model,
                    &prepared.protocol,
                    prepared.temperature,
                    prepared.max_tokens,
                    prepared.timeout_secs,
                    &selection,
                    &context,
                    &kind,
                    &prepared.template_body,
                )
                .await
                {
                    Ok(full_text) => match llm::parse_entry(&full_text, &selection, &kind) {
                        Ok(entry) => {
                            let answer = Answer::Model {
                                prompt: &prompt,
                                raw: &full_text,
                            };
                            let entry = finish_lookup(&state, &prepared, entry, answer);
                            let _ = app.emit(
                                "lookup://done",
                                serde_json::json!({
                                    "requestId": request_id,
                                    "entry": entry,
                                    "raw": full_text,
                                    "fromCache": false,
                                    "fallback": true,
                                }),
                            );
                            return Ok(());
                        }
                        Err(parse_error) => {
                            eprintln!("[lookup_stream] fallback parse failed: {parse_error}");
                        }
                    },
                    Err(fallback_error) => {
                        eprintln!("[lookup_stream] fallback failed: {fallback_error}");
                    }
                }
            }
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
pub async fn test_connection(
    state: tauri::State<'_, AppState>,
    base_url: String,
    api_key: String,
    model: String,
    protocol: Option<String>,
) -> Result<serde_json::Value, String> {
    let proto = protocol.as_deref().unwrap_or("openai");
    let api_key = resolve_api_key_for_request(&state, &api_key)?;
    llm::test_connection(&base_url, &api_key, &model, proto).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn annotate_lookup_entry_sets_template_name() {
        let mut entry = serde_json::json!({ "lemma": "resilient" });
        annotate_lookup_entry(&mut entry, "单词解析 [word]");
        assert_eq!(entry["_templateName"], "单词解析 [word]");
        assert_eq!(entry["lemma"], "resilient");
    }

    #[test]
    fn classify_lookup_error_keeps_a_real_code_and_never_guesses_one() {
        // A code chosen at the source passes through untouched...
        for code in llm::ERROR_CODES {
            let err = llm::coded(code, "x");
            assert_eq!(classify_lookup_error(&err), err);
        }
        // ...and the wording of a message is never enough to invent one.
        for text in [
            "401 Unauthorized",
            "request timed out",
            "connection refused",
            "请求超时",
            "something else",
        ] {
            assert_eq!(classify_lookup_error(text), format!("[unknown] {text}"));
        }
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

    #[test]
    fn streaming_fallback_only_applies_before_first_content() {
        assert!(should_fallback_stream(false));
        assert!(!should_fallback_stream(true));
    }

    #[test]
    fn cache_round_trip_preserves_entry_and_hit_annotation() {
        let dir =
            std::env::temp_dir().join(format!("gege-dic-cache-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("gege.db");
        let db = db::Database::open(&db_path.to_string_lossy()).unwrap();
        db.initialize().unwrap();

        let mut entry = serde_json::json!({
            "lemma": "resilient",
            "translation": "有韧性的",
            "kind": "word"
        });
        annotate_lookup_entry(&mut entry, "标准模板 [word]");
        db.set_cache("k1", "gpt-test", &entry).unwrap();

        let mut hit = db.get_cache("k1", 30).unwrap().expect("cache should hit");
        assert_eq!(hit["lemma"], "resilient");
        if let Some(obj) = hit.as_object_mut() {
            obj.insert("fromCache".into(), serde_json::Value::Bool(true));
            obj.insert(
                "_templateName".into(),
                serde_json::Value::String("标准模板 [word]".into()),
            );
        }
        assert_eq!(hit["fromCache"], true);
        assert_eq!(hit["_templateName"], "标准模板 [word]");

        assert!(db.get_cache("missing", 30).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
