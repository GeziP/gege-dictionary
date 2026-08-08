use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    CRYPTPROTECT_UI_FORBIDDEN,
};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::core::PCWSTR;

const PREFIX: &str = "dpapi:v1:";

pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(PREFIX)
}

pub fn encrypt(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    if is_encrypted(plaintext) {
        return Ok(plaintext.to_string());
    }

    let data_bytes = plaintext.as_bytes();
    let mut data_in = CRYPT_INTEGER_BLOB {
        cbData: data_bytes.len() as u32,
        pbData: data_bytes.as_ptr() as *mut u8,
    };
    let mut data_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let description: Vec<u16> = "GegeDic\0".encode_utf16().collect();

    unsafe {
        let ok = CryptProtectData(
            &mut data_in,
            PCWSTR(description.as_ptr()),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut data_out,
        );

        if !ok.is_ok() {
            return Err("DPAPI CryptProtectData failed".to_string());
        }

        let encrypted_slice =
            std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize);
        let encoded = base64_encode(encrypted_slice);

        let _ = LocalFree(HLOCAL(data_out.pbData as *mut _));

        Ok(format!("{}{}", PREFIX, encoded))
    }
}

pub fn decrypt(ciphertext: &str) -> Result<String, String> {
    if ciphertext.is_empty() {
        return Ok(String::new());
    }
    if !is_encrypted(ciphertext) {
        return Ok(ciphertext.to_string());
    }

    let encoded = &ciphertext[PREFIX.len()..];
    let encrypted_bytes = base64_decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    let mut data_in = CRYPT_INTEGER_BLOB {
        cbData: encrypted_bytes.len() as u32,
        pbData: encrypted_bytes.as_ptr() as *mut u8,
    };
    let mut data_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        let ok = CryptUnprotectData(
            &mut data_in,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut data_out,
        );

        if !ok.is_ok() {
            return Err("DPAPI CryptUnprotectData failed — key may have been encrypted on a different user/machine".to_string());
        }

        let decrypted_slice =
            std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize);
        let plaintext = String::from_utf8(decrypted_slice.to_vec())
            .map_err(|e| format!("UTF-8 decode failed: {e}"))?;

        let _ = LocalFree(HLOCAL(data_out.pbData as *mut _));

        Ok(plaintext)
    }
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let input = input.trim_end_matches('=');
    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in input.chars() {
        let val = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => return Err(format!("Invalid base64 character: {ch}")),
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(result)
}
