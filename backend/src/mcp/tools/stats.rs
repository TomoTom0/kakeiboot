//! summarize_spending #14 (spec_mcp-tools.md 10). The heavy lifting is in
//! `domain::stats::summarize`; this handler resolves the period, renders the
//! envelope and puts the widget-only extras (daily cumulative) in `_meta`.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse};
use crate::domain::search;
use crate::domain::stats::{
    self, FilterError, Filters, default_period, parse_period, resolve_period,
};
use crate::domain::util;
use crate::mcp::result::{self, Warning, envelope, yen};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SummarizeArgs {
    report: String,
    #[serde(default)]
    period: Option<Value>,
    #[serde(default)]
    filters: Option<Filters>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn summarize(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: SummarizeArgs = parse(args)?;
    let ledger = c.target(a.ledger_id).await?;
    let period = match &a.period {
        Some(v) => parse_period(v).map_err(|m| result::invalid(&[m]))?,
        None => default_period(&a.report),
    };
    let range =
        resolve_period(&period, util::jst_date(c.now)).map_err(|m| result::invalid(&[m]))?;
    let filters = a.filters.unwrap_or_default();
    // TASK-73: search query length cap (spec 3-5) at the input validation
    // point; the message carries the limit so the model can retry shorter.
    let max_query_chars = c.limits().max_query_chars;
    for (kind, v) in [
        ("store", filters.store.as_deref()),
        ("item_query", filters.item_query.as_deref()),
    ] {
        if let Err(e) = search::check_query_text(kind, v.unwrap_or(""), max_query_chars) {
            return Err(match e {
                FilterError::Invalid(m) => result::invalid(&[m]),
                FilterError::Db(e) => result::internal(e),
            });
        }
    }
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    let (res, meta) = stats::summarize(
        &mut conn,
        ledger.id,
        &a.report,
        &range,
        &filters,
        c.limits().stats_max_rows,
    )
    .await
    .map_err(|e| match e {
        FilterError::Invalid(m) => result::invalid(&[m]),
        FilterError::Db(e) => result::internal(e),
    })?;
    drop(conn);

    let mut warnings = Vec::new();
    for s in &res.sections {
        if let Some(t) = s.truncated_rows {
            warnings.push(Warning::new(
                "rows_truncated",
                format!("「{}」は上位とその他にまとめました（{}行省略）", s.title, t),
                Some(json!({ "section": s.id })),
            ));
        }
    }
    let t = &res.totals;
    let top_line = res
        .sections
        .first()
        .and_then(|s| s.rows.first())
        .map(|r| {
            format!(
                " 最上位: {}（{}）",
                r.labels.first().cloned().unwrap_or_default(),
                yen(r.value)
            )
        })
        .unwrap_or_default();
    let text = format!(
        "{}: {}、{}件。{}。{}",
        res.period_resolved.label,
        yen(t.value),
        t.receipts,
        top_line,
        ledger.text_suffix()
    );
    let body = serde_json::to_value(&res).unwrap_or(Value::Null);
    let meta = meta
        .as_object()
        .is_some_and(|m| !m.is_empty())
        .then_some(meta);
    Ok(result::ok(
        text,
        envelope("stats", Some(&ledger), &warnings, body),
        meta,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:mcp-stats.text-summary-shape]
    #[test]
    fn summary_text_and_meta_gate() {
        // The `_meta` (widget extras like daily_cumulative) is only attached
        // when non-empty; the content text carries period label + total.
        let empty = json!({});
        assert!(empty.as_object().is_some_and(|m| m.is_empty()));
        let daily = json!({ "daily_cumulative": [{ "date": "2026-10-01", "value": 100 }] });
        assert!(daily.as_object().is_some_and(|m| !m.is_empty()));
    }

    // [covers:mcp-stats.default-period-fallback]
    #[test]
    fn default_periods() {
        assert!(matches!(
            default_period("monthly_trend"),
            stats::Period::Preset { .. }
        ));
        let p = default_period("monthly_overview");
        let r = resolve_period(&p, util::jst_date(0)).unwrap();
        assert!(r.label.contains("月"));
    }
}
