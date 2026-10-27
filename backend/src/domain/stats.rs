//! Period resolution and the summarize_spending reports
//! (spec_mcp-tools.md 7-1 Period, 10; spec_data-model.md 13-3 v_item_facts).
//! The metric is always SUM(amount_incl) (discount lines included).

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use super::catalog::{self, CatKind};
use super::dto::{
    AnalysisResult, AnalysisRow, AnalysisTotals, ItemMonthly, ItemPrice, ItemRef, ItemStatsResult,
    ItemStatsSummary, ItemStoreAgg, PeriodResolved, StatsResult, StatsRow, StatsSection,
    StatsTotals, TrendResult, TrendSeries,
};
use super::labels::LabelColor;
use super::util::{
    add_months, escape_like, fmt_date, fts_phrase, month_end, month_start, parse_date,
};
use crate::store::normalize_text;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Period {
    Preset { preset: String },
    Month { month: String },
    Year { year: i32 },
    Range { from: String, to: String },
}

/// A resolved inclusive date range plus the kind it was resolved from.
#[derive(Debug, Clone, PartialEq)]
pub struct Range {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub label: String,
    /// "month" | "year" | "months:N" | "days"
    kind: String,
}

impl Range {
    pub fn resolved(&self) -> PeriodResolved {
        PeriodResolved {
            from: fmt_date(self.from),
            to: fmt_date(self.to),
            label: self.label.clone(),
        }
    }

    /// An explicit inclusive date range (web screens' from / to filters).
    pub fn custom(from: NaiveDate, to: NaiveDate) -> Self {
        Self {
            from,
            to,
            label: format!("{}〜{}", fmt_date(from), fmt_date(to)),
            kind: "days".into(),
        }
    }
}

fn month_range(start: NaiveDate) -> Range {
    Range {
        from: start,
        to: month_end(start),
        label: format!("{}年{}月", start.year(), start.month()),
        kind: "month".into(),
    }
}

fn year_range(y: i32) -> Range {
    Range {
        from: NaiveDate::from_ymd_opt(y, 1, 1).expect("date"),
        to: NaiveDate::from_ymd_opt(y, 12, 31).expect("date"),
        label: format!("{y}年"),
        kind: "year".into(),
    }
}

fn last_n_months(today: NaiveDate, n: i32) -> Range {
    let s = add_months(month_start(today), -(n - 1));
    let e = month_end(today);
    Range {
        from: s,
        to: e,
        label: format!(
            "直近{n}か月（{}年{}月〜{}年{}月）",
            s.year(),
            s.month(),
            e.year(),
            e.month()
        ),
        kind: format!("months:{n}"),
    }
}

/// Resolve a Period against "today" in JST. Err = input error message.
pub fn resolve_period(p: &Period, today: NaiveDate) -> Result<Range, String> {
    match p {
        Period::Preset { preset } => match preset.as_str() {
            "this_month" => Ok(month_range(month_start(today))),
            "last_month" => Ok(month_range(add_months(month_start(today), -1))),
            "this_year" => Ok(year_range(today.year())),
            "last_year" => Ok(year_range(today.year() - 1)),
            "last_3_months" => Ok(last_n_months(today, 3)),
            "last_6_months" => Ok(last_n_months(today, 6)),
            "last_12_months" => Ok(last_n_months(today, 12)),
            other => Err(format!(
                "period.preset「{other}」は使えません（this_month / last_month / this_year / last_year / last_3_months / last_6_months / last_12_months）"
            )),
        },
        Period::Month { month } => parse_date(&format!("{month}-01"))
            .filter(|_| month.len() == 7)
            .map(month_range)
            .ok_or_else(|| "period.month は \"YYYY-MM\" にしてください".into()),
        Period::Year { year } => {
            if (1900..=9999).contains(year) {
                Ok(year_range(*year))
            } else {
                Err("period.year は西暦の整数にしてください".into())
            }
        }
        Period::Range { from, to } => match (parse_date(from), parse_date(to)) {
            (Some(f), Some(t)) if f <= t => Ok(Range {
                from: f,
                to: t,
                label: format!("{from}〜{to}"),
                kind: "days".into(),
            }),
            _ => Err("period.from / to は \"YYYY-MM-DD\" で from <= to にしてください".into()),
        },
    }
}

/// Parse a raw JSON period (input validation with a helpful message).
pub fn parse_period(v: &Value) -> Result<Period, String> {
    serde_json::from_value::<Period>(v.clone()).map_err(|_| {
        "period は {preset} / {month: \"YYYY-MM\"} / {year} / {from, to} のいずれかにしてください".into()
    })
}

// ---------------------------------------------------------------------------
// analysis (TASK-89 web screens; spec_mcp-tools.md 12, spec_data-model.md
// 13-3). The /analysis endpoints above `summarize` are web-only: the MCP
// reports and section shapes stay untouched.

/// The breakdown axis of the web analysis API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Category,
    Store,
    Item,
    Label,
    PaymentMethod,
}

impl Axis {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "category" => Self::Category,
            "store" => Self::Store,
            "item" => Self::Item,
            "label" => Self::Label,
            "payment_method" => Self::PaymentMethod,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Category => "category",
            Self::Store => "store",
            Self::Item => "item",
            Self::Label => "label",
            Self::PaymentMethod => "payment_method",
        }
    }

    /// The `labels_for` dim name of the axis. The item axis is name-keyed
    /// (grouped by 品名): `item_name` falls through labels_for's default arm,
    /// so the key itself — the display name — is the label.
    fn dim(self) -> &'static str {
        match self {
            Self::Category => "category_top",
            Self::Store => "store",
            Self::Item => "item_name",
            Self::Label => "label",
            Self::PaymentMethod => "payment_method",
        }
    }

    /// The grouped() key expression (label goes through its own JOIN query).
    /// A category filter narrows the category axis to that category's subs
    /// (the by_category convention). The item axis groups by 品名: same-name
    /// lines are one item (the /analysis/item item_query concept; REVIEW-13
    /// M-3). Note the drill is not strictly identical: item_query matches by
    /// item_match (FTS/LIKE), so another item whose name contains the
    /// drilled name (牛乳 vs 低脂肪牛乳) can widen the landing page beyond
    /// the row's exact-name group.
    fn key_expr(self, filters: &Filters) -> &'static str {
        match self {
            Self::Category => match filters.category.as_deref() {
                Some(c) if c.trim() != "未分類" => "f.category_id",
                _ => "f.category_top_id",
            },
            Self::Store => "f.store_id",
            Self::Item => "f.name",
            Self::PaymentMethod => "f.payment_method",
            Self::Label => "rl.color",
        }
    }
}

/// The numeric metric of the analysis API (unit = per-receipt average).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Amount,
    Count,
    Unit,
}

