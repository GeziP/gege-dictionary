/// Content filter to reduce clipboard false positives.
/// Prefer false negatives (allow English) over false positives (reject prose).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterReason {
    Empty,
    Secret,
    FilePath,
    Code,
    Base64,
    Email,
    IpAddress,
}

impl FilterReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Secret => "secret",
            Self::FilePath => "file_path",
            Self::Code => "code",
            Self::Base64 => "base64",
            Self::Email => "email",
            Self::IpAddress => "ip_address",
        }
    }
}

pub fn should_reject(text: &str) -> bool {
    reject_reason(text).is_some()
}

pub fn reject_reason(text: &str) -> Option<FilterReason> {
    if text.is_empty() {
        return Some(FilterReason::Empty);
    }
    if is_secret(text) {
        return Some(FilterReason::Secret);
    }
    if is_file_path(text) {
        return Some(FilterReason::FilePath);
    }
    if is_code_snippet(text) {
        return Some(FilterReason::Code);
    }
    if is_base64_blob(text) {
        return Some(FilterReason::Base64);
    }
    if is_email(text) {
        return Some(FilterReason::Email);
    }
    if is_ip_address(text) {
        return Some(FilterReason::IpAddress);
    }
    None
}

fn is_secret(text: &str) -> bool {
    let prefixes = [
        "sk-", "sk_", "ghp_", "gho_", "ghs_", "AKIA", "xoxb-", "xoxp-",
    ];
    for prefix in &prefixes {
        if text.starts_with(prefix) {
            return true;
        }
    }
    if !text.contains(' ') && text.len() >= 20 && text.len() <= 200 {
        let entropy = shannon_entropy(text);
        if entropy > 4.5 {
            return true;
        }
    }
    false
}

fn is_file_path(text: &str) -> bool {
    let line = text.lines().next().unwrap_or(text);
    if line.len() > 300 {
        return false;
    }
    if line.len() >= 3
        && line.as_bytes()[1] == b':'
        && (line.as_bytes()[2] == b'\\' || line.as_bytes()[2] == b'/')
    {
        return true;
    }
    if line.starts_with('/') && !line.contains(' ') && line.contains('/') {
        let parts: Vec<&str> = line.split('/').collect();
        if parts.len() >= 3 {
            return true;
        }
    }
    if line.starts_with("\\\\") {
        return true;
    }
    false
}

/// Prefixes that almost never begin natural English sentences.
const STRONG_PREFIXES: &[&str] = &[
    "#include",
    "pub fn",
    "async fn",
    "impl ",
    "namespace ",
    "if (",
    "for (",
    "while (",
    "switch (",
    "catch (",
];

/// Prefixes that also appear in prose; require additional code context.
const WEAK_PREFIXES: &[&str] = &[
    "function ",
    "fn ",
    "def ",
    "class ",
    "import ",
    "from ",
    "const ",
    "let ",
    "var ",
    "struct ",
    "interface ",
    "type ",
    "enum ",
    "package ",
];

const NATURAL_STARTERS: &[&str] = &[
    "the ", "a ", "an ", "my ", "this ", "that ", "it ", "some ", "any ", "these ", "those ",
    "our ", "your ", "all ", "both ", "each ", "every ", "both ", "no ", "one ", "two ", "to ",
    "of ", "in ", "on ", "at ", "for ", "with ", "and ", "or ", "but ", "if ", "as ", "data",
    "answer", "action", "example", "note", "list", "order", "type",
];

fn has_strong_code_context(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.ends_with(';')
        || trimmed.ends_with('{')
        || trimmed.ends_with('}')
        || trimmed.ends_with("=>")
        || trimmed.ends_with("->")
    {
        return true;
    }
    if trimmed.contains("=>")
        || trimmed.contains("->")
        || trimmed.contains("::")
        || trimmed.contains("&&")
        || trimmed.contains("||")
    {
        return true;
    }
    if trimmed.contains(" = ") || trimmed.contains("=:") || trimmed.contains(" =\t") {
        return true;
    }
    if trimmed.contains('(') && trimmed.contains(')') {
        // function-call / definition shaped: keyword then identifier(...)
        let lower = trimmed.to_ascii_lowercase();
        for kw in ["function ", "def ", "fn ", "class "] {
            if lower.starts_with(kw) {
                return true;
            }
        }
    }
    false
}

fn looks_like_identifier(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$')
        && token
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
}

