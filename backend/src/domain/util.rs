//! Small shared helpers: JST time formatting, date parsing, and the search
//! escaping rules (spec_data-model.md 10-1, 13-2).

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveTime, TimeZone, Utc};

fn jst() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).expect("valid offset")
}

/// unix ms -> "YYYY-MM-DDTHH:MM:SS+09:00".
pub fn jst_iso(ms: i64) -> String {
    match Utc.timestamp_millis_opt(ms).single() {
        Some(t) => t
            .with_timezone(&jst())
            .format("%Y-%m-%dT%H:%M:%S%:z")
            .to_string(),
        None => String::new(),
    }
}

/// The JST calendar date of a unix ms timestamp.
pub fn jst_date(ms: i64) -> NaiveDate {
    let t: DateTime<Utc> = Utc
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now);
    t.with_timezone(&jst()).date_naive()
}

/// Strict "YYYY-MM-DD".
pub fn parse_date(s: &str) -> Option<NaiveDate> {
    if s.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// "HH:MM" or "HH:MM:SS".
pub fn valid_time(s: &str) -> bool {
    match s.len() {
        5 => NaiveTime::parse_from_str(s, "%H:%M").is_ok(),
        8 => NaiveTime::parse_from_str(s, "%H:%M:%S").is_ok(),
        _ => false,
    }
}

/// "YYYY-MM-DDTHH:MM[:SS]" (model-reported taken_at).
pub fn valid_local_datetime(s: &str) -> bool {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").is_ok()
        || chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").is_ok()
}

pub fn fmt_date(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// First day of the month containing `d`.
pub fn month_start(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1).expect("valid month start")
}

/// Shift a month start by `delta` months.
pub fn add_months(d: NaiveDate, delta: i32) -> NaiveDate {
    let idx = d.year() * 12 + d.month0() as i32 + delta;
    NaiveDate::from_ymd_opt(idx.div_euclid(12), idx.rem_euclid(12) as u32 + 1, 1)
        .expect("valid month")
}

/// Last day of the month containing `d`.
pub fn month_end(d: NaiveDate) -> NaiveDate {
    add_months(month_start(d), 1)
        .pred_opt()
        .expect("valid month end")
}

/// LIKE pattern body with `\`, `%`, `_` escaped (use with ESCAPE '\').
pub fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// FTS5 phrase query: `"` doubled, whole string quoted (spec 13-2).
pub fn fts_phrase(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Truncate to at most `n` chars (content text excerpts, spec 3-3).
pub fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:mcp-search.like-and-fts-escaping]
    #[test]
    fn escaping_rules() {
        assert_eq!(escape_like(r"50%_off\x"), r"50\%\_off\\x");
        assert_eq!(fts_phrase(r#"a"b"#), r#""a""b""#);
    }

    #[test]
    fn date_helpers() {
        let d = parse_date("2026-01-31").unwrap();
        assert_eq!(fmt_date(add_months(month_start(d), -1)), "2025-12-01");
        assert_eq!(fmt_date(month_end(d)), "2026-01-31");
        assert!(parse_date("2026-1-31").is_none());
        assert!(valid_time("18:42") && valid_time("18:42:05") && !valid_time("25:00"));
        // 2026-10-13T15:30:00Z = 2026-10-14 00:30 JST
        let ms = 1_791_905_400_000;
        assert_eq!(jst_iso(ms), "2026-10-14T00:30:00+09:00");
        assert_eq!(fmt_date(jst_date(ms)), "2026-10-14");
    }
}