impl Metric {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "amount" => Self::Amount,
            "count" => Self::Count,
            "unit" => Self::Unit,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Amount => "amount",
            Self::Count => "count",
            Self::Unit => "unit",
        }
    }

    /// The metric value of one aggregate. Unit rounds to one decimal and is
    /// None when there is no receipt (count = 0).
    pub fn value(self, amount: i64, count: i64) -> Option<f64> {
        match self {
            Self::Amount => Some(amount as f64),
            Self::Count => Some(count as f64),
            Self::Unit => (count > 0).then(|| round1(amount as f64 / count as f64)),
        }
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// The bucket size of the stacked trend. `auto` follows the same 62/366-day
/// thresholds as the frontend trend granularity; the display decision stays
/// frontend-side, so an explicit value is expected in practice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Day,
    Week,
    Month,
}

impl Granularity {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "day" => Self::Day,
            "week" => Self::Week,
            "month" => Self::Month,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    pub fn auto(days: i64) -> Self {
        if days <= 62 {
            Self::Day
        } else if days <= 366 {
            Self::Week
        } else {
            Self::Month
        }
    }
}

// ---------------------------------------------------------------------------
// filters

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_query: Option<String>,
    /// OR over the label palette: only receipts holding one of these colors
    /// are aggregated (spec_mcp-tools.md 10). An empty array means "no
    /// filter" and is normalized to None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_colors: Option<Vec<LabelColor>>,
    /// Web-only exact store match (the web /analysis query sets it).
    /// `serde(skip)` keeps it out of the MCP summarize_spending input
    /// (deny_unknown_fields still rejects it as an unknown key) and out of
    /// the echo.
    #[serde(skip)]
    pub store_id: Option<i64>,
    /// Web-only exact payment-method match (TASK-65, the store_id pattern:
    /// not in the MCP summarize filters, not in the echo).
    #[serde(skip)]
    pub payment_method: Option<String>,
}

impl Filters {
    /// Normalize: an empty `label_colors` is the same as no filter.
    pub fn normalized(mut self) -> Self {
        if self.label_colors.as_ref().is_some_and(|c| c.is_empty()) {
            self.label_colors = None;
        }
        self
    }

    /// True when no filter is applied (the echo is omitted).
    pub fn is_empty(&self) -> bool {
        self.category.is_none()
            && self.store.is_none()
            && self.store_category.is_none()
            && self.item_query.is_none()
            && self.label_colors.is_none()
            && self.store_id.is_none()
            && self.payment_method.is_none()
    }
}

/// Bind values for dynamically built SQL.
#[derive(Debug, Clone)]
pub enum Bind {
    I(i64),
    S(String),
}

/// SQL fragments over `v_item_facts f` for the filters. Err = input error.
pub async fn filter_sql(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    f: &Filters,
) -> Result<(String, Vec<Bind>), FilterError> {
    let mut sql = String::new();
    let mut binds = Vec::new();
    if let Some(c) = &f.category {
        if c.trim() == "未分類" {
            sql.push_str(" AND f.category_id IS NULL");
        } else {
            let id = catalog::resolve_path(conn, CatKind::Item, ledger_id, c)
                .await?
                .ok_or_else(|| {
                    FilterError::Invalid(format!(
                        "カテゴリ「{c}」がありません（get_catalog の category_paths.item）"
                    ))
                })?;
            sql.push_str(" AND (f.category_id = ? OR f.category_top_id = ?)");
            binds.push(Bind::I(id));
            binds.push(Bind::I(id));
        }
    }
    if let Some(c) = &f.store_category {
        let id = catalog::resolve_path(conn, CatKind::Store, ledger_id, c)
            .await?
            .ok_or_else(|| {
                FilterError::Invalid(format!(
                    "店カテゴリ「{c}」がありません（get_catalog の category_paths.store）"
                ))
            })?;
        sql.push_str(" AND (f.store_category_id = ? OR f.store_category_top_id = ?)");
        binds.push(Bind::I(id));
        binds.push(Bind::I(id));
    }
    // web-only exact match: no existence check (an unknown or other-ledger
    // store id simply yields an empty result, like the items endpoint)
    if let Some(id) = f.store_id {
        sql.push_str(" AND f.store_id = ?");
        binds.push(Bind::I(id));
    }
    if let Some(s) = &f.store {
        let (frag, b) = store_like("f.store_id", s);
        sql.push_str(&frag);
        binds.extend(b);
    }
    if let Some(q) = &f.item_query {
        let (frag, b) = item_match("f.item_id", q)?;
        sql.push_str(&frag);
        binds.extend(b);
    }
    // web-only exact payment-method match (TASK-65)
    if let Some(pm) = &f.payment_method {
        sql.push_str(" AND f.payment_method = ?");
        binds.push(Bind::S(pm.clone()));
    }
    if let Some(colors) = f.label_colors.as_ref().filter(|c| !c.is_empty()) {
        let placeholders = vec!["?"; colors.len()].join(", ");
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = f.receipt_id AND rl.color IN ({placeholders}))"
        ));
        binds.extend(colors.iter().map(|c| Bind::S(c.as_str().to_string())));
    }
    Ok((sql, binds))
}

#[derive(Debug, thiserror::Error)]
pub enum FilterError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Store partial match on stores.name_norm / aliases (LIKE, escaped).
pub fn store_like(store_col: &str, q: &str) -> (String, Vec<Bind>) {
    let pat = format!("%{}%", escape_like(&normalize_text(q)));
    (
        format!(
            " AND {store_col} IN (SELECT s.id FROM stores s WHERE s.name_norm LIKE ? ESCAPE '\\'
               UNION SELECT a.store_id FROM store_aliases a WHERE a.alias_norm LIKE ? ESCAPE '\\')"
        ),
        vec![Bind::S(pat.clone()), Bind::S(pat)],
    )
}

/// Item name match (spec_data-model 13-2): normalized length >= 3 uses the
/// FTS5 trigram phrase, shorter queries use escaped LIKE.
pub fn item_match(item_col: &str, q: &str) -> Result<(String, Vec<Bind>), FilterError> {
    let norm = normalize_text(q);
    if norm.is_empty() {
        return Err(FilterError::Invalid("item_query が空です".into()));
    }
    if norm.chars().count() >= 3 {
        Ok((
            format!(
                " AND {item_col} IN (SELECT rowid FROM receipt_items_fts WHERE receipt_items_fts MATCH ?)"
            ),
            vec![Bind::S(fts_phrase(&norm))],
        ))
    } else {
        let pat = format!("%{}%", escape_like(&norm));
        Ok((
            format!(
                " AND {item_col} IN (SELECT id FROM receipt_items WHERE name_norm LIKE ? ESCAPE '\\' OR name_raw_norm LIKE ? ESCAPE '\\')"
            ),
            vec![Bind::S(pat.clone()), Bind::S(pat)],
        ))
    }
}

pub fn bind_all<'q, O>(
    mut q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    binds: &[Bind],
) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    for b in binds {
        q = match b {
            Bind::I(i) => q.bind(*i),
            Bind::S(s) => q.bind(s.clone()),
        };
    }
    q
}

/// bind_all for query_scalar (TASK-89 analysis).
fn bind_scalar<'q, O>(
    mut q: sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    binds: &[Bind],
) -> sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    for b in binds {
        q = match b {
            Bind::I(i) => q.bind(*i),
            Bind::S(s) => q.bind(s.clone()),
        };
    }
    q
}

