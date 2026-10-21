//! Receipt color labels (spec_data-model.md 6-4, spec_mcp-tools.md 7-21):
//! a fixed five-color palette defined per ledger (`ledger_labels`, seeded by
//! the migration 0009 trigger) and its assignments on confirmed receipts
//! (`receipt_labels`, insert/delete only). Assignments are a commutative,
//! idempotent diff (add / remove) outside `receipts.revision`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, Connection, SqliteConnection, SqlitePool};

use super::actor::Actor;
use super::catalog;
use super::dto::Label;
use crate::auth::ledger::LedgerRole;

/// One palette color. The serde form is the wire / DB key; the display order
/// is [`LABEL_COLORS`] (spec_mcp-tools.md 7-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelColor {
    Red,
    Yellow,
    Green,
    Blue,
    Purple,
}

/// The canonical palette in definition (UI / seed) order. Keep in sync with
/// the seed trigger and backfill of `migrations/0009_labels.sql` (checked by
/// the `db-schema.ledger-labels-match-enum` condition).
pub const LABEL_COLORS: &[LabelColor] = &[
    LabelColor::Red,
    LabelColor::Yellow,
    LabelColor::Green,
    LabelColor::Blue,
    LabelColor::Purple,
];

impl LabelColor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Red => "red",
            Self::Yellow => "yellow",
            Self::Green => "green",
            Self::Blue => "blue",
            Self::Purple => "purple",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        LABEL_COLORS.iter().copied().find(|c| c.as_str() == s)
    }

    /// Japanese display name used in notes / texts.
    pub fn display_ja(self) -> &'static str {
        match self {
            Self::Red => "赤",
            Self::Yellow => "黄",
            Self::Green => "緑",
            Self::Blue => "青",
            Self::Purple => "紫",
        }
    }

    fn order(self) -> usize {
        LABEL_COLORS
            .iter()
            .position(|c| *c == self)
            .unwrap_or(usize::MAX)
    }
}

fn sort_colors(colors: &mut [LabelColor]) {
    colors.sort_by_key(|c| c.order());
}

/// Normalize a label color list (TASK-21 draft labels): drop duplicates and
/// restore the palette definition order. Callers turn an empty result into
/// `None` ("no labels") before storing it in the draft payload
/// (spec_mcp-tools.md 7-1).
pub fn normalize_colors(colors: &mut Vec<LabelColor>) {
    sort_colors(colors);
    colors.dedup();
}

/// The five definitions of a ledger in definition order (title NULL = color
/// only). Ledgers without rows (unknown id) simply yield an empty vec.
pub async fn list_labels(conn: &mut SqliteConnection, ledger_id: i64) -> sqlx::Result<Vec<Label>> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT color, title FROM ledger_labels WHERE ledger_id = ?")
            .bind(ledger_id)
            .fetch_all(&mut *conn)
            .await?;
    let mut labels: Vec<Label> = rows
        .into_iter()
        .filter_map(|(c, title)| {
            Some(Label {
                color: LabelColor::parse(&c)?,
                title,
            })
        })
        .collect();
    labels.sort_by_key(|l| l.color.order());
    Ok(labels)
}

/// Labels of the given receipts (one query for the whole page; titles come
/// from the ledger definitions). Receipts without labels are absent from the
/// map.
pub async fn labels_of(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    receipt_ids: &[i64],
) -> sqlx::Result<HashMap<i64, Vec<Label>>> {
    let mut map: HashMap<i64, Vec<Label>> = HashMap::new();
    if receipt_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; receipt_ids.len()].join(", ");
    let sql = format!(
        "SELECT rl.receipt_id, rl.color, ll.title
         FROM receipt_labels rl
         JOIN ledger_labels ll ON ll.ledger_id = rl.ledger_id AND ll.color = rl.color
         WHERE rl.ledger_id = ? AND rl.receipt_id IN ({placeholders})"
    );
    let mut q = sqlx::query_as::<_, (i64, String, Option<String>)>(sqlx::AssertSqlSafe(sql))
        .bind(ledger_id);
    for id in receipt_ids {
        q = q.bind(id);
    }
    for (rid, color, title) in q.fetch_all(&mut *conn).await? {
        if let Some(c) = LabelColor::parse(&color) {
            map.entry(rid).or_default().push(Label { color: c, title });
        }
    }
    for labels in map.values_mut() {
        labels.sort_by_key(|l| l.color.order());
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// title editing (web only, spec_mcp-tools.md 12)

/// Result of `set_title`.
pub struct LabelChange {
    pub label: Label,
    pub before_title: Option<String>,
    pub changed: bool,
}

/// Apply (or clear) a label title: trim, empty -> NULL, length cap, and no
/// audit row when the value is unchanged (spec_data-model.md 6-4).
#[allow(clippy::too_many_arguments)]
pub async fn set_title(
    pool: &SqlitePool,
    ledger_id: i64,
    role: LedgerRole,
    actor: &Actor,
    color: LabelColor,
    title: Option<&str>,
    max_chars: usize,
    now: i64,
) -> Result<LabelChange, LabelError> {
    if role < LedgerRole::Editor {
        return Err(LabelError::Forbidden);
    }
    let next = title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if next.as_ref().is_some_and(|t| t.chars().count() > max_chars) {
        return Err(LabelError::Invalid(vec![format!(
            "title: {max_chars}字以内の文字列か null"
        )]));
    }
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    // outer Option: the definition row exists; inner: title NULL = color only
    let row: Option<Option<String>> =
        sqlx::query_scalar("SELECT title FROM ledger_labels WHERE ledger_id = ? AND color = ?")
            .bind(ledger_id)
            .bind(color.as_str())
            .fetch_optional(&mut *tx)
            .await?;
    let Some(current) = row else {
        return Err(LabelError::NotFound);
    };
    if current == next {
        return Ok(LabelChange {
            label: Label {
                color,
                title: current.clone(),
            },
            before_title: current,
            changed: false,
        });
    }
    sqlx::query(
        "UPDATE ledger_labels SET title = ?, updated_at = ? WHERE ledger_id = ? AND color = ?",
    )
    .bind(&next)
    .bind(now)
    .bind(ledger_id)
    .bind(color.as_str())
    .execute(&mut *tx)
    .await?;
    catalog::audit(
        &mut tx,
        ledger_id,
        actor,
        "ledger_label",
        ledger_id,
        "update",
        Some(&serde_json::json!({ "color": color.as_str(), "title": current })),
        Some(&serde_json::json!({ "color": color.as_str(), "title": next })),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(LabelChange {
        label: Label { color, title: next },
        before_title: current,
        changed: true,
    })
}

// ---------------------------------------------------------------------------
// assignment diff (add / remove)

/// Why a receipt_id was not labeled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    NotFound,
    Deleted,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Deleted => "deleted",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::NotFound => 0,
            Self::Deleted => 1,
        }
    }
}

