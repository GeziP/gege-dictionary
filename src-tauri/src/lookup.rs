use crate::db::{Database, HistoryRecord};
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

/// One model service a lookup can be sent to: the main one, or the backup.
#[derive(Clone, PartialEq)]
struct ModelTarget {
    base_url: String,
    api_key: String,
    model: String,
    protocol: String,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
}

// By hand, so that a stray `{:?}` can never put the API key in a log.
impl std::fmt::Debug for ModelTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelTarget")
            .field("base_url", &self.base_url)
            .field("api_key", &"<hidden>")
            .field("model", &self.model)
            .field("protocol", &self.protocol)
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl ModelTarget {
    /// The call to this service; the prompt is built from the selection.
    fn model_call(&self) -> llm::ModelCall<'_> {
        llm::ModelCall {
            base_url: &self.base_url,
            api_key: &self.api_key,
            model: &self.model,
            protocol: &self.protocol,
            temperature: self.temperature,
            max_tokens: self.max_tokens,
            timeout_secs: self.timeout_secs,
        }
    }

    /// Whether this is the very same service as `other`: same address, model and key. Two keys
    /// for one service are two services here, since one account can be out of quota while
    /// another is not.
    fn is_same_service_as(&self, other: &ModelTarget) -> bool {
        let address =
            |target: &ModelTarget| target.base_url.trim().trim_end_matches('/').to_string();
        address(self) == address(other)
            && self.model.trim() == other.model.trim()
            && self.api_key == other.api_key
    }
}

/// Which of the two model services of a lookup is meant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Service {
    Main,
    Backup,
}

/// Who is asking. The words the user looks up are counted in the usage figures, remembered in
/// the history and measured by the cache statistics. The batch enrichment of imported words asks
/// the same questions in the background, and is none of those: it costs tokens, and only that is
/// counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Asker {
    User,
    Batch,
}

struct PreparedLookup {
    main: ModelTarget,
    /// Asked once when the main service fails in a way another one may fix. `None` unless the
    /// user turned it on and filled it in.
    backup: Option<ModelTarget>,
    template_body: String,
    template_name: String,
    cache_key: String,
    cache_hit: Option<serde_json::Value>,
    /// Whether answered lookups are remembered in the history (a setting the user can turn off,
    /// and never done for a batch).
    record_history: bool,
    asker: Asker,
}

/// The question a lookup answers: what was selected, around what, and as which kind.
#[derive(Clone, Copy)]
struct LookupRequest<'a> {
    selection: &'a str,
    context: &'a str,
    kind: &'a str,
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

/// Say which model really answered. When it was not the main service, say that too, so that the
/// user is never left thinking the model they chose wrote this.
fn annotate_answering_model(entry: &mut serde_json::Value, model: &str, service: Service) {
    if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "_model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
        if service == Service::Backup {
            obj.insert("_viaBackup".to_string(), serde_json::Value::Bool(true));
        }
    }
}

/// How a lookup was answered, which decides what it cost.
#[derive(Clone, Copy)]
enum Answer<'a> {
    /// Served from the local cache: still a lookup the user made, but it cost nothing.
    Cache,
    /// `model`, one of the two services, replied `raw` to `prompt`.
    Model {
        prompt: &'a str,
        raw: &'a str,
        model: &'a str,
        service: Service,
    },
}

/// Where a lookup's text was captured, as far as that is known.
#[derive(Default)]
struct CaptureSource {
    app: String,
    title: String,
}

