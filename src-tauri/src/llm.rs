use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

const SYSTEM_PROMPT: &str = "You are a precise English-Chinese lexicography assistant. CRITICAL RULES: 1) Respond with a single valid JSON object ONLY. 2) No markdown fences, no extra text before or after the JSON. 3) All string values must use \\n for newlines and \\\" for quotes. 4) Do NOT embed markdown code blocks (```) inside JSON strings. Use plain text or pseudocode instead. 5) No trailing commas.";

/// UTF-8-safe prefix for error messages. Never panics on multi-byte boundaries.
pub(crate) fn truncate_for_log(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// Every machine-readable kind an LLM call can fail with. The code travels as a
/// `[code] ` prefix on the error string, so the UI picks its advice from the code
/// instead of guessing from wording. `src/lib/lookup-errors.ts` mirrors this list and
/// `error_codes_match_the_frontend_contract` fails if the two differ.
pub(crate) const ERROR_CODES: &[&str] = &[
    "no_key",
    "auth",
    "model",
    "rate_limit",
    "server",
    "http",
    "timeout",
    "network",
    "parse",
    "empty",
    "truncated",
    "api",
    "internal",
    "unknown",
];

/// Tag `message` with its error `code`: the one shape every LLM-facing error leaves this module in.
pub(crate) fn coded(code: &str, message: impl std::fmt::Display) -> String {
    debug_assert!(
        ERROR_CODES.contains(&code),
        "unregistered error code: {code}"
    );
    format!("[{code}] {message}")
}

/// The registered code carried by `err`, if it has one.
pub(crate) fn error_code(err: &str) -> Option<&str> {
    let (code, _) = err.trim_start().strip_prefix('[')?.split_once(']')?;
    ERROR_CODES.contains(&code).then_some(code)
}

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

/// Fill the template's placeholders in a single pass. Replacing them one after another would
/// also rewrite a placeholder that happens to appear inside the selected text itself.
pub(crate) fn build_prompt(template: &str, selection: &str, context: &str) -> String {
    let mut prompt = String::with_capacity(template.len() + selection.len() + context.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        prompt.push_str(&rest[..start]);
        rest = &rest[start..];
        let (token, value) = [
            ("{{selection}}", selection),
            ("{{context}}", context),
            ("{{native_lang}}", "中文"),
        ]
        .into_iter()
        .find(|(token, _)| rest.starts_with(token))
        // Not one of ours: keep the braces and carry on after them.
        .unwrap_or(("{{", "{{"));
        prompt.push_str(value);
        rest = &rest[token.len()..];
    }
    prompt.push_str(rest);
    prompt
}

/// Rough token count of `text`: about one token per four narrow characters and one and a half per
/// CJK one. Providers tokenize differently, so this feeds the usage panel (which says "estimate"),
/// never a bill.
pub(crate) fn estimate_tokens(text: &str) -> u32 {
    let (mut narrow, mut wide) = (0_u32, 0_u32);
    for c in text.chars() {
        // Kana, CJK ideographs, hangul, and the full-width punctuation around them.
        if matches!(
            c as u32,
            0x3000..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xFF00..=0xFFEF
        ) {
            wide += 1;
        } else {
            narrow += 1;
        }
    }
    narrow.div_ceil(4) + (wide * 3).div_ceil(2)
}

/// Estimated tokens for one model call: the system prompt and `prompt` that went out, plus the
/// `answer` that came back.
pub(crate) fn estimate_lookup_tokens(prompt: &str, answer: &str) -> u32 {
    estimate_tokens(SYSTEM_PROMPT) + estimate_tokens(prompt) + estimate_tokens(answer)
}

/// Where a model call goes and how it is made: everything about it except the prompt.
#[derive(Clone, Copy)]
pub struct ModelCall<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    /// The protocol the user chose; the URL can overrule it (see `effective_protocol`).
    pub protocol: &'a str,
    pub temperature: f64,
    pub max_tokens: u32,
    pub timeout_secs: u64,
}

