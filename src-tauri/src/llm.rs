use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

const SYSTEM_PROMPT: &str = "You are a precise English-Chinese lexicography assistant. CRITICAL RULES: 1) Respond with a single valid JSON object ONLY. 2) No markdown fences, no extra text before or after the JSON. 3) All string values must use \\n for newlines and \\\" for quotes. 4) Do NOT embed markdown code blocks (```) inside JSON strings. Use plain text or pseudocode instead. 5) No trailing commas.";

pub struct IncrementalJsonExtractor {
    buffer: String,
    emitted: HashSet<String>,
}

impl IncrementalJsonExtractor {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
            emitted: HashSet::new(),
        }
    }

    pub fn push(&mut self, chunk: &str) -> Vec<(String, Value)> {
        self.buffer.push_str(chunk);
        extract_complete_top_level_fields(&self.buffer)
            .into_iter()
            .filter(|(field, _)| self.emitted.insert(field.clone()))
            .collect()
    }
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut escaped = false;
    for (offset, byte) in bytes.iter().enumerate().skip(start + 1) {
        if escaped {
            escaped = false;
        } else if *byte == b'\\' {
            escaped = true;
        } else if *byte == b'"' {
            return Some(offset);
        }
    }
    None
}

fn composite_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut stack = vec![bytes[start]];
    let mut in_string = false;
    let mut escaped = false;
    for (i, byte) in bytes.iter().enumerate().skip(start + 1) {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' | b'[' => stack.push(*byte),
            b'}' if stack.last() == Some(&b'{') => {
                stack.pop();
            }
            b']' if stack.last() == Some(&b'[') => {
                stack.pop();
            }
            _ => {}
        }
        if stack.is_empty() {
            return Some(i);
        }
    }
    None
}

fn extract_complete_top_level_fields(input: &str) -> Vec<(String, Value)> {
    let bytes = input.as_bytes();
    let Some(mut i) = bytes.iter().position(|b| *b == b'{').map(|p| p + 1) else {
        return Vec::new();
    };
    let mut fields = Vec::new();
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'}' {
            break;
        }
        if bytes[i] != b'"' {
            break;
        }
        let Some(key_end) = string_end(bytes, i) else {
            break;
        };
        let Ok(key) = serde_json::from_str::<String>(&input[i..=key_end]) else {
            break;
        };
        i = key_end + 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b':' {
            break;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let value_start = i;
        let value_end = match bytes[i] {
            b'"' => string_end(bytes, i),
            b'{' | b'[' => composite_end(bytes, i),
            _ => bytes[i..]
                .iter()
                .position(|b| *b == b',' || *b == b'}')
                .map(|p| i + p),
        };
        let Some(mut end) = value_end else {
            break;
        };
        if !matches!(bytes[value_start], b'"' | b'{' | b'[') {
            if end == value_start {
                break;
            }
            end -= 1;
        }
        while end > value_start && bytes[end].is_ascii_whitespace() {
            end -= 1;
        }
        let Ok(value) = serde_json::from_str::<Value>(&input[value_start..=end]) else {
            break;
        };
        fields.push((key, value));
        i = end + 1;
    }
    fields
}

/// Infer the effective protocol from the explicit value and the base_url pattern.
fn effective_protocol<'a>(protocol: &'a str, base_url: &str) -> &'a str {
    if protocol == "anthropic" {
        return "anthropic";
    }
    if base_url.contains("/anthropic") || base_url.contains("anthropic.com") {
        return "anthropic";
    }
    protocol
}

fn is_deepseek(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("deepseek.com")
}

fn apply_provider_options(body: &mut Value, base_url: &str) {
    if is_deepseek(base_url) {
        body["thinking"] = serde_json::json!({ "type": "disabled" });
    }
}