/// The source of the last capture, but only when that capture is the very text being looked up:
/// a stale capture of something else must not be credited with this lookup.
fn capture_source(state: &AppState, selection: &str) -> CaptureSource {
    let Ok(capture) = state.last_capture.lock() else {
        return CaptureSource::default();
    };
    let Some(capture) = capture.as_ref() else {
        return CaptureSource::default();
    };
    let text = |key: &str| {
        capture
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    if text("selection").trim() != selection.trim() {
        return CaptureSource::default();
    }
    CaptureSource {
        app: text("sourceApp").to_string(),
        title: text("sourceTitle").to_string(),
    }
}

/// Put an answered lookup in the history. A failure is logged and otherwise ignored: the
/// history is a convenience and must never turn a successful lookup into an error.
fn remember_lookup(
    db: &Database,
    request: LookupRequest<'_>,
    entry: &serde_json::Value,
    source: &CaptureSource,
) {
    let text = |key: &str| {
        entry
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    let record = HistoryRecord {
        selection: request.selection,
        context: request.context,
        kind: request.kind,
        lemma: text("lemma"),
        translation: text("translation"),
        source_app: &source.app,
        source_title: &source.title,
    };
    if let Err(e) = db.record_history(&record) {
        eprintln!("[lookup] could not record history: {e}");
    }
}

/// The one place a successful lookup is wrapped up, whichever of the five ways it succeeded.
/// A fresh answer is tagged with its template and the model that wrote it, and cached; every
/// answer counts towards usage and, unless the user turned that off, goes into the history.
fn finish_lookup(
    state: &AppState,
    prepared: &PreparedLookup,
    request: LookupRequest<'_>,
    mut entry: serde_json::Value,
    answer: Answer<'_>,
) -> serde_json::Value {
    let tokens = match answer {
        Answer::Cache => 0,
        Answer::Model {
            prompt,
            raw,
            model,
            service,
        } => {
            annotate_lookup_entry(&mut entry, &prepared.template_name);
            annotate_answering_model(&mut entry, model, service);
            llm::estimate_lookup_tokens(prompt, raw)
        }
    };
    // Read before the database is locked, so the two locks are never held at the same time.
    let source = if prepared.record_history {
        capture_source(state, request.selection)
    } else {
        CaptureSource::default()
    };
    match state.db.lock() {
        Ok(db) => {
            // The answer is kept under the main service's key, whoever wrote it: asking again
            // soon must not go back to a service that has just failed. "Refresh" asks it anew.
            if let Answer::Model { model, .. } = answer {
                if let Err(e) = db.set_cache(&prepared.cache_key, model, &entry) {
                    eprintln!("[lookup] could not cache the answer: {e}");
                }
            }
            let counted = match prepared.asker {
                Asker::User => db.record_lookup(tokens),
                Asker::Batch => db.record_tokens(tokens),
            };
            if let Err(e) = counted {
                eprintln!("[lookup] could not record usage: {e}");
            }
            if prepared.record_history {
                remember_lookup(&db, request, &entry, &source);
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

/// What the settings and the templates say about answering one lookup, read under one lock.
struct LookupPlan {
    main: ModelTarget,
    backup: Option<ModelTarget>,
    template_body: String,
    template_name: String,
    cache_ttl: i64,
}

/// What one `provider` object of the settings (`provider` or `backupProvider`) says about
/// calling that service for a lookup of this `kind`, with its key already decrypted.
fn model_target(provider: &serde_json::Value, kind: &str, api_key: String) -> ModelTarget {
    let text = |key: &str, default: &str| {
        provider
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or(default)
            .to_string()
    };
    let base_url = text("baseUrl", "");
    let mut max_tokens = provider
        .get("maxTokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1200) as u32;
    let mut timeout_secs = provider
        .get("timeoutSeconds")
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .unwrap_or(60);
    if kind == "paragraph" {
        max_tokens = max_tokens.max(4000);
        timeout_secs = timeout_secs.max(120);
    }
    if base_url.to_ascii_lowercase().contains("deepseek.com") {
        max_tokens = max_tokens.max(3000);
    }
    ModelTarget {
        model: text("model", ""),
        protocol: text("protocol", "openai"),
        temperature: provider
            .get("temperature")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.3),
        base_url,
        api_key,
        max_tokens,
        timeout_secs,
    }
}

/// The backup service of a lookup. It exists only when the user turned it on and described it
/// completely (a service, a model and a key that can be read), and when it is not just the main
/// service again; anything less is no backup, and the settings page says what is missing.
/// `decrypt` turns the stored key into the one to send, and is only asked when the backup is on.
fn backup_target(
    settings: &serde_json::Value,
    kind: &str,
    main: &ModelTarget,
    decrypt: impl Fn(&str) -> String,
) -> Option<ModelTarget> {
    let backup = settings.get("backupProvider")?;
    if backup.get("enabled").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    let stored_key = backup
        .get("apiKey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let target = model_target(backup, kind, decrypt(stored_key));
    let complete = !target.base_url.trim().is_empty()
        && !target.model.trim().is_empty()
        && !target.api_key.trim().is_empty()
        // Still ciphertext: it cannot be read by this Windows user.
        && !target.api_key.starts_with("dpapi:");
    (complete && !target.is_same_service_as(main)).then_some(target)
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
    asker: Asker,
) -> Result<PreparedLookup, String> {
    let record_history;
    let LookupPlan {
        main,
        backup,
        template_body,
        template_name,
        cache_ttl,
    } = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let settings = db.get_settings()?;
        record_history = asker == Asker::User && crate::history_enabled(&settings);
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
            if asker == Asker::User {
                let _ = db.record_local_event(
                    "glossary_term_applied",
                    &serde_json::json!({ "count_bucket": glossary_matches.len().min(10).to_string() }),
                );
            }
        }
        let tpl_body = glossary::enrich_template(&tpl_body, domain, style, &glossary_matches);

        let stored_key = provider
            .get("apiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let main = model_target(
            &provider,
            kind,
            decrypt_provider_api_key(stored_key, log_prefix),
        );
        let backup = backup_target(&settings, kind, &main, |stored| {
            decrypt_provider_api_key(stored, &format!("{log_prefix}/backup"))
        });

        LookupPlan {
            main,
            backup,
            template_body: tpl_body,
            template_name: format!("{} [{}]", tpl_name, tpl_scope),
            cache_ttl: crate::cache_ttl_days(&settings),
        }
    };

    if main.api_key.trim().is_empty() {
        return Err(llm::coded("no_key", "尚未配置 API Key，请到设置页填写"));
    }
    if main.api_key.starts_with("dpapi:") {
        return Err(llm::coded("no_key", "API Key 解密失败，请到设置页重新输入"));
    }

    // The answer is looked up, and kept, under the main service's model, whichever service
    // ends up writing it: switching the main model is what makes old answers stale.
    let cache_key = lookup_cache_key(selection, context, kind, &main.model, &template_body);
    let mut cache_hit = None;
    if !force_refresh {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(mut cached) = db.get_cache(&cache_key, cache_ttl)? {
            if asker == Asker::User {
                let _ =
                    db.record_local_event("lookup_cache_hit", &serde_json::json!({ "kind": kind }));
            }
            if let Some(obj) = cached.as_object_mut() {
                obj.insert("fromCache".to_string(), serde_json::Value::Bool(true));
                obj.insert(
                    "_templateName".to_string(),
                    serde_json::Value::String(template_name.clone()),
                );
            }
            cache_hit = Some(cached);
        } else if asker == Asker::User {
            let _ =
                db.record_local_event("lookup_cache_miss", &serde_json::json!({ "kind": kind }));
        }
    } else if asker == Asker::User {
        let _ = state.db.lock().map(|db| {
            db.record_local_event("lookup_cache_miss", &serde_json::json!({ "kind": kind }))
        });
    }

    Ok(PreparedLookup {
        main,
        backup,
        template_body,
        template_name,
        cache_key,
        cache_hit,
        record_history,
        asker,
    })
}

/// The key a request is made with: the one typed in, or - when the settings page sent back the
/// placeholder or nothing - the one stored for `settings_key` (`provider` or `backupProvider`).
pub(crate) fn resolve_api_key_for_request(
    state: &AppState,
    api_key: &str,
    settings_key: &str,
) -> Result<String, String> {
    if !api_key.is_empty() && !is_placeholder_api_key(api_key) {
        return Ok(api_key.to_string());
    }
    #[cfg(windows)]
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let stored = db
            .get_settings()?
            .get(settings_key)
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
        Ok(stored)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, settings_key);
        if api_key.is_empty() || is_placeholder_api_key(api_key) {
            return Err(llm::coded("no_key", "尚未配置 API Key"));
        }
        Ok(api_key.to_string())
    }
}

// ---------------------------------------------------------------------------
// Asking the model services
// ---------------------------------------------------------------------------

/// What one service answered: the entry, the text it was read from, and who wrote it.
struct Reply {
    entry: serde_json::Value,
    raw: String,
    /// The model that wrote it.
    model: String,
    /// Whether it took a second, non-streaming request to get it.
    after_stream_retry: bool,
}

/// Which part of answering failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Asking the service, and receiving what it said.
    Stream,
    /// Reading the entry out of what it said.
    Parse,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Stage::Stream => "stream",
            Stage::Parse => "parse",
        }
    }
}

