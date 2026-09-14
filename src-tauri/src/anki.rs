//! AnkiConnect client (localhost only). Disabled by default; no network unless enabled.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AnkiFieldMap {
    pub front: String,
    pub back: String,
    pub extra: String,
    pub examples: String,
}

impl Default for AnkiFieldMap {
    fn default() -> Self {
        Self {
            front: "Front".into(),
            back: "Back".into(),
            extra: "Extra".into(),
            examples: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub deck: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_auto_send")]
    pub auto_send: bool,
    #[serde(default)]
    pub field_map: AnkiFieldMap,
    #[serde(default = "default_include_examples_in_extra")]
    pub include_examples_in_extra: bool,
}

fn default_enabled() -> bool {
    false
}
fn default_host() -> String {
    "127.0.0.1".into()
}
fn default_port() -> u16 {
    8765
}
fn default_auto_send() -> bool {
    false
}
fn default_include_examples_in_extra() -> bool {
    true
}

impl Default for AnkiConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            host: default_host(),
            port: default_port(),
            deck: "Default".into(),
            model: "Basic".into(),
            auto_send: false,
            field_map: AnkiFieldMap::default(),
            include_examples_in_extra: true,
        }
    }
}

impl AnkiConfig {
    pub fn from_settings(settings: &Value) -> Self {
        settings
            .get("anki")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    pub fn endpoint(&self) -> String {
        let host = if self.host.is_empty() {
            "127.0.0.1"
        } else {
            self.host.as_str()
        };
        // Enforce loopback-only unless explicitly localhost name.
        if host != "127.0.0.1" && host != "localhost" && host != "::1" {
            return format!("http://127.0.0.1:{}/", self.port);
        }
        format!("http://{host}:{}/", self.port)
    }
}

pub async fn invoke_action(endpoint: &str, action: &str, params: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "action": action,
        "version": 6,
        "params": params,
    });
    let resp = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AnkiConnect 连接失败（请确认 Anki 已启动）: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("AnkiConnect HTTP {}", resp.status()));
    }
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("AnkiConnect 响应无效: {e}"))?;
    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
        if !err.is_empty() && err != "null" {
            return Err(err.to_string());
        }
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

pub async fn test_connection(config: &AnkiConfig) -> Result<Value, String> {
    let endpoint = config.endpoint();
    let version = invoke_action(&endpoint, "version", json!({})).await?;
    // requestPermission may prompt; use version as lightweight probe.
    Ok(json!({
        "ok": true,
        "version": version,
        "endpoint": endpoint,
    }))
}

pub async fn list_decks(config: &AnkiConfig) -> Result<Vec<String>, String> {
    let result = invoke_action(&config.endpoint(), "deckNames", json!({})).await?;
    Ok(result
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default())
}

pub async fn list_models(config: &AnkiConfig) -> Result<Vec<String>, String> {
    let result = invoke_action(&config.endpoint(), "modelNames", json!({})).await?;
    Ok(result
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default())
}

