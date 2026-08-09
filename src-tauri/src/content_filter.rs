/// Content filter to reduce clipboard false positives.
/// Returns `true` if the content should be REJECTED (not looked up).

pub fn should_reject(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    is_secret(text)
        || is_file_path(text)
        || is_code_snippet(text)
        || is_base64_blob(text)
        || is_email(text)
        || is_ip_address(text)
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
    // High-entropy no-space string (likely API key or hash)
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
    // Windows paths
    if line.len() >= 3
        && line.as_bytes()[1] == b':'
        && (line.as_bytes()[2] == b'\\' || line.as_bytes()[2] == b'/')
    {
        return true;
    }
    // Unix paths
    if line.starts_with('/') && !line.contains(' ') && line.contains('/') {
        let parts: Vec<&str> = line.split('/').collect();
        if parts.len() >= 3 {
            return true;
        }
    }
    // UNC paths
    if line.starts_with("\\\\") {
        return true;
    }
    false
}

fn is_code_snippet(text: &str) -> bool {
    let indicators = [
        "function ",
        "fn ",
        "def ",
        "class ",
        "import ",
        "from ",
        "#include",
        "const ",
        "let ",
        "var ",
        "pub fn",
        "async fn",
        "impl ",
        "struct ",
        "interface ",
        "type ",
        "enum ",
        "package ",
        "namespace ",
        "if (",
        "for (",
        "while (",
        "switch (",
        "catch (",
        "=>",
        "->",
        "::",
        "&&",
        "||",
        "};",
        "});",
        ");",
    ];
    let lines: Vec<&str> = text.lines().take(5).collect();
    let first_line = lines.first().copied().unwrap_or("");

    // Starts with a code-like keyword
    for ind in &indicators {
        if first_line.trim_start().starts_with(ind) {
            return true;
        }
    }

    // Multiple lines with code indicators
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
    // Likely base64 if length is multiple of 4 and ends with = or has enough length
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
    // IPv4 with optional port
    let ip_part = t.split(':').next().unwrap_or(t);
    let parts: Vec<&str> = ip_part.split('.').collect();
    if parts.len() == 4 {
        return parts.iter().all(|p| p.parse::<u8>().is_ok());
    }
    // IPv6 (contains multiple colons)
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
}