/// A failed attempt: what to tell the user, and which part of it failed.
#[derive(Clone, Debug, PartialEq)]
struct Failure {
    /// Carries its error code (see `llm::ERROR_CODES`).
    message: String,
    stage: Stage,
}

impl Failure {
    fn stream(message: String) -> Self {
        Self {
            message,
            stage: Stage::Stream,
        }
    }

    fn parse(message: String) -> Self {
        Self {
            message,
            stage: Stage::Parse,
        }
    }
}

/// Where an attempt stands: which service it is for, and whether a backup still waits behind it,
/// so that a failure the backup can answer need not be retried on the same service first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Turn {
    service: Service,
    backup_follows: bool,
}

/// A successful answer, and how it came about.
struct Answered<T> {
    value: T,
    service: Service,
    /// Why the backup was asked: the error code of the main service's failure.
    main_failure: Option<String>,
}

/// What to tell the user when the backup failed as well. The main service's failure leads: it is
/// the real reason, and its code - so its advice - stays. The backup's failure follows.
fn both_failed(main: Failure, backup: &Failure) -> Failure {
    let code = llm::error_code(&main.message).unwrap_or("unknown");
    Failure {
        message: llm::coded(
            code,
            format!(
                "{}；备用模型也失败了：{}",
                llm::error_detail(&main.message),
                llm::error_detail(&backup.message)
            ),
        ),
        stage: main.stage,
    }
}

/// Ask the main service and, only when that fails in a way another service may fix (see
/// `llm::another_provider_may_help`), the backup, once. `ask` makes one complete attempt at the
/// service it is given. Whatever is not worth a second opinion is returned as it was.
async fn ask_services<T, Fut>(
    main: &ModelTarget,
    backup: Option<&ModelTarget>,
    mut ask: impl FnMut(ModelTarget, Turn) -> Fut,
) -> Result<Answered<T>, Failure>
where
    Fut: std::future::Future<Output = Result<T, Failure>>,
{
    let first = Turn {
        service: Service::Main,
        backup_follows: backup.is_some(),
    };
    let main_failure = match ask(main.clone(), first).await {
        Ok(value) => {
            return Ok(Answered {
                value,
                service: Service::Main,
                main_failure: None,
            })
        }
        Err(failure) => failure,
    };
    let Some(backup) = backup.filter(|_| llm::another_provider_may_help(&main_failure.message))
    else {
        return Err(main_failure);
    };

    let code = llm::error_code(&main_failure.message)
        .unwrap_or("unknown")
        .to_string();
    eprintln!("[lookup] the main service failed ({code}); asking the backup");
    let second = Turn {
        service: Service::Backup,
        backup_follows: false,
    };
    match ask(backup.clone(), second).await {
        Ok(value) => Ok(Answered {
            value,
            service: Service::Backup,
            main_failure: Some(code),
        }),
        Err(failure) => Err(both_failed(main_failure, &failure)),
    }
}

/// One attempt at answering with `target`, without streaming.
async fn ask_once(
    target: &ModelTarget,
    request: LookupRequest<'_>,
    template_body: &str,
) -> Result<Reply, Failure> {
    let LookupRequest {
        selection,
        context,
        kind,
    } = request;
    eprintln!(
        "[lookup_word] {} model={:?} protocol={:?} timeout={}s tpl_len={}, calling LLM...",
        selection_meta(selection, kind),
        target.model,
        target.protocol,
        target.timeout_secs,
        template_body.len()
    );

    let raw = llm::stream_lookup(target.model_call(), selection, context, template_body)
        .await
        .map_err(|e| {
            let classified = classify_lookup_error(&e);
            eprintln!("[lookup_word] LLM ERROR: {classified}");
            Failure::stream(classified)
        })?;
    eprintln!("[lookup_word] LLM OK, len={}", raw.len());

    let entry = llm::parse_entry(&raw, selection, kind).map_err(|e| {
        eprintln!("[lookup_word] parse FAIL: {e}");
        Failure::parse(classify_lookup_error(&e))
    })?;
    Ok(Reply {
        entry,
        raw,
        model: target.model.clone(),
        after_stream_retry: false,
    })
}

/// Whether a stream that failed with `error` is worth one more request to the same service,
/// without streaming (some gateways cannot stream). It is not once something has been shown, and
/// not when a backup is about to be asked anyway: a service that is busy, slow or down would only
/// make the user wait twice.
fn retry_without_streaming(saw_content: bool, error: &str, backup_follows: bool) -> bool {
    should_fallback_stream(saw_content)
        && !(backup_follows && llm::another_provider_may_help(error))
}