// ---------------------------------------------------------------------------
// reports

pub const REPORTS: &[&str] = &[
    "monthly_overview",
    "by_category",
    "by_store",
    "monthly_trend",
    "by_payment_method",
    "item_price_history",
];

/// Default period per report (spec 10).
pub fn default_period(report: &str) -> Period {
    let preset = match report {
        "monthly_trend" | "item_price_history" => "last_12_months",
        _ => "this_month",
    };
    Period::Preset {
        preset: preset.into(),
    }
}

/// Grouped totals: (key, SUM(amount_incl), COUNT(DISTINCT receipt_id))
/// — the counted third column feeds the analysis metrics (TASK-89).
async fn grouped(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    key_expr: &str,
    filt: &(String, Vec<Bind>),
) -> sqlx::Result<Vec<(Option<String>, i64, i64)>> {
    let sql = format!(
        "SELECT CAST({key_expr} AS TEXT), SUM(f.amount_incl), COUNT(DISTINCT f.receipt_id)
         FROM v_item_facts f
         WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{}
         GROUP BY 1 ORDER BY 2 DESC",
        filt.0
    );
    let q = sqlx::query_as::<_, (Option<String>, i64, i64)>(sqlx::AssertSqlSafe(sql))
        .bind(ledger_id)
        .bind(fmt_date(r.from))
        .bind(fmt_date(r.to));
    bind_all(q, &filt.1).fetch_all(conn).await
}

async fn totals(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    filt: &(String, Vec<Bind>),
) -> sqlx::Result<(i64, i64)> {
    let sql = format!(
        "SELECT COALESCE(SUM(f.amount_incl), 0), COUNT(DISTINCT f.receipt_id)
         FROM v_item_facts f WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{}",
        filt.0
    );
    let q = sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(sql))
        .bind(ledger_id)
        .bind(fmt_date(r.from))
        .bind(fmt_date(r.to));
    bind_all(q, &filt.1).fetch_one(conn).await
}

/// Label lookup for grouped keys. `dim` adds "label" (ledger title first,
/// the palette display name otherwise; None = the unlabeled bucket); the
/// name-keyed axes (item 品名) fall through the default arm — the key is
/// the label.
async fn labels_for(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    dim: &str,
    key: Option<&str>,
) -> sqlx::Result<String> {
    let Some(k) = key else {
        return Ok(match dim {
            "store" => "店不明".into(),
            "payment_method" => "支払方法不明".into(),
            "label" => "ラベルなし".into(),
            _ => "未分類".into(),
        });
    };
    match dim {
        "category_top" | "category" => {
            let id: i64 = k.parse().unwrap_or(0);
            Ok(catalog::path_of(conn, CatKind::Item, id)
                .await?
                .unwrap_or_else(|| "未分類".into()))
        }
        "store" => {
            let id: i64 = k.parse().unwrap_or(0);
            Ok(
                sqlx::query_scalar::<_, String>("SELECT name FROM stores WHERE id = ?")
                    .bind(id)
                    .fetch_optional(conn)
                    .await?
                    .unwrap_or_else(|| "店不明".into()),
            )
        }
        "payment_method" => Ok(payment_label(k).into()),
        "label" => {
            let color = super::labels::LabelColor::parse(k);
            let title: Option<Option<String>> = sqlx::query_scalar::<_, Option<String>>(
                "SELECT title FROM ledger_labels WHERE ledger_id = ? AND color = ?",
            )
            .bind(ledger_id)
            .bind(k)
            .fetch_optional(conn)
            .await?;
            Ok(match title.flatten().filter(|t| !t.is_empty()) {
                Some(t) => t,
                None => color
                    .map(|c| c.display_ja().to_string())
                    .unwrap_or_else(|| "ラベルなし".into()),
            })
        }
        _ => Ok(k.to_string()),
    }
}

pub fn payment_label(k: &str) -> &'static str {
    match k {
        "cash" => "現金",
        "credit_card" => "クレジットカード",
        "debit_card" => "デビットカード",
        "e_money" => "電子マネー",
        "qr_code" => "QRコード決済",
        "point" => "ポイント",
        "gift_card" => "ギフトカード",
        "bank_transfer" => "銀行振込",
        "other" => "その他",
        _ => "支払方法不明",
    }
}

fn key_value(dim: &str, k: Option<&str>) -> Value {
    match (dim, k) {
        (_, None) => Value::Null,
        ("category_top" | "category" | "store", Some(k)) => {
            k.parse::<i64>().map(Value::from).unwrap_or(json!(k))
        }
        (_, Some(k)) => json!(k),
    }
}

/// Build a top-N + "その他" section with shares.
#[allow(clippy::too_many_arguments)]
async fn ranked_section(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    dim: &str,
    key_expr: &str,
    filt: &(String, Vec<Bind>),
    top: usize,
    id: &str,
    title: &str,
    chart: &str,
) -> sqlx::Result<StatsSection> {
    let cur = grouped(conn, ledger_id, r, key_expr, filt).await?;
    let total: i64 = cur.iter().map(|x| x.1).sum();
    let mut rows = Vec::new();
    let mut other_v = 0i64;
    let mut other_n = 0i64;
    for (i, (k, v, _)) in cur.iter().enumerate() {
        if i < top {
            let label = labels_for(conn, ledger_id, dim, k.as_deref()).await?;
            rows.push(StatsRow {
                keys: vec![key_value(dim, k.as_deref())],
                labels: vec![label],
                value: *v,
                share: share(*v, total),
            });
        } else {
            other_v += v;
            other_n += 1;
        }
    }
    if other_n > 0 {
        rows.push(StatsRow {
            keys: vec![Value::Null],
            labels: vec!["その他".into()],
            value: other_v,
            share: share(other_v, total),
        });
    }
    Ok(StatsSection {
        id: id.into(),
        title: title.into(),
        dims: vec![dim.into()],
        chart: chart.into(),
        rows,
        truncated_rows: (other_n > 0).then_some(other_n),
    })
}

fn share(v: i64, total: i64) -> Option<f64> {
    if total == 0 {
        None
    } else {
        Some(((v as f64 / total as f64) * 1000.0).round() / 1000.0)
    }
}

/// Monthly totals for every month in the range (zero-filled).
async fn monthly_section(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    filt: &(String, Vec<Bind>),
    id: &str,
    title: &str,
) -> sqlx::Result<StatsSection> {
    let got: HashMap<String, i64> = grouped(conn, ledger_id, r, "f.purchased_month", filt)
        .await?
        .into_iter()
        .filter_map(|(k, v, _)| Some((k?, v)))
        .collect();
    let mut rows = Vec::new();
    let mut m = month_start(r.from);
    while m <= r.to {
        let key = m.format("%Y-%m").to_string();
        rows.push(StatsRow {
            keys: vec![json!(key)],
            labels: vec![format!("{}年{}月", m.year(), m.month())],
            value: got.get(&key).copied().unwrap_or(0),
            share: None,
        });
        m = add_months(m, 1);
    }
    Ok(StatsSection {
        id: id.into(),
        title: title.into(),
        dims: vec!["month".into()],
        chart: "bar_v".into(),
        rows,
        truncated_rows: None,
    })
}