/// Blocking (non-streaming) lookup — used as fallback or when streaming is disabled.
pub async fn stream_lookup(
    call: ModelCall<'_>,
    selection: &str,
    context: &str,
    template_body: &str,
) -> Result<String, String> {
    let prompt = build_prompt(template_body, selection, context);

    let proto = effective_protocol(call.protocol, call.base_url);
    eprintln!(
        "[stream_lookup] protocol={}, effective={proto}, url={}",
        call.protocol, call.base_url
    );
    match proto {
        "anthropic" => call_anthropic_blocking(call, &prompt).await,
        _ => call_openai_blocking(call, &prompt).await,
    }
}

/// Streaming lookup — emits deltas through a callback, returns full text at the end.
pub async fn stream_lookup_sse<F>(
    call: ModelCall<'_>,
    selection: &str,
    context: &str,
    template_body: &str,
    mut on_delta: F,
) -> Result<String, String>
where
    F: FnMut(&str),
{
    let prompt = build_prompt(template_body, selection, context);

    match effective_protocol(call.protocol, call.base_url) {
        "anthropic" => call_anthropic_streaming(call, &prompt, &mut on_delta).await,
        _ => call_openai_streaming(call, &prompt, &mut on_delta).await,
    }
}

async fn call_openai_blocking(call: ModelCall<'_>, prompt: &str) -> Result<String, String> {
    let ModelCall {
        base_url,
        api_key,
        model,
        temperature,
        max_tokens,
        timeout_secs,
        ..
    } = call;
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
        .map_err(|e| coded("network", format!("响应读取失败: {e}")))?;
    eprintln!("[call_openai_blocking] response_len={}", resp_text.len());

    let resp_json: Value = serde_json::from_str(&resp_text).map_err(|e| {
        coded(
            "parse",
            format!(
                "响应JSON解析失败: {e}. 原始响应: {}",
                truncate_for_log(&resp_text, 200)
            ),
        )
    })?;

    // Check for error-in-200 pattern (some Chinese API proxies do this)
    if let Some(err_obj) = resp_json.get("error") {
        let err_msg = err_obj
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_else(|| err_obj.as_str().unwrap_or("unknown error"));
        return Err(coded("api", format!("API 错误: {err_msg} (url={url})")));
    }
    if resp_json.get("success") == Some(&Value::Bool(false)) {
        let msg = resp_json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        let code = resp_json.get("code").and_then(|c| c.as_u64()).unwrap_or(0);
        return Err(coded(
            "api",
            format!("API 网关错误: {msg} (code={code}, url={url})"),
        ));
    }

    let finish_reason = resp_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|f| f.as_str())
        .unwrap_or("unknown");
    if finish_reason == "length" {
        return Err(coded(
            "truncated",
            format!("模型输出被截断（max_tokens={max_tokens}），请提高最大 tokens 后重试"),
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
        let resp_snippet_len = resp_text.len().min(200);
        eprintln!(
            "[call_openai_blocking] empty content! resp_len={} snippet_len={resp_snippet_len}",
            resp_text.len()
        );
        return Err(coded(
            "empty",
            format!(
                "模型返回空内容 (finish_reason={finish_reason}). 原始响应长度: {}",
                resp_text.len()
            ),
        ));
    }
    Ok(content)
}

async fn call_openai_streaming<F: FnMut(&str)>(
    call: ModelCall<'_>,
    prompt: &str,
    on_delta: &mut F,
) -> Result<String, String> {
    let ModelCall {
        base_url,
        api_key,
        model,
        temperature,
        max_tokens,
        timeout_secs,
        ..
    } = call;
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

    'stream: while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| coded("network", format!("流式读取中断: {e}")))?;
        let text = String::from_utf8_lossy(&bytes);

        for ch in text.chars() {
            if ch == '\n' {
                if is_openai_sse_done(&line_buf) {
                    line_buf.clear();
                    break 'stream;
                }
                let (delta, finish) = parse_openai_sse_event(&line_buf);
                if finish.is_some() {
                    finish_reason = finish;
                }
                if let Some(delta) = delta {
                    full_text.push_str(&delta);
                    on_delta(&delta);
                }
                line_buf.clear();
                if finish_reason.is_some() {
                    break 'stream;
                }
            } else {
                line_buf.push(ch);
            }
        }
    }
    // Process last line
    if !line_buf.is_empty() {
        let (delta, finish) = parse_openai_sse_event(&line_buf);
        if finish.is_some() {
            finish_reason = finish;
        }
        if let Some(delta) = delta {
            full_text.push_str(&delta);
            on_delta(&delta);
        }
    }

    if full_text.is_empty() {
        return Err(coded("empty", "流式响应为空"));
    }
    if finish_reason.as_deref() == Some("length") {
        return Err(coded(
            "truncated",
            format!("模型流式输出被截断（max_tokens={max_tokens}），请提高最大 tokens 后重试"),
        ));
    }
    Ok(full_text)
}