/// One attempt at answering with `target`, streamed to the window of `request_id`.
async fn stream_attempt(
    app: &tauri::AppHandle,
    request_id: &str,
    target: &ModelTarget,
    turn: Turn,
    request: LookupRequest<'_>,
    template_body: &str,
) -> Result<Reply, Failure> {
    let LookupRequest {
        selection,
        context,
        kind,
    } = request;
    eprintln!(
        "[lookup_stream] starting SSE ({:?}), url={}",
        turn.service, target.base_url
    );

    let mut extractor = llm::IncrementalJsonExtractor::new();
    let mut saw_stream_content = false;
    let stream_started = std::time::Instant::now();
    let mut first_field_logged = false;
    let streamed = llm::stream_lookup_sse(
        target.model_call(),
        selection,
        context,
        template_body,
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
                    app,
                    "lookup_stream_first_field",
                    serde_json::json!({
                        "ms_bucket": bucket,
                        "kind": kind,
                    }),
                );
            }
            for (field, value) in fields {
                let _ = app.emit(
                    "lookup://delta",
                    serde_json::json!({
                        "requestId": request_id,
                        "field": field,
                        "value": value,
                    }),
                );
            }
        },
    )
    .await
    .map_err(|e| classify_lookup_error(&e));

    let reply = |entry: serde_json::Value, raw: String, after_stream_retry: bool| Reply {
        entry,
        raw,
        model: target.model.clone(),
        after_stream_retry,
    };
    match streamed {
        Ok(full_text) => match llm::parse_entry(&full_text, selection, kind) {
            Ok(entry) => Ok(reply(entry, full_text, false)),
            Err(e) => Err(Failure::parse(classify_lookup_error(&e))),
        },
        Err(e) => {
            eprintln!("[lookup_stream] SSE failed: {e}");
            if retry_without_streaming(saw_stream_content, &e, turn.backup_follows) {
                eprintln!("[lookup_stream] falling back to one non-streaming request");
                crate::record_event_handle(app, "lookup_stream_fallback", serde_json::json!({}));
                match llm::stream_lookup(target.model_call(), selection, context, template_body)
                    .await
                {
                    Ok(full_text) => match llm::parse_entry(&full_text, selection, kind) {
                        Ok(entry) => return Ok(reply(entry, full_text, true)),
                        Err(parse_error) => {
                            eprintln!("[lookup_stream] fallback parse failed: {parse_error}");
                        }
                    },
                    Err(fallback_error) => {
                        eprintln!("[lookup_stream] fallback failed: {fallback_error}");
                    }
                }
            }
            Err(Failure::stream(e))
        }
    }
}