/// summarize_spending (spec 10). Err(FilterError::Invalid) = input error.
pub async fn summarize(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    report: &str,
    range: &Range,
    filters: &Filters,
    max_rows: usize,
) -> Result<(StatsResult, Value), FilterError> {
    // an empty label_colors array is "no filter" (spec 10)
    let filters = filters.clone().normalized();
    let filt = filter_sql(conn, ledger_id, &filters).await?;
    let (value, receipts) = totals(conn, ledger_id, range, &filt).await?;
    let top = 10usize.min(max_rows);
    let mut notes = Vec::new();
    let mut meta = json!({});
    let sections = match report {
        "monthly_overview" => {
            let cats = ranked_section(
                conn,
                ledger_id,
                range,
                "category_top",
                "f.category_top_id",
                &filt,
                top,
                "categories",
                "品目カテゴリ（大分類）別",
                "bar_h",
            )
            .await?;
            let stores = ranked_section(
                conn,
                ledger_id,
                range,
                "store",
                "f.store_id",
                &filt,
                5,
                "stores",
                "上位の店",
                "bar_h",
            )
            .await?;
            let six = Range {
                from: add_months(month_start(range.to), -5),
                to: month_end(range.to),
                label: String::new(),
                kind: "months:6".into(),
            };
            let trend =
                monthly_section(conn, ledger_id, &six, &filt, "trend", "直近6か月の推移").await?;
            // daily cumulative for the widget (_meta only)
            let sql = format!(
                "SELECT f.purchased_on, SUM(f.amount_incl) FROM v_item_facts f
                 WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{} GROUP BY 1 ORDER BY 1",
                filt.0
            );
            let q = sqlx::query_as::<_, (String, i64)>(sqlx::AssertSqlSafe(sql))
                .bind(ledger_id)
                .bind(fmt_date(range.from))
                .bind(fmt_date(range.to));
            let days = bind_all(q, &filt.1).fetch_all(&mut *conn).await?;
            let mut acc = 0i64;
            let cumulative: Vec<Value> = days
                .into_iter()
                .map(|(d, v)| {
                    acc += v;
                    json!({ "date": d, "value": acc })
                })
                .collect();
            meta = json!({ "daily_cumulative": cumulative });
            vec![cats, stores, trend]
        }
        "by_category" => {
            let (dim, expr, title) = match &filters.category {
                Some(c) if c.trim() != "未分類" => {
                    ("category", "f.category_id", format!("「{c}」の内訳"))
                }
                _ => (
                    "category_top",
                    "f.category_top_id",
                    "品目カテゴリ（大分類）別".to_string(),
                ),
            };
            vec![
                ranked_section(
                    conn,
                    ledger_id,
                    range,
                    dim,
                    expr,
                    &filt,
                    top,
                    "categories",
                    &title,
                    "bar_h",
                )
                .await?,
            ]
        }
        "by_store" => vec![
            ranked_section(
                conn,
                ledger_id,
                range,
                "store",
                "f.store_id",
                &filt,
                top,
                "stores",
                "店別",
                "bar_h",
            )
            .await?,
        ],
        "by_payment_method" => vec![
            ranked_section(
                conn,
                ledger_id,
                range,
                "payment_method",
                "f.payment_method",
                &filt,
                top,
                "payment_methods",
                "支払方法別",
                "bar_h",
            )
            .await?,
        ],
        "monthly_trend" => {
            vec![monthly_section(conn, ledger_id, range, &filt, "trend", "月別合計").await?]
        }
        "item_price_history" => {
            if filters
                .item_query
                .as_deref()
                .is_none_or(|q| q.trim().is_empty())
            {
                return Err(FilterError::Invalid(
                    "item_price_history には filters.item_query（品名）が必要です".into(),
                ));
            }
            let sql = format!(
                "SELECT f.item_id, f.purchased_on, f.store_id, f.name, f.quantity, i.unit_price, f.amount_incl
                 FROM v_item_facts f JOIN receipt_items i ON i.id = f.item_id
                 WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ? AND f.line_kind = 'item'{}
                 ORDER BY f.purchased_on, f.item_id LIMIT ?",
                filt.0
            );
            let q = sqlx::query_as::<_, (i64, String, Option<i64>, String, f64, Option<i64>, i64)>(
                sqlx::AssertSqlSafe(sql),
            )
            .bind(ledger_id)
            .bind(fmt_date(range.from))
            .bind(fmt_date(range.to));
            let rows_db = bind_all(q, &filt.1)
                .bind(max_rows as i64)
                .fetch_all(&mut *conn)
                .await?;
            let mut rows = Vec::new();
            for (item_id, date, store_id, name, qty, unit_price, incl) in rows_db {
                let price = unit_price.unwrap_or_else(|| (incl as f64 / qty).round() as i64);
                let store = labels_for(
                    conn,
                    ledger_id,
                    "store",
                    store_id.map(|s| s.to_string()).as_deref(),
                )
                .await?;
                rows.push(StatsRow {
                    keys: vec![json!(date), json!(store_id), json!(item_id)],
                    labels: vec![date.clone(), store, name],
                    value: price,
                    share: None,
                });
            }
            notes.push("値は1点あたりの単価（unit_price、無ければ金額÷数量）".into());
            vec![StatsSection {
                id: "prices".into(),
                title: "購入ごとの単価".into(),
                dims: vec!["month".into(), "store".into(), "item".into()],
                chart: "scatter_line".into(),
                rows,
                truncated_rows: None,
            }]
        }
        other => {
            return Err(FilterError::Invalid(format!(
                "report「{other}」は使えません（{}）",
                REPORTS.join(" / ")
            )));
        }
    };
    // "未分類" note
    let unc_sql = format!(
        "SELECT COALESCE(SUM(f.amount_incl), 0) FROM v_item_facts f
         WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ? AND f.category_id IS NULL{}",
        filt.0
    );
    let q = sqlx::query_as::<_, (i64,)>(sqlx::AssertSqlSafe(unc_sql))
        .bind(ledger_id)
        .bind(fmt_date(range.from))
        .bind(fmt_date(range.to));
    let (uncategorized,) = bind_all(q, &filt.1).fetch_one(&mut *conn).await?;
    notes.push("金額は税込換算（amount_incl）。値引行を含み、全体値引は未分類に含む".into());
    if uncategorized != 0 {
        notes.push(format!("未分類 {uncategorized} 円"));
    }
    if let Some(colors) = &filters.label_colors {
        let names = colors
            .iter()
            .map(|c| c.display_ja())
            .collect::<Vec<_>>()
            .join("・");
        notes.push(format!("ラベル絞り込み: {names}（いずれかを含むレシート）"));
    }
    Ok((
        StatsResult {
            report: Some(report.into()),
            period_resolved: range.resolved(),
            totals: StatsTotals { value, receipts },
            sections,
            notes,
            // echo of the applied filters (omitted when none)
            filters: (!filters.is_empty()).then(|| filters.clone()),
        },
        meta,
    ))
}