#[cfg(test)]
fn parse_openai_sse_line(line: &str) -> Option<String> {
    parse_openai_sse_event(line).0
}

fn is_openai_sse_done(line: &str) -> bool {
    line.trim_end_matches('\r').trim() == "data: [DONE]"
}

fn parse_openai_sse_event(line: &str) -> (Option<String>, Option<String>) {
    let line = line.trim_end_matches('\r');
    let Some(data) = line.strip_prefix("data: ") else {
        return (None, None);
    };
    if data == "[DONE]" || data.is_empty() {
        return (None, None);
    }
    let Some(json) = serde_json::from_str::<Value>(data).ok() else {
        return (None, None);
    };
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

async fn call_anthropic_blocking(call: ModelCall<'_>, prompt: &str) -> Result<String, String> {
    let ModelCall {
        base_url,
        api_key,
        model,
        temperature,
        max_tokens,
        timeout_secs,
        ..
    } = call;
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
        .map_err(|e| coded("parse", format!("响应解析失败: {e}")))?;

    if resp_json.get("stop_reason").and_then(|r| r.as_str()) == Some(ANTHROPIC_CUT_OFF) {
        return Err(coded(
            "truncated",
            format!("模型输出被截断（max_tokens={max_tokens}），请提高最大 tokens 后重试"),
        ));
    }

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
        let api_error = resp_json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str());
        return Err(match api_error {
            Some(message) => coded("api", message),
            None => coded("empty", "模型返回了空内容"),
        });
    }
    Ok(content)
}

async fn call_anthropic_streaming<F: FnMut(&str)>(
    call: ModelCall<'_>,
    prompt: &str,
    on_delta: &mut F,
) -> Result<String, String> {
    let ModelCall {
        base_url,
        api_key,
        model,
        temperature,
        max_tokens,
        timeout_secs,
        ..
    } = call;
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
    let mut stop_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| coded("network", format!("流式读取中断: {e}")))?;
        let text = String::from_utf8_lossy(&bytes);

        for ch in text.chars() {
            if ch == '\n' {
                let (delta, stop) = parse_anthropic_sse_event(&line_buf);
                if stop.is_some() {
                    stop_reason = stop;
                }
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
    if !line_buf.is_empty() {
        let (delta, stop) = parse_anthropic_sse_event(&line_buf);
        if stop.is_some() {
            stop_reason = stop;
        }
        if let Some(delta) = delta {
            full_text.push_str(&delta);
            on_delta(&delta);
        }
    }

    if full_text.is_empty() {
        return Err(coded("empty", "流式响应为空"));
    }
    if stop_reason.as_deref() == Some(ANTHROPIC_CUT_OFF) {
        return Err(coded(
            "truncated",
            format!("模型流式输出被截断（max_tokens={max_tokens}），请提高最大 tokens 后重试"),
        ));
    }
    Ok(full_text)
}

/// The `stop_reason` of an Anthropic reply that ran into `max_tokens` before it was done.
const ANTHROPIC_CUT_OFF: &str = "max_tokens";

#[cfg(test)]
fn parse_anthropic_sse_line(line: &str) -> Option<String> {
    parse_anthropic_sse_event(line).0
}

/// What one line of an Anthropic event stream says: some new text, and/or why the model has
/// stopped (the `message_delta` event near the end of a reply carries the `stop_reason`).
fn parse_anthropic_sse_event(line: &str) -> (Option<String>, Option<String>) {
    let line = line.trim_end_matches('\r');
    let Some(data) = line.strip_prefix("data: ") else {
        return (None, None);
    };
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return (None, None);
    };
    let text = |value: Option<&Value>| value.and_then(|v| v.as_str()).map(str::to_string);
    match json.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "content_block_delta" => (text(json.get("delta").and_then(|d| d.get("text"))), None),
        "message_delta" => (
            None,
            text(json.get("delta").and_then(|d| d.get("stop_reason"))),
        ),
        _ => (None, None),
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

    let resp: Value = response
        .json()
        .await
        .map_err(|e| coded("parse", format!("响应解析失败: {e}")))?;
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

    let resp: Value = response
        .json()
        .await
        .map_err(|e| coded("parse", format!("响应解析失败: {e}")))?;
    let resp_model = resp.get("model").and_then(|v| v.as_str()).unwrap_or(model);

    Ok(serde_json::json!({
        "ok": true,
        "latency": latency,
        "model": resp_model,
    }))
}