/// Count a lookup that the backup answered, and why it had to: only the kind of lookup and the
/// error code of the main service's failure are kept, never what was looked up.
fn note_backup_used(state: &AppState, kind: &str, reason: &str) {
    if let Ok(db) = state.db.lock() {
        let _ = db.record_local_event(
            "lookup_backup_used",
            &serde_json::json!({ "kind": kind, "reason": reason }),
        );
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Answer a prepared lookup without streaming: from the cache when it can, else from the model
/// services. Gives the entry and what it cost in estimated tokens (nothing, from the cache).
async fn answer_lookup(
    state: &tauri::State<'_, AppState>,
    mut prepared: PreparedLookup,
    request: LookupRequest<'_>,
) -> Result<(serde_json::Value, u32), String> {
    if let Some(cached) = prepared.cache_hit.take() {
        eprintln!("[lookup_word] cache HIT");
        return Ok((
            finish_lookup(state, &prepared, request, cached, Answer::Cache),
            0,
        ));
    }

    let template_body = prepared.template_body.as_str();
    let Answered {
        value: reply,
        service,
        main_failure,
    } = ask_services(
        &prepared.main,
        prepared.backup.as_ref(),
        |target, _turn| async move { ask_once(&target, request, template_body).await },
    )
    .await
    .map_err(|failure| failure.message)?;
    if let Some(reason) = main_failure.filter(|_| prepared.asker == Asker::User) {
        note_backup_used(state, request.kind, &reason);
    }

    let prompt = llm::build_prompt(&prepared.template_body, request.selection, request.context);
    let tokens = llm::estimate_lookup_tokens(&prompt, &reply.raw);
    let answer = Answer::Model {
        prompt: &prompt,
        raw: &reply.raw,
        model: &reply.model,
        service,
    };
    eprintln!("[lookup_word] done, returning entry");
    Ok((
        finish_lookup(state, &prepared, request, reply.entry, answer),
        tokens,
    ))
}

#[tauri::command]
pub async fn lookup_word(
    state: tauri::State<'_, AppState>,
    selection: String,
    context: String,
    kind: String,
    force_refresh: bool,
) -> Result<serde_json::Value, String> {
    let prepared = prepare_lookup(
        &state,
        &selection,
        &context,
        &kind,
        force_refresh,
        "lookup_word",
        Asker::User,
    )?;
    let request = LookupRequest {
        selection: &selection,
        context: &context,
        kind: &kind,
    };
    answer_lookup(&state, prepared, request)
        .await
        .map(|(entry, _tokens)| entry)
}

/// Ask for the entry of a word that is already in the library, for the batch enrichment of the
/// words that were imported bare. What the model answers is as good as a lookup's, but it is not
/// one the user made: it leaves no history, adds no lookup to the day's count and does not move
/// the cache statistics. What it costs is counted. Gives the entry and its estimated tokens.
pub(crate) async fn lookup_for_enrichment(
    state: &tauri::State<'_, AppState>,
    selection: &str,
    context: &str,
    kind: &str,
) -> Result<(serde_json::Value, u32), String> {
    let prepared = prepare_lookup(
        state,
        selection,
        context,
        kind,
        false,
        "enrich",
        Asker::Batch,
    )?;
    let request = LookupRequest {
        selection,
        context,
        kind,
    };
    answer_lookup(state, prepared, request).await
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
        Asker::User,
    )?;
    let request = LookupRequest {
        selection: &selection,
        context: &context,
        kind: &kind,
    };

    if let Some(cached) = prepared.cache_hit.take() {
        eprintln!("[lookup_stream] cache HIT");
        let entry = finish_lookup(&state, &prepared, request, cached, Answer::Cache);
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

    let app_ref = &app;
    let request_id_ref = request_id.as_str();
    let template_body = prepared.template_body.as_str();
    let answered = ask_services(
        &prepared.main,
        prepared.backup.as_ref(),
        move |target, turn| async move {
            stream_attempt(
                app_ref,
                request_id_ref,
                &target,
                turn,
                request,
                template_body,
            )
            .await
        },
    )
    .await;

    match answered {
        Ok(Answered {
            value: reply,
            service,
            main_failure,
        }) => {
            if let Some(reason) = main_failure {
                note_backup_used(&state, &kind, &reason);
            }
            let prompt = llm::build_prompt(&prepared.template_body, &selection, &context);
            let answer = Answer::Model {
                prompt: &prompt,
                raw: &reply.raw,
                model: &reply.model,
                service,
            };
            let entry = finish_lookup(&state, &prepared, request, reply.entry, answer);
            let mut done = serde_json::json!({
                "requestId": request_id,
                "entry": entry,
                "raw": reply.raw,
                "fromCache": false,
            });
            if reply.after_stream_retry {
                done["fallback"] = serde_json::Value::Bool(true);
            }
            let _ = app.emit("lookup://done", done);
            Ok(())
        }
        Err(failure) => {
            let _ = app.emit(
                "lookup://error",
                serde_json::json!({
                    "requestId": request_id,
                    "stage": failure.stage.as_str(),
                    "message": failure.message,
                    "retryable": true,
                }),
            );
            Err(failure.message)
        }
    }
}

/// Test a connection with what the settings page sent. With `backup`, the key that is stored for
/// the backup service stands in for the placeholder, not the main service's.
#[tauri::command]
pub async fn test_connection(
    state: tauri::State<'_, AppState>,
    base_url: String,
    api_key: String,
    model: String,
    protocol: Option<String>,
    backup: Option<bool>,
) -> Result<serde_json::Value, String> {
    let proto = protocol.as_deref().unwrap_or("openai");
    let settings_key = if backup.unwrap_or(false) {
        "backupProvider"
    } else {
        "provider"
    };
    let api_key = resolve_api_key_for_request(&state, &api_key, settings_key)?;
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

    fn state_with_capture(capture: Option<serde_json::Value>) -> AppState {
        AppState {
            db: std::sync::Mutex::new(db::Database::open_memory().unwrap()),
            last_capture: std::sync::Mutex::new(capture),
            watch: crate::watch_switch::WatchSwitch::new(true),
            show_watch_mark: std::sync::Mutex::new(None),
            last_looked_up: std::sync::Mutex::new(None),
            startup_warnings: std::sync::Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn the_source_is_only_credited_when_the_capture_is_the_text_looked_up() {
        let capture = serde_json::json!({
            "selection": " running ",
            "sourceApp": "chrome.exe",
            "sourceTitle": "News",
        });
        let state = state_with_capture(Some(capture));

        let source = capture_source(&state, "running");
        assert_eq!(
            (source.app.as_str(), source.title.as_str()),
            ("chrome.exe", "News")
        );

        let stale = capture_source(&state, "something else");
        assert!(stale.app.is_empty() && stale.title.is_empty());
        assert!(capture_source(&state_with_capture(None), "running")
            .app
            .is_empty());
    }

    #[test]
    fn an_answered_lookup_is_remembered_with_what_the_answer_says() {
        let db = db::Database::open_memory().unwrap();
        db.initialize().unwrap();
        let entry = serde_json::json!({ "lemma": "run", "translation": "跑" });
        let request = LookupRequest {
            selection: "running",
            context: "He was running late.",
            kind: "word",
        };
        let source = CaptureSource {
            app: "chrome.exe".into(),
            title: "News".into(),
        };
        remember_lookup(&db, request, &entry, &source);

        let list = db.list_history().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["selection"], "running");
        assert_eq!(list[0]["lemma"], "run");
        assert_eq!(list[0]["translation"], "跑");
        assert_eq!(list[0]["sourceApp"], "chrome.exe");
        let question = db
            .history_lookup(list[0]["id"].as_i64().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(question["context"], "He was running late.");
    }

    // -- the main service and the backup ------------------------------------

    fn main_target() -> ModelTarget {
        ModelTarget {
            base_url: "https://api.main.example/v1".into(),
            api_key: "sk-main".into(),
            model: "main-model".into(),
            protocol: "openai".into(),
            temperature: 0.3,
            max_tokens: 1200,
            timeout_secs: 60,
        }
    }

    fn complete_backup() -> serde_json::Value {
        serde_json::json!({
            "enabled": true,
            "name": "Backup",
            "protocol": "openai",
            "baseUrl": "https://api.backup.example/v1",
            "model": "backup-model",
            "apiKey": "stored-backup-key",
            "temperature": 0.5,
            "maxTokens": 1500,
            "timeoutSeconds": 45
        })
    }

    fn settings_with_backup(backup: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "provider": { "model": "main-model" }, "backupProvider": backup })
    }

    fn plain(stored: &str) -> String {
        stored.to_string()
    }

    #[test]
    fn a_provider_of_the_settings_becomes_the_target_of_a_lookup() {
        let provider = serde_json::json!({
            "baseUrl": "https://api.example.com/v1",
            "model": "m1",
            "protocol": "anthropic",
            "temperature": 0.7,
            "maxTokens": 900,
            "timeoutSeconds": 45
        });
        assert_eq!(
            model_target(&provider, "word", "sk-1".into()),
            ModelTarget {
                base_url: "https://api.example.com/v1".into(),
                api_key: "sk-1".into(),
                model: "m1".into(),
                protocol: "anthropic".into(),
                temperature: 0.7,
                max_tokens: 900,
                timeout_secs: 45,
            }
        );

        // What the settings do not say is what a fresh install has.
        let bare = model_target(&serde_json::json!({}), "word", String::new());
        assert_eq!(bare.protocol, "openai");
        assert_eq!(bare.temperature, 0.3);
        assert_eq!((bare.max_tokens, bare.timeout_secs), (1200, 60));
    }

    #[test]
    fn long_texts_and_deepseek_get_the_room_they_need() {
        let provider = serde_json::json!({
            "baseUrl": "https://api.example.com",
            "maxTokens": 800,
            "timeoutSeconds": 30
        });
        let paragraph = model_target(&provider, "paragraph", "k".into());
        assert_eq!((paragraph.max_tokens, paragraph.timeout_secs), (4000, 120));
        let sentence = model_target(&provider, "sentence", "k".into());
        assert_eq!((sentence.max_tokens, sentence.timeout_secs), (800, 30));

        let deepseek =
            serde_json::json!({ "baseUrl": "https://API.DeepSeek.com", "maxTokens": 800 });
        assert_eq!(model_target(&deepseek, "word", "k".into()).max_tokens, 3000);

        // Asking for more than the minimum is the user's call.
        let generous = serde_json::json!({
            "baseUrl": "https://api.deepseek.com",
            "maxTokens": 3500,
            "timeoutSeconds": 200
        });
        let target = model_target(&generous, "paragraph", "k".into());
        assert_eq!((target.max_tokens, target.timeout_secs), (4000, 200));

        // An older settings page stored the timeout as a fraction.
        let fractional = serde_json::json!({ "timeoutSeconds": 45.0 });
        assert_eq!(
            model_target(&fractional, "word", "k".into()).timeout_secs,
            45
        );
    }

    #[test]
    fn a_target_never_shows_its_key_when_it_is_printed() {
        let printed = format!("{:?}", main_target());
        assert!(!printed.contains("sk-main"), "{printed}");
        assert!(printed.contains("main-model"), "{printed}");
    }

    #[test]
    fn there_is_no_backup_unless_it_is_turned_on() {
        let main = main_target();
        let asked = std::cell::Cell::new(0);
        let decrypt = |stored: &str| {
            asked.set(asked.get() + 1);
            stored.to_string()
        };

        let with = |changes: serde_json::Value| {
            let mut backup = complete_backup();
            for (key, value) in changes.as_object().unwrap() {
                backup[key.as_str()] = value.clone();
            }
            settings_with_backup(backup)
        };
        let mut without_the_flag = complete_backup();
        without_the_flag.as_object_mut().unwrap().remove("enabled");
        let cases = [
            serde_json::json!({ "provider": {} }),
            with(serde_json::json!({ "enabled": false })),
            // Only a real `true` switches it on.
            with(serde_json::json!({ "enabled": "true" })),
            with(serde_json::json!({ "enabled": 1 })),
            with(serde_json::json!({ "enabled": null })),
            settings_with_backup(without_the_flag),
        ];
        for settings in &cases {
            assert_eq!(
                backup_target(settings, "word", &main, decrypt),
                None,
                "{settings}"
            );
        }
        // A backup that is off is not even decrypted: its key stays untouched.
        assert_eq!(asked.get(), 0);
    }

    #[test]
    fn a_complete_backup_is_a_target_with_its_own_key_and_limits() {
        let main = main_target();
        let settings = settings_with_backup(complete_backup());

        let target = backup_target(&settings, "word", &main, |stored| {
            format!("decrypted:{stored}")
        })
        .expect("a complete backup is a backup");
        assert_eq!(
            target,
            ModelTarget {
                base_url: "https://api.backup.example/v1".into(),
                api_key: "decrypted:stored-backup-key".into(),
                model: "backup-model".into(),
                protocol: "openai".into(),
                temperature: 0.5,
                max_tokens: 1500,
                timeout_secs: 45,
            }
        );

        // What a long text needs, it needs from the backup too.
        let paragraph = backup_target(&settings, "paragraph", &main, plain).unwrap();
        assert_eq!((paragraph.max_tokens, paragraph.timeout_secs), (4000, 120));
    }

    #[test]
    fn a_half_filled_backup_is_not_a_backup() {
        let main = main_target();
        for (field, value) in [
            ("baseUrl", ""),
            ("baseUrl", "   "),
            ("model", ""),
            ("model", " "),
            ("apiKey", ""),
        ] {
            let mut backup = complete_backup();
            backup[field] = serde_json::json!(value);
            let settings = settings_with_backup(backup);
            assert_eq!(
                backup_target(&settings, "word", &main, plain),
                None,
                "{field}={value:?}"
            );
        }

        let settings = settings_with_backup(complete_backup());
        // A key that is still ciphertext could not be read by this Windows user...
        assert_eq!(
            backup_target(&settings, "word", &main, |_| "dpapi:v1:AAAA".to_string()),
            None
        );
        // ...and one that was read as nothing is not a key.
        assert_eq!(
            backup_target(&settings, "word", &main, |_| String::new()),
            None
        );
    }

    #[test]
    fn the_main_service_is_not_its_own_backup() {
        let main = main_target();
        let same = settings_with_backup(serde_json::json!({
            "enabled": true,
            "baseUrl": "https://api.main.example/v1/",
            "model": " main-model ",
            "apiKey": "sk-main"
        }));
        assert_eq!(backup_target(&same, "word", &main, plain), None);

        // Another model, another service, or another key for the same service is worth asking:
        // an account can be out of quota while its sibling is not.
        for change in [
            ("model", "other-model"),
            ("baseUrl", "https://api.other.example/v1"),
            ("apiKey", "sk-second-account"),
        ] {
            let mut backup = serde_json::json!({
                "enabled": true,
                "baseUrl": "https://api.main.example/v1",
                "model": "main-model",
                "apiKey": "sk-main"
            });
            backup[change.0] = serde_json::json!(change.1);
            let settings = settings_with_backup(backup);
            assert!(
                backup_target(&settings, "word", &main, plain).is_some(),
                "{change:?}"
            );
        }
    }

    #[test]
    fn an_answer_says_which_model_wrote_it_and_whether_that_was_the_backup() {
        let mut from_main = serde_json::json!({ "lemma": "resilient" });
        annotate_answering_model(&mut from_main, "main-model", Service::Main);
        assert_eq!(from_main["_model"], "main-model");
        assert!(from_main.get("_viaBackup").is_none());

        let mut from_backup = serde_json::json!({ "lemma": "resilient" });
        annotate_answering_model(&mut from_backup, "backup-model", Service::Backup);
        assert_eq!(from_backup["_model"], "backup-model");
        assert_eq!(from_backup["_viaBackup"], true);
        assert_eq!(from_backup["lemma"], "resilient");
    }

    // -- wrapping up an answer -----------------------------------------------

    fn ready_state() -> AppState {
        let state = state_with_capture(None);
        state.db.lock().unwrap().initialize().unwrap();
        state
    }

    fn prepared_with_backup() -> PreparedLookup {
        PreparedLookup {
            main: main_target(),
            backup: Some(ModelTarget {
                model: "backup-model".into(),
                ..main_target()
            }),
            template_body: "Explain {{selection}}".into(),
            template_name: "标准模板 [word]".into(),
            cache_key: "key-under-the-main-model".into(),
            cache_hit: None,
            record_history: true,
            asker: Asker::User,
        }
    }

    /// The same preparation as one that the batch enrichment makes: no history is kept for it.
    fn prepared_for_a_batch() -> PreparedLookup {
        PreparedLookup {
            record_history: false,
            asker: Asker::Batch,
            ..prepared_with_backup()
        }
    }

    const REQUEST: LookupRequest<'static> = LookupRequest {
        selection: "running",
        context: "He was running late.",
        kind: "word",
    };

    #[test]
    fn what_the_backup_wrote_is_labelled_kept_under_the_main_key_and_counted_once() {
        let state = ready_state();
        let answer = Answer::Model {
            prompt: "Explain running",
            raw: "{\"lemma\":\"run\"}",
            model: "backup-model",
            service: Service::Backup,
        };

        let entry = serde_json::json!({ "lemma": "run", "translation": "跑" });
        let finished = finish_lookup(&state, &prepared_with_backup(), REQUEST, entry, answer);

        assert_eq!(finished["_model"], "backup-model");
        assert_eq!(finished["_viaBackup"], true);
        assert_eq!(finished["_templateName"], "标准模板 [word]");
        let db = state.db.lock().unwrap();
        // Asked again soon, the lookup is a cache hit that still says who wrote it.
        let cached = db
            .get_cache("key-under-the-main-model", 30)
            .unwrap()
            .expect("kept under the key of the main service");
        assert_eq!(cached["_model"], "backup-model");
        assert_eq!(cached["_viaBackup"], true);
        // One lookup that cost something, and one line in the history.
        let usage = db.get_usage().unwrap();
        assert_eq!(usage["today"], 1);
        assert!(usage["tokens"].as_i64().unwrap() > 0);
        assert_eq!(db.list_history().unwrap().len(), 1);
    }

    #[test]
    fn what_the_main_service_wrote_is_not_labelled_as_a_backup() {
        let state = ready_state();
        let answer = Answer::Model {
            prompt: "Explain running",
            raw: "{\"lemma\":\"run\"}",
            model: "main-model",
            service: Service::Main,
        };

        let entry = serde_json::json!({ "lemma": "run" });
        let finished = finish_lookup(&state, &prepared_with_backup(), REQUEST, entry, answer);

        assert_eq!(finished["_model"], "main-model");
        assert!(finished.get("_viaBackup").is_none());
        let cached = state
            .db
            .lock()
            .unwrap()
            .get_cache("key-under-the-main-model", 30)
            .unwrap()
            .unwrap();
        assert!(cached.get("_viaBackup").is_none());
    }

    #[test]
    fn a_cache_hit_is_returned_as_it_was_kept_and_costs_nothing() {
        let state = ready_state();
        let kept = serde_json::json!({ "lemma": "run", "_model": "old-model", "fromCache": true });

        let finished = finish_lookup(
            &state,
            &prepared_with_backup(),
            REQUEST,
            kept.clone(),
            Answer::Cache,
        );

        assert_eq!(finished, kept);
        let db = state.db.lock().unwrap();
        let usage = db.get_usage().unwrap();
        assert_eq!(
            (usage["today"].as_i64(), usage["tokens"].as_i64()),
            (Some(1), Some(0))
        );
        // Nothing new was written to the cache.
        assert!(db
            .get_cache("key-under-the-main-model", 30)
            .unwrap()
            .is_none());
    }

    #[test]
    fn what_a_batch_asks_costs_tokens_but_is_not_a_lookup_the_user_made() {
        let state = ready_state();
        let answer = Answer::Model {
            prompt: "Explain running",
            raw: "{\"lemma\":\"run\"}",
            model: "main-model",
            service: Service::Main,
        };

        let entry = serde_json::json!({ "lemma": "run", "translation": "跑" });
        let finished = finish_lookup(&state, &prepared_for_a_batch(), REQUEST, entry, answer);

        // It is still an answer from the model, kept for next time like any other...
        assert_eq!(finished["_model"], "main-model");
        let db = state.db.lock().unwrap();
        assert!(db
            .get_cache("key-under-the-main-model", 30)
            .unwrap()
            .is_some());
        // ...paid for in tokens, but neither a lookup of the day nor a line in the history.
        let usage = db.get_usage().unwrap();
        assert_eq!(usage["today"], 0);
        assert_eq!(usage["month"], 0);
        assert!(usage["tokens"].as_i64().unwrap() > 0);
        assert!(db.tokens_today().unwrap() > 0);
        assert!(db.list_history().unwrap().is_empty());
    }

    #[test]
    fn a_lookup_the_backup_answered_is_counted_by_why_it_was_needed() {
        let state = ready_state();
        note_backup_used(&state, "word", "timeout");
        note_backup_used(&state, "sentence", "rate_limit");

        let metrics = state.db.lock().unwrap().get_local_metrics(7).unwrap();
        assert_eq!(metrics["backupUsed"], 2);
    }

    #[cfg(windows)]
    #[test]
    fn a_placeholder_resolves_to_the_key_that_is_stored_for_that_service() {
        let state = ready_state();
        state
            .db
            .lock()
            .unwrap()
            .save_settings(&serde_json::json!({
                "provider": { "apiKey": dpapi::encrypt("sk-main-secret").unwrap() },
                "backupProvider": { "apiKey": dpapi::encrypt("sk-backup-secret").unwrap() },
            }))
            .unwrap();

        for sent in [API_KEY_PLACEHOLDER, ""] {
            assert_eq!(
                resolve_api_key_for_request(&state, sent, "provider").unwrap(),
                "sk-main-secret"
            );
            assert_eq!(
                resolve_api_key_for_request(&state, sent, "backupProvider").unwrap(),
                "sk-backup-secret"
            );
        }
        // A key that was typed in is used as it is, for whichever service it is.
        assert_eq!(
            resolve_api_key_for_request(&state, "sk-typed", "backupProvider").unwrap(),
            "sk-typed"
        );
        // Nothing is stored for a service that was never set up.
        let error =
            resolve_api_key_for_request(&state, API_KEY_PLACEHOLDER, "unknown").unwrap_err();
        assert_eq!(llm::error_code(&error), Some("no_key"));
    }

    // -- asking one service after the other -----------------------------------

    fn failure(code: &str, detail: &str) -> Failure {
        Failure::stream(llm::coded(code, detail))
    }

    type Calls = Vec<(String, Turn)>;

    /// Run `ask_services` with an `ask` that answers from `script`, and remember whom it was asked.
    async fn run(
        with_backup: bool,
        script: impl Fn(&ModelTarget) -> Result<&'static str, Failure>,
    ) -> (Result<Answered<&'static str>, Failure>, Calls) {
        let main = main_target();
        let backup = with_backup.then(|| ModelTarget {
            model: "backup-model".into(),
            ..main_target()
        });
        let calls = std::cell::RefCell::new(Vec::new());
        let result = ask_services(&main, backup.as_ref(), |target, turn| {
            calls.borrow_mut().push((target.model.clone(), turn));
            std::future::ready(script(&target))
        })
        .await;
        (result, calls.into_inner())
    }

    fn turn(service: Service, backup_follows: bool) -> Turn {
        Turn {
            service,
            backup_follows,
        }
    }

    #[tokio::test]
    async fn the_backup_is_not_asked_while_the_main_service_answers() {
        let (result, calls) = run(true, |_| Ok("from main")).await;

        let answered = result.unwrap();
        assert_eq!(answered.value, "from main");
        assert_eq!(answered.service, Service::Main);
        assert_eq!(answered.main_failure, None);
        assert_eq!(
            calls,
            vec![("main-model".to_string(), turn(Service::Main, true))]
        );
    }

    #[tokio::test]
    async fn a_struggling_main_service_is_followed_by_the_backup_which_is_asked_once() {
        for code in ["rate_limit", "server", "timeout", "network"] {
            let (result, calls) = run(true, |target| {
                if target.model == "main-model" {
                    Err(failure(code, "down"))
                } else {
                    Ok("from backup")
                }
            })
            .await;

            let answered = result.unwrap();
            assert_eq!(answered.value, "from backup", "{code}");
            assert_eq!(answered.service, Service::Backup, "{code}");
            assert_eq!(answered.main_failure.as_deref(), Some(code));
            assert_eq!(
                calls,
                vec![
                    ("main-model".to_string(), turn(Service::Main, true)),
                    ("backup-model".to_string(), turn(Service::Backup, false)),
                ],
                "{code}"
            );
        }
    }

    #[tokio::test]
    async fn a_failure_that_another_service_cannot_fix_is_not_hidden_behind_the_backup() {
        for code in [
            "no_key",
            "auth",
            "model",
            "http",
            "parse",
            "empty",
            "truncated",
            "api",
            "internal",
            "unknown",
        ] {
            let (result, calls) = run(true, |_| Err(failure(code, "x"))).await;

            assert_eq!(result.err().unwrap(), failure(code, "x"), "{code}");
            assert_eq!(calls.len(), 1, "{code}: the backup must not be asked");
        }
    }

    #[tokio::test]
    async fn without_a_backup_the_failure_is_returned_as_it_was() {
        let (result, calls) = run(false, |_| Err(failure("server", "down"))).await;

        assert_eq!(result.err().unwrap(), failure("server", "down"));
        // Nothing follows, so a failure of the main service is its own to retry.
        assert_eq!(
            calls,
            vec![("main-model".to_string(), turn(Service::Main, false))]
        );
    }

    #[tokio::test]
    async fn when_the_backup_fails_too_both_are_reported_under_the_code_of_the_main_service() {
        let (result, calls) = run(true, |target| {
            if target.model == "main-model" {
                Err(failure("rate_limit", "太忙了"))
            } else {
                Err(Failure::parse(llm::coded("auth", "Key 无效")))
            }
        })
        .await;

        let failed = result.err().unwrap();
        assert_eq!(
            failed.message,
            "[rate_limit] 太忙了；备用模型也失败了：Key 无效"
        );
        assert_eq!(failed.stage, Stage::Stream);
        assert_eq!(calls.len(), 2);
        // The advice the user gets is that of the main service's failure.
        assert_eq!(llm::error_code(&failed.message), Some("rate_limit"));
    }

    #[test]
    fn a_stream_is_retried_on_the_same_service_only_when_no_backup_is_about_to_answer() {
        let err = |code: &str| llm::coded(code, "x");

        // As it was before backups existed: nothing shown yet, so one more try, without streaming.
        for code in ["rate_limit", "http", "auth", "network"] {
            assert!(retry_without_streaming(false, &err(code), false), "{code}");
        }
        // Once something has been shown, the stream is not started over.
        assert!(!retry_without_streaming(true, &err("network"), false));
        assert!(!retry_without_streaming(true, &err("http"), true));
        // A backup will answer what a backup can answer, so the same service is not asked twice...
        for code in ["rate_limit", "server", "timeout", "network"] {
            assert!(!retry_without_streaming(false, &err(code), true), "{code}");
        }
        // ...but a gateway that cannot stream is still tried without streaming first.
        for code in ["http", "auth", "model", "empty", "parse", "unknown"] {
            assert!(retry_without_streaming(false, &err(code), true), "{code}");
        }
    }
}