// ---------------------------------------------------------------------------
// web analysis aggregation (TASK-89)

/// Grouped aggregates with the counted third column: (key, SUM(amount_incl),
/// COUNT(DISTINCT receipt_id)), amount desc. The label axis joins
/// receipt_labels — a receipt with several labels posts its items to several
/// axis values, so the axis total can exceed the whole amount (the OR filter
/// semantics) — and appends the unlabeled bucket (key NULL) as its own row.
async fn axis_grouped(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    axis: Axis,
    filters: &Filters,
    filt: &(String, Vec<Bind>),
) -> sqlx::Result<Vec<(Option<String>, i64, i64)>> {
    if axis == Axis::Label {
        let labeled = format!(
            "SELECT rl.color AS \"k!: String\", SUM(f.amount_incl) AS \"a!: i64\",
                    COUNT(DISTINCT f.receipt_id) AS \"c!: i64\"
             FROM v_item_facts f JOIN receipt_labels rl ON rl.receipt_id = f.receipt_id
             WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{}
             GROUP BY rl.color ORDER BY 2 DESC",
            filt.0
        );
        let q = sqlx::query_as::<_, (String, i64, i64)>(sqlx::AssertSqlSafe(labeled))
            .bind(ledger_id)
            .bind(fmt_date(r.from))
            .bind(fmt_date(r.to));
        let mut rows: Vec<(Option<String>, i64, i64)> = bind_all(q, &filt.1)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .map(|(k, a, c)| (Some(k), a, c))
            .collect();
        let unlabeled = format!(
            "SELECT COALESCE(SUM(f.amount_incl), 0), COUNT(DISTINCT f.receipt_id)
             FROM v_item_facts f
             WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{}
               AND NOT EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = f.receipt_id)",
            filt.0
        );
        let q = sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(unlabeled))
            .bind(ledger_id)
            .bind(fmt_date(r.from))
            .bind(fmt_date(r.to));
        if let Some((a, c)) = bind_all(q, &filt.1).fetch_optional(&mut *conn).await?
            && c > 0
        {
            rows.push((None, a, c));
        }
        return Ok(rows);
    }
    grouped(conn, ledger_id, r, axis.key_expr(filters), filt).await
}

fn metric_json(metric: Metric, v: Option<f64>) -> Value {
    match v {
        None => Value::Null,
        Some(x) if metric == Metric::Unit => json!(x),
        Some(x) => json!(x as i64),
    }
}

async fn analysis_row(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    axis: Axis,
    key: Option<&str>,
    cur: (i64, i64),
    share_v: Option<f64>,
) -> sqlx::Result<AnalysisRow> {
    let (a, c) = cur;
    let label = labels_for(conn, ledger_id, axis.dim(), key).await?;
    Ok(AnalysisRow {
        key: match key {
            // the string-keyed axes (label color, item 品名); the rest are
            // numeric ids
            None => Value::Null,
            Some(k) if matches!(axis, Axis::Label | Axis::Item) => json!(k),
            Some(k) => k.parse::<i64>().map(Value::from).unwrap_or(json!(k)),
        },
        label,
        amount: a,
        count: c,
        unit: Metric::Unit.value(a, c),
        share: share_v,
    })
}