fn is_natural_word(token: &str) -> bool {
    let t = token
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_ascii_lowercase();
    NATURAL_STARTERS
        .iter()
        .any(|w| t == w.trim() || w.trim_end() == t)
        || matches!(
            t.as_str(),
            "the"
                | "a"
                | "an"
                | "my"
                | "this"
                | "that"
                | "it"
                | "some"
                | "any"
                | "these"
                | "those"
                | "our"
                | "your"
                | "all"
                | "data"
                | "answer"
                | "action"
                | "example"
                | "note"
                | "list"
                | "order"
                | "type"
                | "practice"
                | "matters"
                | "now"
                | "on"
                | "from"
                | "to"
                | "of"
                | "in"
                | "at"
                | "for"
                | "with"
                | "and"
                | "or"
                | "but"
                | "me"
                | "us"
                | "them"
                | "we"
                | "you"
                | "him"
                | "her"
                | "they"
                | "i"
        )
}

fn weak_prefix_has_code_context(first_line: &str) -> bool {
    let trimmed = first_line.trim_start();
    if has_strong_code_context(first_line) {
        return true;
    }

    // from X import Y
    if trimmed.to_ascii_lowercase().starts_with("from ") && trimmed.contains(" import ") {
        return true;
    }

    // import module / import x as y
    if let Some(rest) = trimmed.strip_prefix("import ") {
        let rest = rest.trim();
        if rest.ends_with(';') {
            return true;
        }
        let first = rest.split_whitespace().next().unwrap_or("");
        if looks_like_identifier(first) && !is_natural_word(first) && !first.is_empty() {
            // "import the" / "import my" allowed; "import numpy" / "import React" rejected
            if first
                .chars()
                .any(|c| c == '.' || c == '_' || c == '/' || c == '-')
            {
                return true;
            }
            if first.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                return true;
            }
            // multi-token programming import: import { a, b } / import type { X }
            if rest.starts_with('{') || rest.contains(" {") {
                return true;
            }
            // import numpy as np / import module.sub
            if !is_natural_word(first) {
                let codeish = rest.split_whitespace().all(|t| {
                    let t = t.trim_matches(|c| c == '\'' || c == '"' || c == ';' || c == ',');
                    t == "as"
                        || t == "from"
                        || looks_like_identifier(t)
                        || t.starts_with('{')
                        || t.ends_with('}')
                });
                if codeish && !rest.to_ascii_lowercase().contains("the ") {
                    return true;
                }
            }
        }
    }

    // const/let/var x = ...  (allow "let me know", "let us see", "let the dog out")
    if let Some(rest) = trimmed
        .strip_prefix("const ")
        .or_else(|| trimmed.strip_prefix("let "))
        .or_else(|| trimmed.strip_prefix("var "))
    {
        let first = rest.split_whitespace().next().unwrap_or("");
        if looks_like_identifier(first) && !is_natural_word(first) {
            // Bare identifiers are code only with assignment/declaration shape.
            if trimmed.contains('=')
                || trimmed.ends_with(';')
                || rest.contains('{')
                || rest.starts_with('{')
                || rest.starts_with('&')
                || rest.starts_with('*')
                || first.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            {
                return true;
            }
            // "let mut count" / "const x" style tokens with _ or known code ops
            if first.contains('_') || first.chars().any(|c| c == '.' || c == ':') {
                return true;
            }
        }
    }

    // type Foo / class Foo / struct Foo / interface Foo / enum Foo / package foo
    for kw in [
        "type ",
        "class ",
        "struct ",
        "interface ",
        "enum ",
        "package ",
    ] {
        if let Some(rest) = trimmed.strip_prefix(kw) {
            let first = rest.split_whitespace().next().unwrap_or("");
            if looks_like_identifier(first) && !is_natural_word(first) {
                if kw == "package " {
                    return true;
                }
                // "type the answer" first="the" → natural
                if first.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                    || first.contains('_')
                    || rest.contains('=')
                    || rest.contains('{')
                {
                    return true;
                }
            }
        }
    }

    false
}

fn is_code_snippet(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().take(5).collect();
    let first_line = lines.first().copied().unwrap_or("");

    for ind in STRONG_PREFIXES {
        if first_line.trim_start().starts_with(ind) {
            return true;
        }
    }

    // Symbol-only strong operators anywhere on first line of short copy
    let first_trim = first_line.trim();
    if first_trim.contains("};") || first_trim.contains("});") || first_trim.contains(");") {
        if first_trim
            .chars()
            .filter(|c| !c.is_whitespace())
            .all(|c| !c.is_ascii_alphabetic())
            || first_trim.contains("function")
            || first_trim.contains("const ")
        {
            return true;
        }
    }

    for ind in WEAK_PREFIXES {
        if first_line.trim_start().starts_with(ind) && weak_prefix_has_code_context(first_line) {
            return true;
        }
    }

    if lines.len() >= 3 {
        let code_line_count = lines
            .iter()
            .filter(|l| {
                let t = l.trim();
                t.ends_with(';')
                    || t.ends_with('{')
                    || t.ends_with('}')
                    || t.starts_with("//")
                    || t.starts_with('#')
            })
            .count();
        if code_line_count >= 2 {
            return true;
        }
    }

    false
}