/// Blocking (non-streaming) lookup — used as fallback or when streaming is disabled.
pub async fn stream_lookup(
    base_url: &str,
    api_key: &str,
    model: &str,
    protocol: &str,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    selection: &str,
    context: &str,
    _kind: &str,
    template_body: &str,
) -> Result<String, String> {
    let prompt = template_body
        .replace("{{selection}}", selection)
        .replace("{{context}}", context)
        .replace("{{native_lang}}", "中文");

    let proto = effective_protocol(protocol, base_url);
    eprintln!("[stream_lookup] protocol={protocol}, effective={proto}, url={base_url}");
    match proto {
        "anthropic" => {
            call_anthropic_blocking(
                base_url,
                api_key,
                model,
                temperature,
                max_tokens,
                timeout_secs,
                &prompt,
            )
            .await
        }
        _ => {
            call_openai_blocking(
                base_url,
                api_key,
                model,
                temperature,
                max_tokens,
                timeout_secs,
                &prompt,
            )
            .await
        }
    }
}

/// Streaming lookup — emits deltas through a callback, returns full text at the end.
pub async fn stream_lookup_sse<F>(
    base_url: &str,
    api_key: &str,
    model: &str,
    protocol: &str,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    selection: &str,
    context: &str,
    _kind: &str,
    template_body: &str,
    mut on_delta: F,
) -> Result<String, String>
where
    F: FnMut(&str),
{
    let prompt = template_body
        .replace("{{selection}}", selection)
        .replace("{{context}}", context)
        .replace("{{native_lang}}", "中文");

    let proto = effective_protocol(protocol, base_url);
    match proto {
        "anthropic" => {
            call_anthropic_streaming(
                base_url,
                api_key,
                model,
                temperature,
                max_tokens,
                timeout_secs,
                &prompt,
                &mut on_delta,
            )
            .await
        }
        _ => {
            call_openai_streaming(
                base_url,
                api_key,
                model,
                temperature,
                max_tokens,
                timeout_secs,
                &prompt,
                &mut on_delta,
            )
            .await
        }
    }
}

async fn call_openai_blocking(
    base_url: &str,
    api_key: &str,
    model: &str,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    eprintln!(
        "[call_openai_blocking] POST {url}, model={model}, key_len={}, prompt_len={}",
        api_key.len(),
        prompt.len()
    );

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": false
    });
    apply_provider_options(&mut body, base_url);

    let client = build_client(timeout_secs)?;
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_request_error(&e))?;

    let response = check_response(response).await?;
    let resp_text = response
        .text()
        .await
        .map_err(|e| format!("响应读取失败: {e}"))?;
    eprintln!(
        "[call_openai_blocking] raw response (first 500 chars): {}",
        &resp_text[..resp_text.len().min(500)]
    );

    let resp_json: Value = serde_json::from_str(&resp_text).map_err(|e| {
        format!(
            "响应JSON解析失败: {e}. 原始响应: {}",
            &resp_text[..resp_text.len().min(300)]
        )
    })?;

    // Check for error-in-200 pattern (some Chinese API proxies do this)
    if let Some(err_obj) = resp_json.get("error") {
        let err_msg = err_obj
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_else(|| err_obj.as_str().unwrap_or("unknown error"));
        return Err(format!("API 错误: {err_msg} (url={url})"));
    }
    if resp_json.get("success") == Some(&Value::Bool(false)) {
        let msg = resp_json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        let code = resp_json.get("code").and_then(|c| c.as_u64()).unwrap_or(0);
        return Err(format!("API 网关错误: {msg} (code={code}, url={url})"));
    }

    let finish_reason = resp_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|f| f.as_str())
        .unwrap_or("unknown");
    if finish_reason == "length" {
        return Err(format!(
            "模型输出被截断（max_tokens={max_tokens}），请提高最大 tokens 后重试"
        ));
    }

    let message = resp_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"));

    let content = message
        .and_then(|m| {
            // Standard: content as string
            if let Some(s) = m.get("content").and_then(|c| c.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
            // DeepSeek reasoning models: content might be null, real output in reasoning_content
            if let Some(s) = m.get("reasoning_content").and_then(|c| c.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
            // Array content format (newer API versions)
            if let Some(arr) = m.get("content").and_then(|c| c.as_array()) {
                let text: String = arr
                    .iter()
                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                if !text.is_empty() {
                    return Some(text);
                }
            }
            None
        })
        .unwrap_or_default();

    if content.is_empty() {
        let finish_reason = resp_json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("finish_reason"))
            .and_then(|f| f.as_str())
            .unwrap_or("unknown");
        let resp_snippet = if resp_text.len() > 300 {
            format!("{}...", &resp_text[..300])
        } else {
            resp_text.clone()
        };
        eprintln!("[call_openai_blocking] empty content! full_resp={resp_snippet}");
        return Err(format!(
            "模型返回空内容 (finish_reason={finish_reason}). 原始响应: {resp_snippet}"
        ));
    }
    Ok(content)
}

