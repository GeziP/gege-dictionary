use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

const SYSTEM_PROMPT: &str = "You are a precise English-Chinese lexicography assistant. CRITICAL RULES: 1) Respond with a single valid JSON object ONLY. 2) No markdown fences, no extra text before or after the JSON. 3) All string values must use \\n for newlines and \\\" for quotes. 4) Do NOT embed markdown code blocks (```) inside JSON strings. Use plain text or pseudocode instead. 5) No trailing commas.";

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

    match protocol {
        "anthropic" => call_anthropic_blocking(base_url, api_key, model, temperature, max_tokens, timeout_secs, &prompt).await,
        _ => call_openai_blocking(base_url, api_key, model, temperature, max_tokens, timeout_secs, &prompt).await,
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

    match protocol {
        "anthropic" => call_anthropic_streaming(base_url, api_key, model, temperature, max_tokens, timeout_secs, &prompt, &mut on_delta).await,
        _ => call_openai_streaming(base_url, api_key, model, temperature, max_tokens, timeout_secs, &prompt, &mut on_delta).await,
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

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": false
    });

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
    let resp_json: Value = response.json().await.map_err(|e| format!("响应解析失败: {e}"))?;
    let content = resp_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    if content.is_empty() {
        return Err("模型返回了空内容".to_string());
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

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": true
    });

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

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);

        for ch in text.chars() {
            if ch == '\n' {
                if let Some(delta) = parse_openai_sse_line(&line_buf) {
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
        if let Some(delta) = parse_openai_sse_line(&line_buf) {
            full_text.push_str(&delta);
            on_delta(&delta);
        }
    }

    if full_text.is_empty() {
        return Err("流式响应为空".to_string());
    }
    Ok(full_text)
}

fn parse_openai_sse_line(line: &str) -> Option<String> {
    let data = line.strip_prefix("data: ")?;
    if data == "[DONE]" {
        return None;
    }
    let json: Value = serde_json::from_str(data).ok()?;
    json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
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
    let resp_json: Value = response.json().await.map_err(|e| format!("响应解析失败: {e}"))?;

    let content = resp_json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    if content.is_empty() {
        let err_msg = resp_json.get("error")
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
    let data = line.strip_prefix("data: ")?;
    let json: Value = serde_json::from_str(data).ok()?;
    let event_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "content_block_delta" => {
            json.get("delta")
                .and_then(|d| d.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        }
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

    match protocol {
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
            eprintln!("[parse_entry] all repair attempts failed. raw_head={}", &json_str[..json_str.len().min(500)]);
            format!("JSON 解析失败: {e}")
        })?;

    if let Some(obj) = entry.as_object_mut() {
        if !obj.contains_key("selection") {
            obj.insert("selection".to_string(), Value::String(selection.to_string()));
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
            if !obj.contains_key("lemma") || obj.get("lemma").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
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
            while j < len && (chars[j] == ' ' || chars[j] == '\n' || chars[j] == '\r' || chars[j] == '\t') {
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
