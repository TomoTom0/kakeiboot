//! Token / identifier primitives: 256-bit random tokens with SHA-256 hashing,
//! base64url codec, Crockford base32 account numbers (spec_auth.md sections
//! 2-1, 3, 10-4; spec_data-model.md section 10-2).

use sha2::{Digest, Sha256};

/// Token / ceremony ID size in bytes (256-bit, spec_data-model.md section 10-2).
pub const TOKEN_LEN: usize = 32;

/// Generate a fresh 256-bit random token from the system RNG.
pub fn random_token() -> [u8; TOKEN_LEN] {
    let mut buf = [0u8; TOKEN_LEN];
    getrandom::fill(&mut buf).expect("system RNG unavailable");
    buf
}

/// SHA-256 hash used as the DB key for tokens, sessions and ceremony IDs.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

/// Lowercase hex.
pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}

/// Hex decode (case-insensitive); None on odd length or non-hex characters.
pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (cookie values, token strings in URLs).
pub fn b64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[n as usize & 63] as char);
        }
    }
    out
}

/// base64url decode without padding; None on any invalid character or a
/// length whose final chunk cannot exist (`len % 4 == 1`).
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut vals: Vec<u8> = Vec::with_capacity(s.len());
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        vals.push(v);
    }
    if vals.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for chunk in vals.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &v)| acc | ((v as u32) << (18 - 6 * i)));
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// Crockford base32 alphabet (I, L, O, U excluded).
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 8 Crockford base32 characters from 40 random bits.
fn crockford8(bits: [u8; 5]) -> String {
    let n = u64::from_be_bytes([0, 0, 0, bits[0], bits[1], bits[2], bits[3], bits[4]]);
    (0..8)
        .map(|i| CROCKFORD[((n >> (35 - 5 * i)) & 31) as usize] as char)
        .collect()
}

/// Random 8-character Crockford base32 body (without the `BB-` prefix).
pub fn random_crockford8() -> String {
    let mut bytes = [0u8; 5];
    getrandom::fill(&mut bytes).expect("system RNG unavailable");
    crockford8(bytes)
}

/// Candidate account number (`BB-XXXX-XXXX`).
pub fn candidate_account_number() -> String {
    let body = random_crockford8();
    format!("BB-{}-{}", &body[..4], &body[4..])
}

/// Normalize an account number for lookup / comparison: uppercase, drop the
/// `BB` prefix and all non-alphanumerics, map Crockford-confusable letters
/// (spec_auth.md section 7-1).
pub fn normalize_account_number(input: &str) -> String {
    let upper = input.trim().to_uppercase();
    let cleaned: String = upper
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let body = cleaned.strip_prefix("BB").unwrap_or(&cleaned);
    body.chars()
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            'U' => 'V',
            other => other,
        })
        .collect()
}

/// Canonical `BB-XXXX-XXXX` form of a normalized body (display only).
pub fn format_account_number(normalized: &str) -> Option<String> {
    let body: String = normalized
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if body.len() != 8 || body == "BB" {
        return None;
    }
    Some(format!("BB-{}-{}", &body[..4], &body[4..]))
}

/// Default passkey label derived from the User-Agent (spec_auth.md section
/// 2-3: unset labels fall back to a User-Agent based default name).
pub fn default_label_from_ua(ua: &str) -> String {
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("OPR/") {
        "Opera"
    } else if ua.contains("Chrome/") && !ua.contains("Chromium") {
        "Chrome"
    } else if ua.contains("Chromium") {
        "Chromium"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    let os = if ua.contains("iPhone") || ua.contains("iPad") {
        "iOS"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") {
        "macOS"
    } else if ua.contains("Linux") || ua.contains("X11") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() {
        browser.to_string()
    } else {
        format!("{browser} on {os}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:auth-cli.account-number-generation]
    #[test]
    fn account_number_candidates_match_crockford_shape() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            let n = candidate_account_number();
            // BB-XXXX-XXXX with Crockford alphabet (no I, L, O, U).
            let bytes = n.as_bytes();
            assert_eq!(bytes.len(), 12);
            assert_eq!(&n[..3], "BB-");
            assert_eq!(&n[7..8], "-");
            for c in n[3..7].chars().chain(n[8..].chars()) {
                assert!(
                    c.is_ascii_digit()
                        || matches!(c, 'A'..='H' | 'J' | 'K' | 'M' | 'N' | 'P'..='T' | 'V'..='Z'),
                    "non-crockford char {c} in {n}"
                );
            }
            assert!(seen.insert(n.clone()), "collision in 200 draws: {n}");
        }
    }

    #[test]
    fn account_number_normalization() {
        assert_eq!(normalize_account_number("bb-abcd-2345"), "ABCD2345");
        assert_eq!(normalize_account_number("BB AB CD 23 45"), "ABCD2345");
        assert_eq!(normalize_account_number("BBA1CD2345"), "A1CD2345");
        // confusables mapped: I/L -> 1, O -> 0, U -> V
        assert_eq!(normalize_account_number("BB-ABIO-LUVX"), "AB101VVX");
        assert_eq!(normalize_account_number("bb-abcd2345"), "ABCD2345");
        assert_eq!(
            format_account_number("ABCD2345").as_deref(),
            Some("BB-ABCD-2345")
        );
        assert_eq!(format_account_number("ABC"), None);
    }

    #[test]
    fn b64url_roundtrip_and_vectors() {
        // RFC 4648 base64url vectors (no padding).
        assert_eq!(b64url_encode(b""), "");
        assert_eq!(b64url_encode(b"f"), "Zg");
        assert_eq!(b64url_encode(b"fo"), "Zm8");
        assert_eq!(b64url_encode(b"foo"), "Zm9v");
        assert_eq!(b64url_encode(b"foob"), "Zm9vYg");
        assert_eq!(b64url_encode(b"fooba"), "Zm9vYmE");
        assert_eq!(b64url_encode(b"foobar"), "Zm9vYmFy");
        // 32-byte token shape: 43 chars, no padding.
        let t = random_token();
        let enc = b64url_encode(&t);
        assert_eq!(enc.len(), 43);
        assert!(!enc.contains('='));
        assert_eq!(b64url_decode(&enc).unwrap(), t.to_vec());
        assert!(b64url_decode("A").is_none()); // len % 4 == 1
        assert!(b64url_decode("A*B").is_none()); // invalid char
        assert!(b64url_decode("AB==").is_none()); // padding rejected
    }

    #[test]
    fn default_label_from_ua_extracted() {
        let label = default_label_from_ua(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        );
        assert_eq!(label, "Chrome on Linux");
        assert_eq!(
            default_label_from_ua(
                "Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0"
            ),
            "Firefox on Windows"
        );
        assert_eq!(default_label_from_ua("curl/8.0"), "Browser");
    }

    #[test]
    fn hex_matches_expected() {
        assert_eq!(to_hex(&[0x00, 0xff, 0x10]), "00ff10");
        assert_eq!(
            to_hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