async fn call_openai_streaming<F: FnMut(&str)>(
    base_url: &str,
    api_key: &str,
    model: &str,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    prompt: &str,
    on_delta: &mut F,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": true
    });
    apply_provider_options(&mut body, base_url);

    let client = build_client(timeout_secs)?;
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_request_error(&e))?;

    let response = check_response(response).await?;
    let mut full_text = String::new();
    let mut stream = response.bytes_stream();
    let mut line_buf = String::new();
    let mut finish_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);

        for ch in text.chars() {
            if ch == '\n' {
                let (delta, finish) = parse_openai_sse_event(&line_buf);
                if finish.is_some() { finish_reason = finish; }
                if let Some(delta) = delta {
                    full_text.push_str(&delta);
                    on_delta(&delta);
                }
                line_buf.clear();
            } else {
                line_buf.push(ch);
            }
        }
    }
    // Process last line
    if !line_buf.is_empty() {
        let (delta, finish) = parse_openai_sse_event(&line_buf);
        if finish.is_some() { finish_reason = finish; }
        if let Some(delta) = delta {
            full_text.push_str(&delta);
            on_delta(&delta);
        }
    }

    if full_text.is_empty() {
        return Err("流式响应为空".to_string());
    }
    if finish_reason.as_deref() == Some("length") {
        return Err(format!(
            "模型流式输出被截断（max_tokens={max_tokens}），请提高最大 tokens 后重试"
        ));
    }
    Ok(full_text)
}

#[cfg(test)]
fn parse_openai_sse_line(line: &str) -> Option<String> {
    parse_openai_sse_event(line).0
}

fn parse_openai_sse_event(line: &str) -> (Option<String>, Option<String>) {
    let line = line.trim_end_matches('\r');
    let Some(data) = line.strip_prefix("data: ") else { return (None, None); };
    if data == "[DONE]" || data.is_empty() {
        return (None, None);
    }
    let Some(json) = serde_json::from_str::<Value>(data).ok() else { return (None, None); };
    let choice = json.get("choices").and_then(|c| c.get(0));
    let delta = choice
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let finish = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|f| f.as_str())
        .map(|s| s.to_string());
    (delta, finish)
}

async fn call_anthropic_blocking(
    base_url: &str,
    api_key: &str,
    model: &str,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": SYSTEM_PROMPT,
        "messages": [
            { "role": "user", "content": prompt }
        ]
    });

    let client = build_client(timeout_secs)?;
    let response = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_request_error(&e))?;

    let response = check_response(response).await?;
    let resp_json: Value = response
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;

    let content = resp_json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    if content.is_empty() {
        let err_msg = resp_json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("模型返回了空内容");
        return Err(err_msg.to_string());
    }
    Ok(content)
}