/// Result of `apply`: the resolved receipts with their labels after the diff,
/// and the receipt_ids that were skipped (other ledger / missing / deleted).
pub struct ApplyOutcome {
    pub receipts: Vec<(i64, Vec<Label>)>,
    pub skipped: Vec<(i64, SkipReason)>,
}

/// Add / remove labels on receipts in one BEGIN IMMEDIATE transaction.
/// Commutative and idempotent (add is INSERT OR IGNORE, remove is DELETE);
/// `receipts.revision` / `updated_at` are not touched. Only receipts whose
/// label set actually changed get an audit row (`receipt` / `label` with the
/// before / after color arrays).
#[allow(clippy::too_many_arguments)]
pub async fn apply(
    pool: &SqlitePool,
    ledger_id: i64,
    role: LedgerRole,
    actor: &Actor,
    receipt_ids: &[i64],
    add: &[LabelColor],
    remove: &[LabelColor],
    now: i64,
) -> Result<ApplyOutcome, LabelError> {
    if role < LedgerRole::Editor {
        return Err(LabelError::Forbidden);
    }
    if receipt_ids.is_empty() {
        return Err(LabelError::Invalid(vec![
            "receipt_ids: 対象のレシートを1件以上指定してください".into(),
        ]));
    }
    if add.is_empty() && remove.is_empty() {
        return Err(LabelError::Invalid(vec![
            "add / remove: 付与または解除する色を指定してください".into(),
        ]));
    }
    if let Some(c) = add.iter().find(|c| remove.contains(c)) {
        return Err(LabelError::Invalid(vec![format!(
            "add / remove: 同じ色（{}）を付与と解除の両方には指定できません",
            c.as_str()
        )]));
    }
    let mut ids = receipt_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();

    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    // resolve the targets within the ledger (missing and other-ledger look
    // the same; deleted receipts are skipped, not errors)
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT id, deleted_at IS NOT NULL FROM receipts WHERE ledger_id = ? AND id IN ({placeholders})"
    );
    let mut q = sqlx::query_as::<_, (i64, bool)>(sqlx::AssertSqlSafe(sql)).bind(ledger_id);
    for id in &ids {
        q = q.bind(id);
    }
    let found: HashMap<i64, bool> = q.fetch_all(&mut *tx).await?.into_iter().collect();

    let mut skipped: Vec<(i64, SkipReason)> = Vec::new();
    let mut targets: Vec<i64> = Vec::new();
    for id in &ids {
        match found.get(id) {
            None => skipped.push((*id, SkipReason::NotFound)),
            Some(true) => skipped.push((*id, SkipReason::Deleted)),
            Some(false) => targets.push(*id),
        }
    }
    skipped.sort_by_key(|(_, r)| r.rank());

    // current label sets of the targets
    let mut before: HashMap<i64, Vec<LabelColor>> = HashMap::new();
    if !targets.is_empty() {
        let ph = vec!["?"; targets.len()].join(", ");
        let before_sql =
            format!("SELECT receipt_id, color FROM receipt_labels WHERE receipt_id IN ({ph})");
        let mut q = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(before_sql));
        for id in &targets {
            q = q.bind(id);
        }
        for (rid, color) in q.fetch_all(&mut *tx).await? {
            if let Some(c) = LabelColor::parse(&color) {
                before.entry(rid).or_default().push(c);
            }
        }
        for colors in before.values_mut() {
            sort_colors(colors);
        }

        // one INSERT for targets x add and one DELETE for targets x remove
        // (a single statement per direction instead of a per-receipt loop;
        // the batch is capped by max_label_batch but the statement count is
        // constant either way)
        if !add.is_empty() {
            let target_rows = targets
                .iter()
                .map(|_| "SELECT ? AS id")
                .collect::<Vec<_>>()
                .join(" UNION ALL ");
            let color_rows = add
                .iter()
                .map(|_| "SELECT ? AS color")
                .collect::<Vec<_>>()
                .join(" UNION ALL ");
            let sql = format!(
                "INSERT OR IGNORE INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
                 SELECT t.id, ?, c.color, ?, ?
                 FROM ({target_rows}) t CROSS JOIN ({color_rows}) c"
            );
            let mut q = sqlx::query(AssertSqlSafe(sql))
                .bind(ledger_id)
                .bind(actor.user_id)
                .bind(now);
            for id in &targets {
                q = q.bind(id);
            }
            for c in add {
                q = q.bind(c.as_str());
            }
            q.execute(&mut *tx).await?;
        }
        if !remove.is_empty() {
            let tph = vec!["?"; targets.len()].join(", ");
            let cph = vec!["?"; remove.len()].join(", ");
            let sql = format!(
                "DELETE FROM receipt_labels WHERE receipt_id IN ({tph}) AND color IN ({cph})"
            );
            let mut q = sqlx::query(AssertSqlSafe(sql));
            for id in &targets {
                q = q.bind(id);
            }
            for c in remove {
                q = q.bind(c.as_str());
            }
            q.execute(&mut *tx).await?;
        }
    }

    // after = (before + add) - remove per receipt; audit only the changed
    let after_of = |rid: i64| -> Vec<LabelColor> {
        let mut after = before.get(&rid).cloned().unwrap_or_default();
        for c in add {
            if !after.contains(c) {
                after.push(*c);
            }
        }
        after.retain(|c| !remove.contains(c));
        sort_colors(&mut after);
        after
    };
    let colors_json = |v: &[LabelColor]| -> serde_json::Value {
        serde_json::json!(v.iter().map(|c| c.as_str()).collect::<Vec<_>>())
    };
    for id in &targets {
        let after = after_of(*id);
        let b = before.get(id).cloned().unwrap_or_default();
        if b != after {
            catalog::audit(
                &mut tx,
                ledger_id,
                actor,
                "receipt",
                *id,
                "label",
                Some(&colors_json(&b)),
                Some(&colors_json(&after)),
                now,
            )
            .await?;
        }
    }

    // labels (with titles) of the targets after the diff
    let titles: HashMap<String, Option<String>> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT color, title FROM ledger_labels WHERE ledger_id = ?",
    )
    .bind(ledger_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    let receipts: Vec<(i64, Vec<Label>)> = targets
        .iter()
        .map(|id| {
            let labels = after_of(*id)
                .into_iter()
                .map(|c| Label {
                    title: titles.get(c.as_str()).cloned().flatten(),
                    color: c,
                })
                .collect();
            (*id, labels)
        })
        .collect();
    tx.commit().await?;
    Ok(ApplyOutcome { receipts, skipped })
}