/// What the log may say about a model answer that could not be read: how long it was and where
/// the parser gave up. Never any of its text, which is the translation of what the user selected
/// (the logs promise not to print that).
fn parse_failure_note(answer: &str, error: &serde_json::Error) -> String {
    format!(
        "len={} line={} column={}",
        answer.len(),
        error.line(),
        error.column()
    )
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
                "[parse_entry] all repair attempts failed. {}",
                parse_failure_note(&json_str, &e)
            );
            coded("parse", format!("JSON 解析失败: {e}"))
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
        if let Some(domain_analysis) = obj.remove("domain_analysis") {
            obj.insert("domainAnalysis".to_string(), domain_analysis);
        }
    }

    Ok(entry)
}

fn extract_json_block(text: &str) -> Result<String, String> {
    let start = text
        .find('{')
        .ok_or_else(|| coded("parse", "模型返回的内容里没有 JSON 对象"))?;
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
        .map_err(|e| coded("internal", format!("HTTP client error: {e}")))
}

/// Classify a failed send by what reqwest says went wrong, never by the wording of its message.
fn format_request_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        coded("timeout", "请求超时，请检查网络连接或增加超时时间")
    } else if e.is_connect() {
        coded("network", "无法连接到模型服务，请检查 Base URL 是否正确")
    } else {
        coded("network", format!("网络请求失败: {e}"))
    }
}

/// The coded error for a non-success HTTP status. `body` is only quoted, and bounded, for
/// statuses nothing more specific is known about.
fn status_error(status: u16, body: &str) -> String {
    match status {
        401 => coded("auth", "鉴权失败（401）：请检查 API Key 是否正确"),
        403 => coded("auth", "访问被拒绝（403）：API Key 权限不足"),
        404 => coded(
            "model",
            "模型不存在（404）：请检查模型名称与 Base URL 是否正确",
        ),
        429 => coded("rate_limit", "请求过于频繁（429）：请稍后重试"),
        500..=599 => coded("server", format!("服务端错误（{status}）：请稍后重试")),
        _ => coded(
            "http",
            format!("HTTP {status}: {}", truncate_for_log(body, 300)),
        ),
    }
}