async fn call_anthropic_streaming<F: FnMut(&str)>(
    base_url: &str,
    api_key: &str,
    model: &str,
    temperature: f64,
    max_tokens: u32,
    timeout_secs: u64,
    prompt: &str,
    on_delta: &mut F,
) -> Result<String, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": true,
        "system": SYSTEM_PROMPT,
        "messages": [
            { "role": "user", "content": prompt }
        ]
    });

    let client = build_client(timeout_secs)?;
    let response = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_request_error(&e))?;

    let response = check_response(response).await?;
    let mut full_text = String::new();
    let mut stream = response.bytes_stream();
    let mut line_buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);

        for ch in text.chars() {
            if ch == '\n' {
                if let Some(delta) = parse_anthropic_sse_line(&line_buf) {
                    full_text.push_str(&delta);
                    on_delta(&delta);
                }
                line_buf.clear();
            } else {
                line_buf.push(ch);
            }
        }
    }
    if !line_buf.is_empty() {
        if let Some(delta) = parse_anthropic_sse_line(&line_buf) {
            full_text.push_str(&delta);
            on_delta(&delta);
        }
    }

    if full_text.is_empty() {
        return Err("流式响应为空".to_string());
    }
    Ok(full_text)
}

fn parse_anthropic_sse_line(line: &str) -> Option<String> {
    let line = line.trim_end_matches('\r');
    let data = line.strip_prefix("data: ")?;
    if data.is_empty() {
        return None;
    }
    let json: Value = serde_json::from_str(data).ok()?;
    let event_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "content_block_delta" => json
            .get("delta")
            .and_then(|d| d.get("text"))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        _ => None,
    }
}

pub async fn test_connection(
    base_url: &str,
    api_key: &str,
    model: &str,
    protocol: &str,
) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let proto = effective_protocol(protocol, base_url);

    match proto {
        "anthropic" => test_anthropic(base_url, api_key, model, start).await,
        _ => test_openai(base_url, api_key, model, start).await,
    }
}

async fn test_openai(
    base_url: &str,
    api_key: &str,
    model: &str,
    start: std::time::Instant,
) -> Result<Value, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi, reply with exactly: OK"}],
        "max_tokens": 10,
        "temperature": 0
    });

    let client = build_client(15)?;
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_request_error(&e))?;

    let latency = start.elapsed().as_millis();
    let response = check_response(response).await?;

    let resp: Value = response.json().await.map_err(|e| e.to_string())?;
    let resp_model = resp.get("model").and_then(|v| v.as_str()).unwrap_or(model);

    Ok(serde_json::json!({
        "ok": true,
        "latency": latency,
        "model": resp_model,
    }))
}

async fn test_anthropic(
    base_url: &str,
    api_key: &str,
    model: &str,
    start: std::time::Instant,
) -> Result<Value, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 10,
        "temperature": 0,
        "messages": [{"role": "user", "content": "Hi, reply with exactly: OK"}]
    });

    let client = build_client(15)?;
    let response = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_request_error(&e))?;

    let latency = start.elapsed().as_millis();
    let response = check_response(response).await?;

    let resp: Value = response.json().await.map_err(|e| e.to_string())?;
    let resp_model = resp.get("model").and_then(|v| v.as_str()).unwrap_or(model);

    Ok(serde_json::json!({
        "ok": true,
        "latency": latency,
        "model": resp_model,
    }))
}