#[derive(Debug, thiserror::Error)]
pub enum LabelError {
    #[error("{0:?}")]
    Invalid(Vec<String>),
    #[error("viewer only")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("deleted")]
    Deleted,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:db-schema.ledger-labels-match-enum]
    #[test]
    fn label_colors_match_the_canonical_order() {
        // The Rust-side canonical order asserted against the shared
        // expectation of db_schema.rs (LABEL_COLOR_ORDER), which also reads
        // the SQL enumeration of migration 0009.
        let keys: Vec<&str> = LABEL_COLORS.iter().map(|c| c.as_str()).collect();
        assert_eq!(keys, ["red", "yellow", "green", "blue", "purple"]);
        for c in LABEL_COLORS {
            assert_eq!(LabelColor::parse(c.as_str()), Some(*c));
        }
        assert_eq!(LabelColor::parse("orange"), None);
        assert_eq!(LabelColor::Red.display_ja(), "赤");
        assert_eq!(LabelColor::Blue.display_ja(), "青");
    }

    // [covers:mcp-draft.label-colors-normalize]
    #[test]
    fn normalize_colors_dedupes_and_orders() {
        let parse = |v: &[&str]| -> Vec<LabelColor> {
            v.iter().map(|s| LabelColor::parse(s).unwrap()).collect()
        };
        let mut dup = parse(&["blue", "red", "blue"]);
        normalize_colors(&mut dup);
        assert_eq!(dup, parse(&["red", "blue"]));
        let mut shuffled = parse(&["purple", "yellow", "green", "yellow"]);
        normalize_colors(&mut shuffled);
        assert_eq!(shuffled, parse(&["yellow", "green", "purple"]));
        let mut none: Vec<LabelColor> = vec![];
        normalize_colors(&mut none);
        assert!(none.is_empty(), "empty stays empty (callers store None)");
    }
}