/// The breakdown endpoint aggregate: the period's totals and the axis values
/// ranked by the metric (spec_mcp-tools.md 12).
pub async fn analysis(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    axis: Axis,
    metric: Metric,
    range: &Range,
    filters: &Filters,
    limit: usize,
) -> Result<AnalysisResult, FilterError> {
    let filters = filters.clone().normalized();
    let filt = filter_sql(conn, ledger_id, &filters).await?;
    let cur = axis_grouped(conn, ledger_id, range, axis, &filters, &filt).await?;

    // the share base is the axis total (label axis: duplicate postings
    // included, so the shares sum to 100%)
    let axis_amount: i64 = cur.iter().map(|v| v.1).sum();
    let axis_count: i64 = cur.iter().map(|v| v.2).sum();
    let share_of = |v: &(Option<String>, i64, i64)| -> Option<f64> {
        match metric {
            Metric::Amount => share(v.1, axis_amount),
            Metric::Count => share(v.2, axis_count),
            Metric::Unit => None,
        }
    };

    // rank by the metric value, descending
    let mut ents = cur;
    ents.sort_by(|x, y| {
        metric
            .value(y.1, y.2)
            .unwrap_or(0.0)
            .partial_cmp(&metric.value(x.1, x.2).unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut rows = Vec::new();
    for e in ents.iter().take(limit) {
        rows.push(
            analysis_row(
                conn,
                ledger_id,
                axis,
                e.0.as_deref(),
                (e.1, e.2),
                share_of(e),
            )
            .await?,
        );
    }
    let truncated_rows = ents.len().saturating_sub(limit) as i64;

    let (ca, cc) = totals(conn, ledger_id, range, &filt).await?;
    Ok(AnalysisResult {
        axis: axis.as_str().into(),
        metric: metric.as_str().into(),
        period: range.resolved(),
        totals: AnalysisTotals {
            amount: ca,
            count: cc,
            unit: Metric::Unit.value(ca, cc),
            days: (range.to - range.from).num_days() + 1,
        },
        rows,
        truncated_rows,
        filters: (!filters.is_empty()).then(|| filters.clone()),
    })
}

/// Bucket expression per granularity. Week buckets are Monday-anchored
/// (same rule as the frontend week mode).
fn bucket_expr(g: Granularity) -> &'static str {
    match g {
        Granularity::Day => "f.purchased_on",
        Granularity::Week => {
            "date(f.purchased_on, '-' || ((strftime('%w', f.purchased_on)+6)%7) || ' days')"
        }
        Granularity::Month => "f.purchased_month",
    }
}

/// Zero-filled bucket keys ascending (day = date, week = Monday,
/// month = "YYYY-MM").
fn bucket_keys(g: Granularity, r: &Range) -> Vec<String> {
    match g {
        Granularity::Day => {
            let mut out = Vec::new();
            let mut d = r.from;
            while d <= r.to {
                out.push(fmt_date(d));
                d = d
                    .succ_opt()
                    .expect("date iteration ends at chrono MAX before overflow");
            }
            out
        }
        Granularity::Week => {
            let mut out = Vec::new();
            let mut d =
                r.from - chrono::Duration::days(r.from.weekday().num_days_from_monday() as i64);
            while d <= r.to {
                out.push(fmt_date(d));
                d += chrono::Duration::days(7);
            }
            out
        }
        Granularity::Month => {
            let mut out = Vec::new();
            let mut m = month_start(r.from);
            while m <= r.to {
                out.push(m.format("%Y-%m").to_string());
                m = add_months(m, 1);
            }
            out
        }
    }
}

/// The stacked matrix restricted to the top series: (bucket, key, amount,
/// count). Two-step per design: the whole-range axis ranking fixes the top N
/// first, this query narrows the matrix with an IN clause.
#[allow(clippy::too_many_arguments)]
async fn axis_matrix(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    axis: Axis,
    filters: &Filters,
    b_expr: &str,
    top: &[Option<String>],
    filt: &(String, Vec<Bind>),
) -> sqlx::Result<Vec<(String, Option<String>, i64, i64)>> {
    let solid: Vec<&String> = top.iter().filter_map(|k| k.as_ref()).collect();
    let ph = vec!["?"; solid.len()].join(", ");
    let mut out: Vec<(String, Option<String>, i64, i64)> = Vec::new();
    if axis == Axis::Label {
        if !solid.is_empty() {
            let sql = format!(
                "SELECT {b_expr} AS \"b!: String\", rl.color AS \"k!: String\",
                        SUM(f.amount_incl) AS \"a!: i64\", COUNT(DISTINCT f.receipt_id) AS \"c!: i64\"
                 FROM v_item_facts f JOIN receipt_labels rl ON rl.receipt_id = f.receipt_id
                 WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{} AND rl.color IN ({ph})
                 GROUP BY 1, 2",
                filt.0
            );
            let q = sqlx::query_as::<_, (String, String, i64, i64)>(sqlx::AssertSqlSafe(sql))
                .bind(ledger_id)
                .bind(fmt_date(r.from))
                .bind(fmt_date(r.to));
            let mut q = bind_all(q, &filt.1);
            for k in &solid {
                q = q.bind(k.as_str());
            }
            out.extend(
                q.fetch_all(&mut *conn)
                    .await?
                    .into_iter()
                    .map(|(b, k, a, c)| (b, Some(k), a, c)),
            );
        }
        if top.iter().any(|k| k.is_none()) {
            let sql = format!(
                "SELECT {b_expr} AS \"b!: String\", SUM(f.amount_incl) AS \"a!: i64\",
                        COUNT(DISTINCT f.receipt_id) AS \"c!: i64\"
                 FROM v_item_facts f
                 WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{}
                   AND NOT EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = f.receipt_id)
                 GROUP BY 1",
                filt.0
            );
            let q = sqlx::query_as::<_, (String, i64, i64)>(sqlx::AssertSqlSafe(sql))
                .bind(ledger_id)
                .bind(fmt_date(r.from))
                .bind(fmt_date(r.to));
            out.extend(
                bind_all(q, &filt.1)
                    .fetch_all(&mut *conn)
                    .await?
                    .into_iter()
                    .map(|(b, a, c)| (b, None, a, c)),
            );
        }
        return Ok(out);
    }
    let key = axis.key_expr(filters);
    // the IN restriction compares against the ranking's CAST(... AS TEXT)
    // keys: key_expr can be an affinity-less expression (COALESCE for
    // category_top_id), where a text bind never matches the raw integer —
    // CAST both sides to TEXT. It also carries a NULL alternative: a ranked
    // NULL key (未分類 / store-less rows) cannot match IN, and without its
    // rows the series zero-fills every bucket while its whole-range total
    // stays nonzero (PR#1 P2). An all-NULL top reduces to IS NULL alone —
    // the bare `IN ()` SQLite tolerates is an always-false predicate with
    // the same zero-fill corruption
    let in_pred = if solid.is_empty() {
        format!("{key} IS NULL")
    } else if top.iter().any(|k| k.is_none()) {
        format!("(CAST({key} AS TEXT) IN ({ph}) OR {key} IS NULL)")
    } else {
        format!("CAST({key} AS TEXT) IN ({ph})")
    };
    let sql = format!(
        "SELECT {b_expr} AS \"b!: String\", CAST({key} AS TEXT) AS k,
                SUM(f.amount_incl) AS \"a!: i64\", COUNT(DISTINCT f.receipt_id) AS \"c!: i64\"
         FROM v_item_facts f
         WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{} AND {in_pred}
         GROUP BY 1, 2",
        filt.0
    );
    let q = sqlx::query_as::<_, (String, Option<String>, i64, i64)>(sqlx::AssertSqlSafe(sql))
        .bind(ledger_id)
        .bind(fmt_date(r.from))
        .bind(fmt_date(r.to));
    let mut q = bind_all(q, &filt.1);
    for k in &solid {
        q = q.bind(k.as_str());
    }
    out.extend(q.fetch_all(&mut *conn).await?);
    Ok(out)
}

/// Per-bucket totals over EVERY axis value (top series + remainder; the
/// label axis keeps its duplicate postings so bucket_totals - series is the
/// frontend's "other" segment).
async fn axis_bucket_totals(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    axis: Axis,
    b_expr: &str,
    filt: &(String, Vec<Bind>),
) -> sqlx::Result<Vec<(String, i64, i64)>> {
    // the WHERE tail (filters + the label axis's NOT EXISTS) is composed
    // INSIDE the clause: appending predicates after `GROUP BY 1` makes SQLite
    // parse them as part of the grouping expression instead of row filters
    // (PR#1 P1 — a filtered trend silently summed unrelated buckets)
    let base = |table: &str, tail: &str| {
        format!(
            "SELECT {b_expr} AS \"b!: String\", COALESCE(SUM(f.amount_incl), 0) AS \"a!: i64\",
                    COUNT(DISTINCT f.receipt_id) AS \"c!: i64\"
             FROM {table}
             WHERE f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ?{tail}
             GROUP BY 1"
        )
    };
    if axis == Axis::Label {
        let labeled = base(
            "v_item_facts f JOIN receipt_labels rl ON rl.receipt_id = f.receipt_id",
            &filt.0,
        );
        let q = sqlx::query_as::<_, (String, i64, i64)>(sqlx::AssertSqlSafe(labeled))
            .bind(ledger_id)
            .bind(fmt_date(r.from))
            .bind(fmt_date(r.to));
        let mut merged: HashMap<String, (i64, i64)> = bind_all(q, &filt.1)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .map(|(b, a, c)| (b, (a, c)))
            .collect();
        let unlabeled_tail = format!(
            " AND NOT EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = f.receipt_id){}",
            filt.0
        );
        let unlabeled = base("v_item_facts f", &unlabeled_tail);
        let q = sqlx::query_as::<_, (String, i64, i64)>(sqlx::AssertSqlSafe(unlabeled))
            .bind(ledger_id)
            .bind(fmt_date(r.from))
            .bind(fmt_date(r.to));
        for (b, a, c) in bind_all(q, &filt.1).fetch_all(&mut *conn).await? {
            let e = merged.entry(b).or_insert((0, 0));
            e.0 += a;
            e.1 += c;
        }
        return Ok(merged.into_iter().map(|(b, (a, c))| (b, a, c)).collect());
    }
    let sql = base("v_item_facts f", &filt.0);
    let q = sqlx::query_as::<_, (String, i64, i64)>(sqlx::AssertSqlSafe(sql))
        .bind(ledger_id)
        .bind(fmt_date(r.from))
        .bind(fmt_date(r.to));
    bind_all(q, &filt.1).fetch_all(conn).await
}

/// The stacked-trend endpoint: zero-filled buckets, the top `limit` series by
/// whole-range metric total (two-step), per-bucket totals.
#[allow(clippy::too_many_arguments)]
pub async fn analysis_trend(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    axis: Axis,
    metric: Metric,
    range: &Range,
    granularity: Granularity,
    filters: &Filters,
    limit: usize,
) -> Result<TrendResult, FilterError> {
    let filters = filters.clone().normalized();
    let filt = filter_sql(conn, ledger_id, &filters).await?;

    // step 1: whole-range axis ranking
    let g = granularity;
    let mut ranked: Vec<(Option<String>, i64, i64)> =
        axis_grouped(conn, ledger_id, range, axis, &filters, &filt).await?;
    ranked.sort_by(|x, y| {
        metric
            .value(y.1, y.2)
            .unwrap_or(0.0)
            .partial_cmp(&metric.value(x.1, x.2).unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let truncated_rows = ranked.len().saturating_sub(limit) as i64;
    let top: Vec<Option<String>> = ranked
        .iter()
        .take(limit)
        .map(|(k, _, _)| k.clone())
        .collect();

    // step 2: the matrix narrowed to the top keys
    let b_expr = bucket_expr(g);
    let matrix = axis_matrix(conn, ledger_id, range, axis, &filters, b_expr, &top, &filt).await?;
    let buckets = bucket_keys(g, range);
    let cells: HashMap<(Option<String>, String), (i64, i64)> = matrix
        .into_iter()
        .map(|(b, k, a, c)| ((k, b), (a, c)))
        .collect();

    let mut series = Vec::new();
    for (k, ta, tc) in ranked.iter().take(limit) {
        let mut values = Vec::with_capacity(buckets.len());
        for b in &buckets {
            let (a, c) = cells
                .get(&(k.clone(), b.clone()))
                .copied()
                .unwrap_or((0, 0));
            values.push(metric_json(metric, metric.value(a, c)));
        }
        let label = labels_for(conn, ledger_id, axis.dim(), k.as_deref()).await?;
        series.push(TrendSeries {
            key: match k.as_deref() {
                None => Value::Null,
                Some(v) if matches!(axis, Axis::Label | Axis::Item) => json!(v),
                Some(v) => v.parse::<i64>().map(Value::from).unwrap_or(json!(v)),
            },
            label,
            values,
            total: metric_json(metric, metric.value(*ta, *tc)),
        });
    }

    let totals_map: HashMap<String, (i64, i64)> =
        axis_bucket_totals(conn, ledger_id, range, axis, b_expr, &filt)
            .await?
            .into_iter()
            .map(|(b, a, c)| (b, (a, c)))
            .collect();
    let bucket_totals = buckets
        .iter()
        .map(|b| {
            let (a, c) = totals_map.get(b).copied().unwrap_or((0, 0));
            metric_json(metric, metric.value(a, c))
        })
        .collect();

    Ok(TrendResult {
        axis: axis.as_str().into(),
        metric: metric.as_str().into(),
        granularity: g.as_str().into(),
        period: range.resolved(),
        buckets,
        series,
        bucket_totals,
        truncated_rows,
    })
}

/// The item stats endpoint (the web version of item_price_history): prices
/// with the unit-price rule, by-store, zero-filled monthly, and the summary.
/// `item_id` wins over `item_query` (the widget-compatible item_match).
pub async fn analysis_item(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    item_id: Option<i64>,
    item_query: Option<&str>,
    range: &Range,
    filters: &Filters,
    max_rows: usize,
) -> Result<ItemStatsResult, FilterError> {
    let filters = filters.clone().normalized();
    let filt = filter_sql(conn, ledger_id, &filters).await?;
    // the item restriction rides every query after the period binds
    let (item_frag, item_binds): (String, Vec<Bind>) = match (item_id, item_query) {
        (Some(id), _) => (" AND f.item_id = ?".into(), vec![Bind::I(id)]),
        (None, Some(q)) => item_match("f.item_id", q)?,
        (None, None) => {
            return Err(FilterError::Invalid(
                "item_id か item_query のどちらかが必要です".into(),
            ));
        }
    };
    let where_sql = format!(
        "f.ledger_id = ? AND f.purchased_on BETWEEN ? AND ? AND f.line_kind = 'item'{item_frag}{}",
        filt.0
    );
    let prices_sql = format!(
        "SELECT f.item_id AS \"i!: i64\", f.purchased_on AS \"d!: String\", f.store_id, i.unit_price,
                f.amount_incl AS \"a!: i64\", f.quantity AS \"q!: f64\"
         FROM v_item_facts f JOIN receipt_items i ON i.id = f.item_id
         WHERE {where_sql}
         ORDER BY f.purchased_on, f.item_id LIMIT ?"
    );
    let price_q = sqlx::query_as::<_, (i64, String, Option<i64>, Option<i64>, i64, f64)>(
        sqlx::AssertSqlSafe(prices_sql),
    )
    .bind(ledger_id)
    .bind(fmt_date(range.from))
    .bind(fmt_date(range.to));
    let price_q = bind_all(price_q, &item_binds);
    let price_q = bind_all(price_q, &filt.1);
    let price_rows = price_q.bind(max_rows as i64).fetch_all(&mut *conn).await?;
    let total_lines: i64 = {
        let sql = format!("SELECT COUNT(*) FROM v_item_facts f WHERE {where_sql}");
        let q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
            .bind(ledger_id)
            .bind(fmt_date(range.from))
            .bind(fmt_date(range.to));
        let q = bind_scalar(q, &item_binds);
        bind_scalar(q, &filt.1).fetch_one(&mut *conn).await?
    };

    // SQLite ROUND() is REAL: CAST keeps MIN/MAX in the INTEGER price domain
    let unit_expr = "CAST(COALESCE(i.unit_price, ROUND(i.amount_incl / i.quantity)) AS INTEGER)";
    let (n_lines, amount, min_p, max_p, avg_p, last_on): (
        i64,
        i64,
        Option<i64>,
        Option<i64>,
        Option<f64>,
        Option<String>,
    ) = {
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(f.amount_incl), 0),
                    MIN({unit_expr}), MAX({unit_expr}), AVG({unit_expr}), MAX(f.purchased_on)
             FROM v_item_facts f JOIN receipt_items i ON i.id = f.item_id
             WHERE {where_sql}"
        );
        let q = sqlx::query_as::<_, _>(sqlx::AssertSqlSafe(sql))
            .bind(ledger_id)
            .bind(fmt_date(range.from))
            .bind(fmt_date(range.to));
        let q = bind_all(q, &item_binds);
        bind_all(q, &filt.1).fetch_one(&mut *conn).await?
    };

    let by_store_rows: Vec<(Option<i64>, i64, i64, Option<f64>)> = {
        let sql = format!(
            "SELECT f.store_id, COUNT(*), COALESCE(SUM(f.amount_incl), 0), AVG({unit_expr})
             FROM v_item_facts f JOIN receipt_items i ON i.id = f.item_id
             WHERE {where_sql} GROUP BY f.store_id ORDER BY 3 DESC"
        );
        let q = sqlx::query_as::<_, (Option<i64>, i64, i64, Option<f64>)>(sqlx::AssertSqlSafe(sql))
            .bind(ledger_id)
            .bind(fmt_date(range.from))
            .bind(fmt_date(range.to));
        let q = bind_all(q, &item_binds);
        bind_all(q, &filt.1).fetch_all(&mut *conn).await?
    };

    let monthly_rows: Vec<(String, i64, i64)> = {
        let sql = format!(
            "SELECT f.purchased_month AS \"ym!: String\", COUNT(*), COALESCE(SUM(f.amount_incl), 0)
             FROM v_item_facts f WHERE {where_sql} GROUP BY 1"
        );
        let q = sqlx::query_as::<_, (String, i64, i64)>(sqlx::AssertSqlSafe(sql))
            .bind(ledger_id)
            .bind(fmt_date(range.from))
            .bind(fmt_date(range.to));
        let q = bind_all(q, &item_binds);
        bind_all(q, &filt.1).fetch_all(&mut *conn).await?
    };

    // the representative item: the explicit id when given (if it exists in
    // this ledger), otherwise the latest purchase among the item_query
    // matches (複数マッチ時は最新購入名の代表)
    let item = match item_id {
        Some(id) => sqlx::query_as::<_, (i64, String)>(
            "SELECT id, name FROM receipt_items WHERE id = ? AND ledger_id = ?",
        )
        .bind(id)
        .bind(ledger_id)
        .fetch_optional(&mut *conn)
        .await?
        .map(|(item_id, name)| ItemRef { item_id, name }),
        None => {
            let sql = format!(
                "SELECT f.item_id AS \"i!: i64\" FROM v_item_facts f
                 WHERE {where_sql} ORDER BY f.purchased_on DESC, f.amount_incl DESC LIMIT 1"
            );
            let q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
                .bind(ledger_id)
                .bind(fmt_date(range.from))
                .bind(fmt_date(range.to));
            let q = bind_scalar(q, &item_binds);
            match bind_scalar(q, &filt.1).fetch_optional(&mut *conn).await? {
                Some(i) => {
                    let name: String = sqlx::query_scalar::<_, String>(
                        "SELECT name FROM receipt_items WHERE id = ?",
                    )
                    .bind(i)
                    .fetch_optional(&mut *conn)
                    .await?
                    .unwrap_or_else(|| "品目不明".into());
                    Some(ItemRef { item_id: i, name })
                }
                None => None,
            }
        }
    };

    let mut prices = Vec::new();
    for (_i, date, store_id, unit_price, incl, qty) in price_rows {
        let store_name = labels_for(
            conn,
            ledger_id,
            "store",
            store_id.map(|s| s.to_string()).as_deref(),
        )
        .await?;
        prices.push(ItemPrice {
            date,
            store_id,
            store_name,
            unit_price: unit_price.unwrap_or_else(|| (incl as f64 / qty).round() as i64),
            quantity: qty,
            amount_incl: incl,
        });
    }
    let mut by_store = Vec::new();
    let mut stores = Vec::new();
    for (sid, cnt, amt, avg) in &by_store_rows {
        let name = labels_for(
            conn,
            ledger_id,
            "store",
            sid.map(|s| s.to_string()).as_deref(),
        )
        .await?;
        stores.push(name.clone());
        by_store.push(ItemStoreAgg {
            store_id: *sid,
            store_name: name,
            count: *cnt,
            amount: *amt,
            avg_unit_price: avg.map(|v| v.round() as i64),
        });
    }
    let monthly_map: HashMap<String, (i64, i64)> = monthly_rows
        .into_iter()
        .map(|(ym, c, a)| (ym, (c, a)))
        .collect();
    let mut monthly = Vec::new();
    let mut m = month_start(range.from);
    while m <= range.to {
        let ym = m.format("%Y-%m").to_string();
        let (c, a) = monthly_map.get(&ym).copied().unwrap_or((0, 0));
        monthly.push(ItemMonthly {
            ym,
            count: c,
            amount: a,
        });
        m = add_months(m, 1);
    }

    Ok(ItemStatsResult {
        item,
        period: range.resolved(),
        summary: ItemStatsSummary {
            count: n_lines,
            amount,
            avg_unit_price: avg_p.map(|v| v.round() as i64),
            min_unit_price: min_p,
            max_unit_price: max_p,
            last_purchased_on: last_on,
            stores,
        },
        prices,
        by_store,
        monthly,
        truncated_rows: total_lines.saturating_sub(max_rows as i64).max(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    // [covers:mcp-stats.period-resolution]
    #[test]
    fn periods_resolution() {
        let today = d("2026-10-14");
        let p = |v: Value| resolve_period(&parse_period(&v).unwrap(), today);
        let m = p(json!({"preset": "this_month"})).unwrap();
        assert_eq!(
            (fmt_date(m.from), fmt_date(m.to)),
            ("2026-10-01".into(), "2026-10-31".into())
        );
        assert_eq!(m.label, "2026年10月");
        let lm = p(json!({"preset": "last_month"})).unwrap();
        assert_eq!(fmt_date(lm.from), "2026-09-01");
        let y = p(json!({"preset": "last_year"})).unwrap();
        assert_eq!(
            (fmt_date(y.from), fmt_date(y.to)),
            ("2025-01-01".into(), "2025-12-31".into())
        );
        let l3 = p(json!({"preset": "last_3_months"})).unwrap();
        assert_eq!(
            (fmt_date(l3.from), fmt_date(l3.to)),
            ("2026-08-01".into(), "2026-10-31".into())
        );
        let mo = p(json!({"month": "2026-02"})).unwrap();
        assert_eq!(fmt_date(mo.to), "2026-02-28");
        assert!(p(json!({"from": "2026-10-01", "to": "2026-10-10"})).is_ok());
        assert!(p(json!({"from": "2026-10-10", "to": "2026-10-01"})).is_err());
        assert!(p(json!({"preset": "yesterday"})).is_err());
        assert!(parse_period(&json!({"month": 3})).is_err());
        assert!(p(json!({"month": "2026-13"})).is_err());
    }

    // [covers:web-data-api.analysis-parsers]
    #[test]
    fn analysis_axis_metric_granularity_parse() {
        // axis / metric / granularity の parse と auto 閾値（62/366 日）
        assert_eq!(Axis::parse("category"), Some(Axis::Category));
        assert_eq!(Axis::parse("nope"), None);
        assert_eq!(Metric::parse("unit"), Some(Metric::Unit));
        assert_eq!(Metric::parse("avg"), None, "IF 固定で unit のみ");
        assert_eq!(Granularity::auto(62), Granularity::Day);
        assert_eq!(Granularity::auto(63), Granularity::Week);
        assert_eq!(Granularity::auto(366), Granularity::Week);
        assert_eq!(Granularity::auto(367), Granularity::Month);
    }
}