/// Returns (front, back, extra, example_only, tags).
/// `example_only` is non-empty only when a dedicated examples field is configured.
fn build_note_fields(
    word: &Value,
    config: &AnkiConfig,
) -> (String, String, String, String, Vec<String>) {
    let lemma = word
        .get("lemma")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let translation = word
        .get("translation")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let context = word
        .get("contextMeaning")
        .or_else(|| word.get("context_meaning"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let explanation = word
        .get("explanation")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut back = translation.to_string();
    if !context.is_empty() {
        if !back.is_empty() {
            back.push_str("\n\n");
        }
        back.push_str(context);
    }

    let mut examples_block = String::new();
    if let Some(examples) = word.get("examples").and_then(|v| v.as_array()) {
        for ex in examples.iter().take(3) {
            let en = ex.get("en").and_then(|v| v.as_str()).unwrap_or("");
            let zh = ex.get("zh").and_then(|v| v.as_str()).unwrap_or("");
            if !en.is_empty() {
                if !examples_block.is_empty() {
                    examples_block.push('\n');
                }
                examples_block.push_str("• ");
                examples_block.push_str(en);
                if !zh.is_empty() {
                    examples_block.push_str(" — ");
                    examples_block.push_str(zh);
                }
            }
        }
    }

    let dedicated_examples = !config.field_map.examples.trim().is_empty();
    let mut extra = explanation.to_string();
    if dedicated_examples {
        // examples go to their own field
    } else if config.include_examples_in_extra && !examples_block.is_empty() {
        if !extra.is_empty() {
            extra.push('\n');
        }
        extra.push_str(&examples_block);
    }
    let example_only = if dedicated_examples {
        examples_block
    } else {
        String::new()
    };

    let mut tags = vec!["gege-dictionary".to_string()];
    if let Some(app) = word.get("sourceApp").and_then(|v| v.as_str()) {
        if !app.is_empty() {
            let t: String = app
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '_' })
                .collect();
            tags.push(format!("src_{t}"));
        }
    }
    if let Some(list) = word.get("tags").and_then(|v| v.as_array()) {
        for t in list.iter().filter_map(|v| v.as_str()).take(8) {
            let safe: String = t
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '_' })
                .collect();
            if !safe.is_empty() {
                tags.push(safe);
            }
        }
    }
    (lemma, back, extra, example_only, tags)
}

fn insert_field(fields: &mut serde_json::Map<String, Value>, name: &str, value: String) {
    let key = name.trim();
    if key.is_empty() || value.is_empty() {
        return;
    }
    fields.insert(key.to_string(), json!(value));
}

