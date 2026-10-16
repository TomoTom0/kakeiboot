//! Period resolution and the summarize_spending reports
//! (spec_mcp-tools.md 7-1 Period, 10; spec_data-model.md 13-3 v_item_facts).
//! The metric is always SUM(amount_incl) (discount lines included).

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use super::catalog::{self, CatKind};
use super::dto::{PeriodResolved, StatsResult, StatsRow, StatsSection, StatsTotals};
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

/// A resolved inclusive date range plus the kind used for the compare period.
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

    /// The same-length period right before (month -> previous month, year ->
    /// previous year, ranges -> same number of days).
    pub fn previous(&self) -> Range {
        if self.kind == "month" {
            let s = add_months(self.from, -1);
            return month_range(s);
        }
        if self.kind == "year" {
            return year_range(self.from.year() - 1);
        }
        if let Some(n) = self
            .kind
            .strip_prefix("months:")
            .and_then(|n| n.parse::<i32>().ok())
        {
            let s = add_months(self.from, -n);
            let e = add_months(self.from, 0).pred_opt().expect("date");
            return Range {
                from: s,
                to: e,
                label: format!("{}〜{}", fmt_date(s), fmt_date(e)),
                kind: self.kind.clone(),
            };
        }
        let days = (self.to - self.from).num_days() + 1;
        let e = self.from.pred_opt().expect("date");
        let s = e - chrono::Duration::days(days - 1);
        Range {
            from: s,
            to: e,
            label: format!("{}〜{}", fmt_date(s), fmt_date(e)),
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

/// Grouped totals: (key, label, value, receipts).
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

/// Label lookup for grouped keys.
async fn labels_for(
    conn: &mut SqliteConnection,
    dim: &str,
    key: Option<&str>,
) -> sqlx::Result<String> {
    let Some(k) = key else {
        return Ok(match dim {
            "store" => "店不明".into(),
            "payment_method" => "支払方法不明".into(),
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

/// Build a top-N + "その他" section with compare values and shares.
#[allow(clippy::too_many_arguments)]
async fn ranked_section(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    r: &Range,
    cmp: Option<&Range>,
    dim: &str,
    key_expr: &str,
    filt: &(String, Vec<Bind>),
    top: usize,
    id: &str,
    title: &str,
    chart: &str,
) -> sqlx::Result<StatsSection> {
    let cur = grouped(conn, ledger_id, r, key_expr, filt).await?;
    let prev: HashMap<Option<String>, i64> = match cmp {
        Some(c) => grouped(conn, ledger_id, c, key_expr, filt)
            .await?
            .into_iter()
            .map(|(k, v, _)| (k, v))
            .collect(),
        None => HashMap::new(),
    };
    let total: i64 = cur.iter().map(|x| x.1).sum();
    let mut rows = Vec::new();
    let mut other_v = 0i64;
    let mut other_c = 0i64;
    let mut other_n = 0i64;
    for (i, (k, v, _)) in cur.iter().enumerate() {
        if i < top {
            let label = labels_for(conn, dim, k.as_deref()).await?;
            let cv = cmp.map(|_| prev.get(k).copied().unwrap_or(0));
            rows.push(StatsRow {
                keys: vec![key_value(dim, k.as_deref())],
                labels: vec![label],
                value: *v,
                compare_value: cv,
                diff: cv.map(|c| v - c),
                share: share(*v, total),
            });
        } else {
            other_v += v;
            other_c += prev.get(k).copied().unwrap_or(0);
            other_n += 1;
        }
    }
    if other_n > 0 {
        rows.push(StatsRow {
            keys: vec![Value::Null],
            labels: vec!["その他".into()],
            value: other_v,
            compare_value: cmp.map(|_| other_c),
            diff: cmp.map(|_| other_v - other_c),
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
            compare_value: None,
            diff: None,
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
    let compare = !matches!(report, "monthly_trend" | "item_price_history");
    let cmp = compare.then(|| range.previous());
    let (value, receipts) = totals(conn, ledger_id, range, &filt).await?;
    let compare_value = match &cmp {
        Some(c) => Some(totals(conn, ledger_id, c, &filt).await?.0),
        None => None,
    };
    let diff = compare_value.map(|c| value - c);
    let diff_pct = compare_value
        .filter(|c| *c != 0)
        .map(|c| (((value - c) as f64 / c as f64) * 1000.0).round() / 10.0);
    let top = 10usize.min(max_rows);
    let mut notes = Vec::new();
    let mut meta = json!({});
    let sections = match report {
        "monthly_overview" => {
            let cats = ranked_section(
                conn,
                ledger_id,
                range,
                cmp.as_ref(),
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
                cmp.as_ref(),
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
                    cmp.as_ref(),
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
                cmp.as_ref(),
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
                cmp.as_ref(),
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
                let store =
                    labels_for(conn, "store", store_id.map(|s| s.to_string()).as_deref()).await?;
                rows.push(StatsRow {
                    keys: vec![json!(date), json!(store_id), json!(item_id)],
                    labels: vec![date.clone(), store, name],
                    value: price,
                    compare_value: None,
                    diff: None,
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
            compare_period: cmp.as_ref().map(Range::resolved),
            totals: StatsTotals {
                value,
                compare_value,
                diff,
                diff_pct,
                receipts,
            },
            sections,
            notes,
            // echo of the applied filters (omitted when none)
            filters: (!filters.is_empty()).then(|| filters.clone()),
        },
        meta,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    // [covers:mcp-stats.period-resolution]
    #[test]
    fn periods_and_compare() {
        let today = d("2026-10-14");
        let p = |v: Value| resolve_period(&parse_period(&v).unwrap(), today);
        let m = p(json!({"preset": "this_month"})).unwrap();
        assert_eq!(
            (fmt_date(m.from), fmt_date(m.to)),
            ("2026-10-01".into(), "2026-10-31".into())
        );
        assert_eq!(m.label, "2026年10月");
        let prev = m.previous();
        assert_eq!(
            (fmt_date(prev.from), fmt_date(prev.to)),
            ("2026-09-01".into(), "2026-09-30".into())
        );
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
        assert_eq!(fmt_date(l3.previous().from), "2026-05-01");
        let mo = p(json!({"month": "2026-02"})).unwrap();
        assert_eq!(fmt_date(mo.to), "2026-02-28");
        let r = p(json!({"from": "2026-10-01", "to": "2026-10-10"})).unwrap();
        let rp = r.previous();
        assert_eq!(
            (fmt_date(rp.from), fmt_date(rp.to)),
            ("2026-09-21".into(), "2026-09-30".into())
        );
        assert!(p(json!({"from": "2026-10-10", "to": "2026-10-01"})).is_err());
        assert!(p(json!({"preset": "yesterday"})).is_err());
        assert!(parse_period(&json!({"month": 3})).is_err());
        assert!(p(json!({"month": "2026-13"})).is_err());
    }
}