fn is_base64_blob(text: &str) -> bool {
    if text.contains(' ') || text.len() < 40 || text.len() > 10000 {
        return false;
    }
    let valid_b64 = text.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '\n' || c == '\r'
    });
    if !valid_b64 {
        return false;
    }
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    clean.len() >= 40 && (clean.ends_with('=') || clean.len() % 4 == 0)
}

fn is_email(text: &str) -> bool {
    let t = text.trim();
    if t.contains(' ') || t.len() > 320 {
        return false;
    }
    if let Some(at_pos) = t.find('@') {
        let local = &t[..at_pos];
        let domain = &t[at_pos + 1..];
        !local.is_empty() && domain.contains('.') && domain.len() > 3
    } else {
        false
    }
}

fn is_ip_address(text: &str) -> bool {
    let t = text.trim();
    if t.contains(' ') {
        return false;
    }
    let ip_part = t.split(':').next().unwrap_or(t);
    let parts: Vec<&str> = ip_part.split('.').collect();
    if parts.len() == 4 {
        return parts.iter().all(|p| p.parse::<u8>().is_ok());
    }
    if t.matches(':').count() >= 2 && t.chars().all(|c| c.is_ascii_hexdigit() || c == ':') {
        return true;
    }
    false
}

fn shannon_entropy(text: &str) -> f64 {
    let mut freq = [0u32; 256];
    let len = text.len() as f64;
    for &b in text.as_bytes() {
        freq[b as usize] += 1;
    }
    let mut entropy = 0.0f64;
    for &count in &freq {
        if count > 0 {
            let p = count as f64 / len;
            entropy -= p * p.log2();
        }
    }
    entropy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rejects_api_keys() {
        assert!(should_reject("sk-abc123def456ghi789jkl012mno345pqr"));
        assert!(should_reject("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh"));
        assert!(should_reject("AKIAIOSFODNN7EXAMPLE"));
        assert_eq!(
            reject_reason("sk-abc123def456ghi789jkl012mno345pqr"),
            Some(FilterReason::Secret)
        );
    }

    #[test]
    fn test_rejects_file_paths() {
        assert!(should_reject("C:\\Users\\admin\\Documents\\file.txt"));
        assert!(should_reject("/usr/local/bin/node"));
        assert!(should_reject("\\\\server\\share\\folder"));
    }

    #[test]
    fn test_rejects_code() {
        assert!(should_reject("function hello() {\n  return 'world';\n}"));
        assert!(should_reject("const x = 42;\nconst y = x + 1;"));
        assert!(should_reject("import React from 'react';"));
        assert!(should_reject("import numpy as np"));
        assert!(should_reject("from typing import List"));
        assert!(should_reject("type Foo = { a: number }"));
        assert!(should_reject("const x = 42"));
        assert!(should_reject("let mut count = 0;"));
    }

    #[test]
    fn test_rejects_base64() {
        assert!(should_reject(
            "SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0IG9mIGJhc2U2NCBlbmNvZGluZw=="
        ));
    }

    #[test]
    fn test_rejects_email() {
        assert!(should_reject("user@example.com"));
        assert!(should_reject("admin@my-company.co.uk"));
    }

    #[test]
    fn test_rejects_ip() {
        assert!(should_reject("192.168.1.1"));
        assert!(should_reject("10.0.0.1:8080"));
    }

    #[test]
    fn test_allows_english_text() {
        assert!(!should_reject("hello world"));
        assert!(!should_reject(
            "The quick brown fox jumps over the lazy dog"
        ));
        assert!(!should_reject("unprecedented"));
        assert!(!should_reject("machine learning"));
    }

    #[test]
    fn test_allows_natural_english_with_code_like_words() {
        assert!(!should_reject("import the data from Excel"));
        assert!(!should_reject("From now on, always validate the result"));
        assert!(!should_reject("from now on"));
        assert!(!should_reject("Constant practice matters"));
        assert!(!should_reject("type the answer in the box"));
        assert!(!should_reject("const of the matter"));
        assert!(!should_reject("let the dog out"));
        assert!(!should_reject("let me know"));
        assert!(!should_reject("let me know when you are ready"));
        assert!(!should_reject("let us see"));
        assert!(!should_reject("let them decide"));
        assert!(!should_reject("Please let him go"));
    }

    #[test]
    fn test_allows_let_me_know_but_rejects_let_binding() {
        assert!(!should_reject("let me know"));
        assert!(should_reject("let mut count = 0;"));
        assert!(should_reject("let x = 42"));
        assert!(should_reject("const MAX_SIZE = 1024;"));
        assert!(!should_reject("const of the matter"));
    }

    #[test]
    fn test_truncate_for_log_is_utf8_safe() {
        let long = "响应JSON解析失败测试".repeat(40);
        let cut = crate::llm::truncate_for_log(&long, 20);
        assert!(cut.chars().count() <= 21);
        assert!(cut.ends_with('…'));
    }
}