pub fn parse_entry(raw: &str, selection: &str, kind: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    let json_str = extract_json_block(trimmed)?;

    let mut entry: Value = serde_json::from_str(&json_str)
        .or_else(|_| {
            let repaired = repair_json_string(&json_str);
            serde_json::from_str(&repaired)
        })
        .or_else(|_| {
            let repaired = aggressive_repair(&json_str);
            serde_json::from_str(&repaired)
        })
        .map_err(|e| {
            eprintln!(
                "[parse_entry] all repair attempts failed. raw_head={}",
                &json_str[..json_str.len().min(500)]
            );
            format!("JSON 解析失败: {e}")
        })?;

    if let Some(obj) = entry.as_object_mut() {
        if !obj.contains_key("selection") {
            obj.insert(
                "selection".to_string(),
                Value::String(selection.to_string()),
            );
        }
        if !obj.contains_key("kind") {
            obj.insert("kind".to_string(), Value::String(kind.to_string()));
        }
        if !obj.contains_key("id") {
            obj.insert(
                "id".to_string(),
                Value::String(format!("e-{}", uuid::Uuid::new_v4())),
            );
        }
        let field_defaults: Vec<(&str, Value)> = vec![
            ("lemma", Value::String(selection.to_string())),
            ("pos", Value::String(String::new())),
            ("ipaUS", Value::String(String::new())),
            ("ipaUK", Value::String(String::new())),
            ("translation", Value::String(String::new())),
            ("contextMeaning", Value::String(String::new())),
            ("explanation", Value::String(String::new())),
            ("senses", Value::Array(vec![])),
            ("associations", Value::Array(vec![])),
            ("examples", Value::Array(vec![])),
            ("collocations", Value::Array(vec![])),
            ("register", Value::String("neutral".to_string())),
        ];
        for (key, default) in field_defaults {
            if !obj.contains_key(key) {
                obj.insert(key.to_string(), default);
            }
        }

        if let Some(w) = obj.get("word").cloned() {
            if !obj.contains_key("lemma")
                || obj
                    .get("lemma")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .is_empty()
            {
                obj.insert("lemma".to_string(), w);
            }
        }

        if let Some(ipa) = obj.remove("ipa_us") {
            obj.insert("ipaUS".to_string(), ipa);
        }
        if let Some(ipa) = obj.remove("ipa_uk") {
            obj.insert("ipaUK".to_string(), ipa);
        }
        if let Some(cm) = obj.remove("context_meaning") {
            obj.insert("contextMeaning".to_string(), cm);
        }
        if let Some(tp) = obj.remove("translation_pairs") {
            obj.insert("translationPairs".to_string(), tp);
        }
        if let Some(kt) = obj.remove("key_terms") {
            obj.insert("keyTerms".to_string(), kt);
        }
    }

    Ok(entry)
}

fn extract_json_block(text: &str) -> Result<String, String> {
    let start = text.find('{').ok_or("No JSON object found in response")?;
    let end = text.rfind('}').map(|i| i + 1).unwrap_or(text.len());
    Ok(text[start..end].to_string())
}

fn repair_json_string(input: &str) -> String {
    let mut result = String::with_capacity(input.len() + 128);
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_string = false;

    while i < len {
        let c = chars[i];

        if in_string {
            if c == '\\' && i + 1 < len {
                result.push(c);
                result.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
                result.push(c);
                i += 1;
                continue;
            }
            match c {
                '\n' => result.push_str("\\n"),
                '\r' => result.push_str("\\r"),
                '\t' => result.push_str("\\t"),
                '\x08' => result.push_str("\\b"),
                '\x0C' => result.push_str("\\f"),
                _ if (c as u32) < 0x20 => {
                    result.push_str(&format!("\\u{:04x}", c as u32));
                }
                _ => result.push(c),
            }
            i += 1;
        } else {
            if c == '"' {
                in_string = true;
            }
            result.push(c);
            i += 1;
        }
    }
    result
}

fn aggressive_repair(input: &str) -> String {
    let pass1 = repair_json_string(input);

    let mut result = String::with_capacity(pass1.len());
    let chars: Vec<char> = pass1.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == ',' {
            let mut j = i + 1;
            while j < len
                && (chars[j] == ' ' || chars[j] == '\n' || chars[j] == '\r' || chars[j] == '\t')
            {
                j += 1;
            }
            if j < len && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

fn build_client(timeout_secs: u64) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout_secs.max(30)))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

fn format_request_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "请求超时，请检查网络连接或增加超时时间".to_string()
    } else if e.is_connect() {
        "无法连接到模型服务，请检查 Base URL 是否正确".to_string()
    } else {
        format!("网络请求失败: {e}")
    }
}