/// Send words to Anki. `items` are `(word_id, word_json)`.
/// Returns report including `results: [{wordId, noteId, lemma}]` for persistence.
pub async fn send_words(config: &AnkiConfig, items: &[(String, Value)]) -> Result<Value, String> {
    if !config.enabled {
        return Err("[anki_disabled] Anki 同步未开启".into());
    }
    if config.deck.is_empty() || config.model.is_empty() {
        return Err("[anki_config] 请先选择 Anki 牌组与笔记类型".into());
    }
    let endpoint = config.endpoint();
    let mut added = 0u32;
    let mut skipped = 0u32;
    let mut errors: Vec<String> = Vec::new();
    let mut results: Vec<Value> = Vec::new();

    for (word_id, word) in items {
        let (front, back, extra, example_only, tags) = build_note_fields(word, config);
        if front.is_empty() {
            skipped += 1;
            continue;
        }
        // Skip if we already stored a local note id and Anki still has it.
        if let Some(existing_id) = word.get("ankiNoteId").and_then(|v| v.as_i64()) {
            let info =
                invoke_action(&endpoint, "notesInfo", json!({ "notes": [existing_id] })).await;
            if let Ok(Value::Array(arr)) = info {
                if arr
                    .first()
                    .and_then(|n| n.get("noteId"))
                    .and_then(|v| v.as_i64())
                    .is_some()
                {
                    skipped += 1;
                    results.push(json!({
                        "wordId": word_id,
                        "noteId": existing_id,
                        "lemma": front,
                        "status": "skipped",
                    }));
                    continue;
                }
            }
        }

        // Dedup: exact Front field match in deck.
        let query = format!(
            "deck:\"{}\" Front:\"{}\"",
            config.deck.replace('"', ""),
            front.replace('"', "")
        );
        let existing = invoke_action(&endpoint, "findNotes", json!({ "query": query })).await;
        if let Ok(ids) = &existing {
            if let Some(arr) = ids.as_array() {
                if let Some(first) = arr.first().and_then(|v| v.as_i64()) {
                    skipped += 1;
                    results.push(json!({
                        "wordId": word_id,
                        "noteId": first,
                        "lemma": front,
                        "status": "skipped",
                    }));
                    continue;
                }
            }
        }

        let mut fields = serde_json::Map::new();
        insert_field(&mut fields, &config.field_map.front, front.clone());
        insert_field(&mut fields, &config.field_map.back, back.clone());
        insert_field(&mut fields, &config.field_map.extra, extra.clone());
        insert_field(
            &mut fields,
            &config.field_map.examples,
            example_only.clone(),
        );
        let params = json!({
            "note": {
                "deckName": config.deck,
                "modelName": config.model,
                "fields": fields,
                "tags": tags,
                "options": { "allowDuplicate": false },
            }
        });
        match invoke_action(&endpoint, "addNote", params).await {
            Ok(note_id) => {
                added += 1;
                results.push(json!({
                    "wordId": word_id,
                    "noteId": note_id.as_i64().or_else(|| note_id.as_u64().map(|v| v as i64)),
                    "lemma": front,
                    "status": "added",
                }));
            }
            Err(e) => {
                // Retry Front/Back only if model rejected extra fields.
                if extra.is_empty() && example_only.is_empty() {
                    errors.push(format!("{front}: {e}"));
                } else {
                    let mut basic = serde_json::Map::new();
                    insert_field(&mut basic, &config.field_map.front, front.clone());
                    insert_field(&mut basic, &config.field_map.back, back.clone());
                    let fallback = json!({
                        "note": {
                            "deckName": config.deck,
                            "modelName": config.model,
                            "fields": basic,
                            "tags": tags,
                            "options": { "allowDuplicate": false },
                        }
                    });
                    match invoke_action(&endpoint, "addNote", fallback).await {
                        Ok(note_id) => {
                            added += 1;
                            results.push(json!({
                                "wordId": word_id,
                                "noteId": note_id.as_i64().or_else(|| note_id.as_u64().map(|v| v as i64)),
                                "lemma": front,
                                "status": "added",
                            }));
                        }
                        Err(e2) => errors.push(format!("{front}: {e2}")),
                    }
                }
            }
        }
    }

    Ok(json!({
        "added": added,
        "skipped": skipped,
        "errors": errors,
        "results": results,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_config_is_disabled_loopback() {
        let c = AnkiConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.endpoint(), "http://127.0.0.1:8765/");
    }

    #[test]
    fn non_loopback_host_is_forced_to_loopback() {
        let mut c = AnkiConfig::default();
        c.host = "evil.example.com".into();
        assert!(c.endpoint().starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn build_note_fields_maps_lemma_and_tags() {
        let word = json!({
            "lemma": "constant",
            "translation": "恒定的",
            "contextMeaning": "常量",
            "explanation": "语言层面…",
            "sourceApp": "Code.exe",
            "tags": ["cpp"],
            "examples": [{"en": "const int x = 1;", "zh": "常量"}]
        });
        let config = AnkiConfig::default();
        let (front, back, extra, example_only, tags) = build_note_fields(&word, &config);
        assert_eq!(front, "constant");
        assert!(back.contains("恒定的"));
        assert!(back.contains("常量"));
        assert!(extra.contains("语言层面"));
        assert!(extra.contains("const int x = 1;"));
        assert!(example_only.is_empty());
        assert!(tags.iter().any(|t| t == "cpp"));
        assert!(tags.iter().any(|t| t.starts_with("src_")));
    }

    #[test]
    fn build_note_fields_dedicated_examples_field() {
        let word = json!({
            "lemma": "constant",
            "translation": "恒定的",
            "explanation": "语言层面…",
            "examples": [{"en": "const int x = 1;", "zh": "常量"}]
        });
        let mut config = AnkiConfig::default();
        config.field_map.examples = "Example".into();
        let (_, _, extra, example_only, _) = build_note_fields(&word, &config);
        assert!(extra.contains("语言层面"));
        assert!(!extra.contains("const int x = 1;"));
        assert!(example_only.contains("const int x = 1;"));
    }
}