async fn check_response(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Err(status_error(status, &body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::OnceLock;
    use std::thread;
    use std::time::Duration;

    struct EnvironmentGuard {
        values: Vec<(&'static str, Option<String>)>,
    }

    impl Drop for EnvironmentGuard {
        fn drop(&mut self) {
            for (name, value) in &self.values {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }

    /// Keeps the other tests away from the process environment while one of them changes it.
    /// The tests that use it wait on the network with the guard held, so it is an async lock.
    async fn loopback_proxy_guard() -> (tokio::sync::MutexGuard<'static, ()>, EnvironmentGuard) {
        static PROXY_ENV_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        let lock = PROXY_ENV_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let names = ["NO_PROXY", "no_proxy"];
        let previous = names
            .iter()
            .map(|name| (*name, std::env::var(name).ok()))
            .collect();
        for name in names {
            std::env::set_var(name, "127.0.0.1,localhost");
        }
        (lock, EnvironmentGuard { values: previous })
    }

    /// A call to the server at `base_url`, as a lookup would make it.
    fn model_call<'a>(base_url: &'a str, protocol: &'a str) -> ModelCall<'a> {
        ModelCall {
            base_url,
            api_key: "test-key",
            model: "test-model",
            protocol,
            temperature: 0.3,
            max_tokens: 1200,
            timeout_secs: 30,
        }
    }

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

    #[tokio::test]
    async fn openai_streaming_round_trips_sse_and_emits_deltas() {
        let (_proxy_lock, _proxy_guard) = loopback_proxy_guard().await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /chat/completions HTTP/1.1"));
            assert!(request.contains("authorization: Bearer test-key"));
            assert!(request.contains("\"stream\":true"));

            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            );
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream
                .write_all(&body.as_bytes()[..body.len() / 2])
                .unwrap();
            stream.flush().unwrap();
            thread::sleep(Duration::from_millis(5));
            stream
                .write_all(&body.as_bytes()[body.len() / 2..])
                .unwrap();
            stream.flush().unwrap();
        });

        let mut deltas = Vec::new();
        let base_url = format!("http://{address}");
        let result = stream_lookup_sse(
            model_call(&base_url, "openai"),
            "hello",
            "context",
            "Translate {{selection}} in {{context}}",
            |delta| deltas.push(delta.to_string()),
        )
        .await
        .unwrap();

        server.join().unwrap();
        assert_eq!(result, "Hello world");
        assert_eq!(deltas, ["Hello ", "world"]);
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
        assert!(is_openai_sse_done("data: [DONE]"));
        assert!(is_openai_sse_done("data: [DONE]\r"));
        assert!(!is_openai_sse_done("data: {}"));
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
    fn test_parse_anthropic_sse_stop_reason() {
        let cut = r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":12}}"#;
        assert_eq!(
            parse_anthropic_sse_event(cut),
            (None, Some("max_tokens".to_string()))
        );
        let done = r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#;
        assert_eq!(
            parse_anthropic_sse_event(done),
            (None, Some("end_turn".to_string()))
        );
        // A text event has no stop reason, and the other lines of a stream have neither.
        let text = "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\r";
        assert_eq!(
            parse_anthropic_sse_event(text),
            (Some("hi".to_string()), None)
        );
        assert_eq!(
            parse_anthropic_sse_event("event: message_delta"),
            (None, None)
        );
        assert_eq!(parse_anthropic_sse_event("data: "), (None, None));
    }

    #[tokio::test]
    async fn an_anthropic_answer_cut_off_by_max_tokens_is_reported_as_truncated() {
        let (_proxy_lock, _proxy_guard) = loopback_proxy_guard().await;

        let (base_url, server) = serve_once(
            "200 OK",
            r#"{"content":[{"type":"text","text":"{\"lemma\":\"cut"}],"stop_reason":"max_tokens"}"#,
        );
        let err = stream_lookup(model_call(&base_url, "anthropic"), "w", "c", "t")
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error_code(&err), Some("truncated"), "{err}");

        let (base_url, server) = serve_once(
            "200 OK",
            concat!(
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"{\\\"lemma\\\":\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            ),
        );
        let mut seen = String::new();
        let err = stream_lookup_sse(model_call(&base_url, "anthropic"), "w", "c", "t", |delta| {
            seen.push_str(delta)
        })
        .await
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(error_code(&err), Some("truncated"), "{err}");
        assert_eq!(seen, "{\"lemma\":", "what arrived was still shown");
    }

    #[tokio::test]
    async fn an_anthropic_answer_that_ended_by_itself_is_returned_whole() {
        let (_proxy_lock, _proxy_guard) = loopback_proxy_guard().await;

        let (base_url, server) = serve_once(
            "200 OK",
            r#"{"content":[{"type":"text","text":"all of it"}],"stop_reason":"end_turn"}"#,
        );
        let full = stream_lookup(model_call(&base_url, "anthropic"), "w", "c", "t")
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(full, "all of it");

        let (base_url, server) = serve_once(
            "200 OK",
            concat!(
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello \"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"world\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            ),
        );
        let full = stream_lookup_sse(model_call(&base_url, "anthropic"), "w", "c", "t", |_| {})
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(full, "Hello world");
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
    fn test_parse_entry_normalizes_domain_analysis_alias() {
        let raw = r#"{"translation":"死锁","domain_analysis":{"domain":"computing","overview":"并发故障","mechanism":["循环等待"]}}"#;
        let entry = parse_entry(raw, "deadlock", "word").unwrap();
        assert_eq!(entry["domainAnalysis"]["domain"], "computing");
        assert_eq!(entry["domainAnalysis"]["mechanism"][0], "循环等待");
        assert!(entry.get("domain_analysis").is_none());
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

    /// Serve one canned HTTP response on a loopback port; returns the base URL to call it at.
    /// The request is read in full first, so closing the socket cannot reset a half-sent upload.
    fn serve_once(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            let header_end = loop {
                let count = stream.read(&mut chunk).unwrap();
                request.extend_from_slice(&chunk[..count]);
                if let Some(at) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break at + 4;
                }
                assert!(count > 0, "client closed before finishing its headers");
            };
            let head = String::from_utf8_lossy(&request[..header_end]).to_lowercase();
            let body_len: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse().ok())
                .unwrap_or(0);
            while request.len() < header_end + body_len {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0, "client closed in the middle of its body");
                request.extend_from_slice(&chunk[..count]);
            }
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });
        (base_url, server)
    }

    #[test]
    fn every_failure_status_maps_to_one_stable_code() {
        for (status, code) in [
            (401, "auth"),
            (403, "auth"),
            (404, "model"),
            (429, "rate_limit"),
            (500, "server"),
            (502, "server"),
            (503, "server"),
            (529, "server"),
            (400, "http"),
            (402, "http"),
            (413, "http"),
            (422, "http"),
            (451, "http"),
        ] {
            let err = status_error(status, "");
            assert_eq!(error_code(&err), Some(code), "status {status}: {err}");
        }
    }

    #[test]
    fn an_unexpected_status_quotes_only_a_bounded_slice_of_the_body() {
        let err = status_error(400, &"x".repeat(5000));
        assert!(err.starts_with("[http] HTTP 400: "));
        assert!(err.chars().count() < 400, "{} chars", err.chars().count());
        // Multi-byte bodies are cut on a character boundary rather than panicking.
        assert!(status_error(400, &"错".repeat(5000)).contains('…'));
    }

    #[test]
    fn coded_errors_carry_exactly_their_code() {
        for code in ERROR_CODES {
            let err = coded(code, "boom");
            assert_eq!(err, format!("[{code}] boom"));
            assert_eq!(error_code(&err), Some(*code));
        }
    }

    #[test]
    fn error_code_ignores_anything_unregistered() {
        assert_eq!(error_code("  [timeout] slow"), Some("timeout"));
        for text in [
            "[bogus] x",
            "auth] x",
            "[auth x",
            "[] x",
            "plain",
            "",
            "[Auth] x",
        ] {
            assert_eq!(error_code(text), None, "{text:?}");
        }
    }

    #[test]
    fn error_codes_match_the_frontend_contract() {
        let source = include_str!("../../src/lib/lookup-errors.ts");
        let list = source
            .split("LOOKUP_ERROR_CODES = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("src/lib/lookup-errors.ts must declare LOOKUP_ERROR_CODES");
        let mut frontend: Vec<&str> = list.split('\'').skip(1).step_by(2).collect();
        let mut backend = ERROR_CODES.to_vec();
        frontend.sort_unstable();
        backend.sort_unstable();
        assert_eq!(
            frontend, backend,
            "ERROR_CODES (llm.rs) and LOOKUP_ERROR_CODES (lookup-errors.ts) must list the same codes"
        );
    }

    #[test]
    fn model_output_that_is_not_json_is_a_parse_error() {
        for raw in ["no braces here", "{ not json at all"] {
            let err = parse_entry(raw, "x", "word").unwrap_err();
            assert_eq!(error_code(&err), Some("parse"), "{raw}: {err}");
        }
    }

    #[test]
    fn a_parse_failure_is_logged_without_any_text_of_the_answer() {
        let answer = r#"{"translation": "绝密的释义", "lemma": "secret", "pos": }"#;
        let error = serde_json::from_str::<Value>(answer).unwrap_err();

        let note = parse_failure_note(answer, &error);

        assert!(
            note.starts_with(&format!("len={} line=1 column=", answer.len())),
            "{note}"
        );
        for text in ["绝密", "释义", "secret", "translation"] {
            assert!(!note.contains(text), "the note quotes {text:?}: {note}");
        }
    }

    #[test]
    fn build_prompt_fills_every_placeholder() {
        let prompt = build_prompt(
            "{{selection}} | {{context}} | {{native_lang}} | {{selection}}",
            "word",
            "a sentence",
        );
        assert_eq!(prompt, "word | a sentence | 中文 | word");
    }

    #[test]
    fn build_prompt_never_rewrites_placeholders_inside_the_inserted_text() {
        // The selection is the text the user highlighted; if it happens to contain `{{context}}`
        // it must reach the model as-is, not be swapped for the context.
        let prompt = build_prompt(
            "S={{selection}};C={{context}}",
            "{{context}}",
            "{{selection}}",
        );
        assert_eq!(prompt, "S={{context}};C={{selection}}");
    }

    #[test]
    fn build_prompt_leaves_braces_that_are_not_placeholders_alone() {
        assert_eq!(
            build_prompt("{{unknown}} {x} {{ {{selection}}", "w", "c"),
            "{{unknown}} {x} {{ w"
        );
        assert_eq!(
            build_prompt("no placeholders 中文", "w", "c"),
            "no placeholders 中文"
        );
        assert_eq!(build_prompt("", "w", "c"), "");
    }

    #[test]
    fn token_estimates_follow_the_script_of_the_text() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens(&"a".repeat(400)), 100);
        assert_eq!(estimate_tokens("你好世界"), 6);
        assert_eq!(estimate_tokens("ab你"), 1 + 2);
        assert_eq!(
            estimate_tokens("，"),
            2,
            "full-width punctuation counts as wide"
        );
    }

    #[test]
    fn a_longer_exchange_is_never_estimated_cheaper() {
        let short = estimate_lookup_tokens("translate dog", "狗");
        let long =
            estimate_lookup_tokens("translate dog in this context", "狗，一种常见的家养动物");
        assert!(long > short);
        assert!(
            short > estimate_tokens(SYSTEM_PROMPT),
            "the system prompt is always sent"
        );
    }

    #[tokio::test]
    async fn a_rejected_connection_test_reports_the_status_as_a_code() {
        let (_proxy_lock, _proxy_guard) = loopback_proxy_guard().await;
        for (status_line, code) in [
            ("401 Unauthorized", "auth"),
            ("404 Not Found", "model"),
            ("429 Too Many Requests", "rate_limit"),
            ("503 Service Unavailable", "server"),
            ("400 Bad Request", "http"),
        ] {
            for protocol in ["openai", "anthropic"] {
                let (base_url, server) = serve_once(status_line, r#"{"error":"nope"}"#);
                let err = test_connection(&base_url, "key", "model", protocol)
                    .await
                    .unwrap_err();
                server.join().unwrap();
                assert_eq!(
                    error_code(&err),
                    Some(code),
                    "{status_line} via {protocol}: {err}"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_success_with_an_unreadable_body_is_a_parse_error() {
        let (_proxy_lock, _proxy_guard) = loopback_proxy_guard().await;
        let (base_url, server) = serve_once("200 OK", "this is not json");
        let err = test_connection(&base_url, "key", "model", "openai")
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error_code(&err), Some("parse"), "{err}");
    }

    #[tokio::test]
    async fn transport_failures_are_classified_by_kind_not_by_message() {
        let (_proxy_lock, _proxy_guard) = loopback_proxy_guard().await;

        // The kernel accepts the connection, but nobody ever answers.
        let silent = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client = Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let err = client
            .get(format!("http://{}", silent.local_addr().unwrap()))
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            error_code(&format_request_error(&err)),
            Some("timeout"),
            "{err}"
        );

        // Nothing is listening on this port any more.
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let err = Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            error_code(&format_request_error(&err)),
            Some("network"),
            "{err}"
        );
    }
}