async fn check_response(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status_code = response.status().as_u16();
    let body_text = response.text().await.unwrap_or_default();
    Err(match status_code {
        401 => "鉴权失败（401）：请检查 API Key 是否正确".to_string(),
        403 => "访问被拒绝（403）：API Key 权限不足".to_string(),
        404 => "模型不存在（404）：请检查模型名称".to_string(),
        429 => "请求过于频繁（429）：请稍后重试".to_string(),
        500..=599 => format!("服务端错误（{}）：请稍后重试", status_code),
        _ => format!("HTTP {}: {}", status_code, body_text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_construction_openai() {
        let cases = vec![
            (
                "https://api.openai.com/v1",
                "https://api.openai.com/v1/chat/completions",
            ),
            (
                "https://api.openai.com/v1/",
                "https://api.openai.com/v1/chat/completions",
            ),
            (
                "https://api.deepseek.com/v1",
                "https://api.deepseek.com/v1/chat/completions",
            ),
            (
                "https://proxy.example.com/api/v1",
                "https://proxy.example.com/api/v1/chat/completions",
            ),
            (
                "https://api.example.com",
                "https://api.example.com/chat/completions",
            ),
        ];
        for (base_url, expected) in cases {
            let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
            assert_eq!(url, expected, "base_url={base_url}");
        }
    }

    #[test]
    fn test_effective_protocol() {
        // Explicit anthropic always wins
        assert_eq!(
            effective_protocol("anthropic", "https://any.com"),
            "anthropic"
        );
        // URL contains /anthropic → infer anthropic
        assert_eq!(
            effective_protocol("openai", "https://open.bigmodel.cn/api/anthropic"),
            "anthropic"
        );
        // URL contains anthropic.com → infer anthropic
        assert_eq!(
            effective_protocol("openai", "https://api.anthropic.com"),
            "anthropic"
        );
        // Normal openai stays openai
        assert_eq!(
            effective_protocol("openai", "https://api.openai.com/v1"),
            "openai"
        );
        assert_eq!(
            effective_protocol("openai", "https://api.deepseek.com/v1"),
            "openai"
        );
        // Empty protocol with anthropic URL
        assert_eq!(
            effective_protocol("", "https://open.bigmodel.cn/api/anthropic"),
            "anthropic"
        );
    }

    #[test]
    fn test_deepseek_disables_thinking() {
        let mut body = serde_json::json!({ "model": "deepseek-v4-flash" });
        apply_provider_options(&mut body, "https://api.deepseek.com");
        assert_eq!(body["thinking"]["type"], "disabled");

        let mut other = serde_json::json!({ "model": "gpt-4o-mini" });
        apply_provider_options(&mut other, "https://api.openai.com/v1");
        assert!(other.get("thinking").is_none());
    }

    #[test]
    fn test_parse_openai_sse_line_normal() {
        let line = r#"data: {"id":"x","choices":[{"delta":{"content":"Hello"}}]}"#;
        assert_eq!(parse_openai_sse_line(line), Some("Hello".to_string()));
    }

    #[test]
    fn test_parse_openai_sse_line_with_cr() {
        let line = "data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\r";
        assert_eq!(parse_openai_sse_line(line), Some("Hi".to_string()));
    }

    #[test]
    fn test_parse_openai_sse_done() {
        assert_eq!(parse_openai_sse_line("data: [DONE]"), None);
        assert_eq!(parse_openai_sse_line("data: [DONE]\r"), None);
    }

    #[test]
    fn test_parse_openai_sse_empty_delta() {
        let line = r#"data: {"id":"x","choices":[{"delta":{}}]}"#;
        assert_eq!(parse_openai_sse_line(line), None);
    }

    #[test]
    fn test_parse_openai_sse_finish_reason_length() {
        let line = r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#;
        assert_eq!(
            parse_openai_sse_event(line),
            (None, Some("length".to_string()))
        );
    }

    #[test]
    fn test_parse_openai_sse_not_data_line() {
        assert_eq!(parse_openai_sse_line("event: message"), None);
        assert_eq!(parse_openai_sse_line(""), None);
        assert_eq!(parse_openai_sse_line(": comment"), None);
    }

    #[test]
    fn test_parse_anthropic_sse_content_delta() {
        let line =
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}"#;
        assert_eq!(parse_anthropic_sse_line(line), Some("world".to_string()));
    }

    #[test]
    fn test_parse_anthropic_sse_other_events() {
        let line = r#"data: {"type":"message_start","message":{}}"#;
        assert_eq!(parse_anthropic_sse_line(line), None);
    }

    #[test]
    fn test_parse_entry_basic() {
        let json = r#"{"lemma":"test","pos":"n","translation":"测试"}"#;
        let entry = parse_entry(json, "test", "word").unwrap();
        assert_eq!(entry.get("lemma").unwrap().as_str().unwrap(), "test");
        assert_eq!(entry.get("translation").unwrap().as_str().unwrap(), "测试");
        assert!(entry.get("id").is_some());
    }

    #[test]
    fn test_parse_entry_with_markdown_fence() {
        let raw = "```json\n{\"lemma\":\"hello\",\"translation\":\"你好\"}\n```";
        let entry = parse_entry(raw, "hello", "word").unwrap();
        assert_eq!(entry.get("lemma").unwrap().as_str().unwrap(), "hello");
    }

    #[test]
    fn test_parse_entry_trailing_comma() {
        let raw = r#"{"lemma":"ok","pos":"adj","translation":"好的",}"#;
        let entry = parse_entry(raw, "ok", "word").unwrap();
        assert_eq!(entry.get("lemma").unwrap().as_str().unwrap(), "ok");
    }

    #[test]
    fn test_error_in_200_detection() {
        let resp: Value =
            serde_json::from_str(r#"{"code":500,"msg":"404 NOT_FOUND","success":false}"#).unwrap();
        assert_eq!(resp.get("success"), Some(&Value::Bool(false)));
        let msg = resp.get("msg").and_then(|m| m.as_str()).unwrap();
        assert_eq!(msg, "404 NOT_FOUND");
    }

    #[test]
    fn test_extract_content_standard() {
        let resp: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"hello world"},"finish_reason":"stop"}]}"#
        ).unwrap();
        let content = resp
            .get("choices")
            .unwrap()
            .get(0)
            .unwrap()
            .get("message")
            .unwrap()
            .get("content")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_extract_content_null_with_reasoning() {
        let resp: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":null,"reasoning_content":"thinking output"}}]}"#
        ).unwrap();
        let msg = resp
            .get("choices")
            .unwrap()
            .get(0)
            .unwrap()
            .get("message")
            .unwrap();
        let content = msg.get("content").and_then(|c| c.as_str());
        assert!(content.is_none() || content.unwrap().is_empty());
        let reasoning = msg
            .get("reasoning_content")
            .and_then(|c| c.as_str())
            .unwrap();
        assert_eq!(reasoning, "thinking output");
    }

    #[test]
    fn test_incremental_json_extractor_emits_complete_fields_once() {
        let mut extractor = IncrementalJsonExtractor::new();
        assert!(extractor.push(r#"{"translation":"测"#).is_empty());
        let fields = extractor.push(r#"试","meta":{"note":"a } value"},"senses":[{"pos":"n"}]"#);
        assert_eq!(fields.len(), 3);
        assert_eq!(
            fields[0],
            ("translation".into(), Value::String("测试".into()))
        );
        assert_eq!(fields[1].0, "meta");
        assert_eq!(fields[2].0, "senses");
        assert!(extractor.push("}").is_empty());
    }

    #[test]
    fn test_incremental_json_extractor_handles_null_and_truncation() {
        let mut extractor = IncrementalJsonExtractor::new();
        let fields = extractor.push(r#"```json {"ipaUS":null,"examples":[{"en":"unfinished"#);
        assert_eq!(fields, vec![("ipaUS".into(), Value::Null)]);
    }
}
