//! Account tools #15-#17 (spec_mcp-tools.md 7-16 .. 7-18): whoami,
//! list_ledgers, switch_ledger. None of them takes the optional `ledger_id`
//! argument; the envelope `ledger` is null (spec 3-2).

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse};
use crate::auth::ledger::SwitchError;
use crate::mcp::result::{self, envelope};

// ---------------------------------------------------------------------------
// #15 whoami

pub async fn whoami(c: &Call<'_>, _args: &Map<String, Value>) -> ToolResult {
    let active = c
        .auth
        .ledger
        .as_ref()
        .map(|l| (l.ledger_id, l.name.clone(), l.role));
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    let w = crate::auth::ledger::whoami(&mut conn, c.auth.user_id, active)
        .await
        .map_err(result::internal)?;
    drop(conn);
    let text = match &w.active_ledger {
        Some((_, name, role)) => {
            format!(
                "アカウント: {}（アカウント番号 {}）。選択中の家計簿: {name}（{}）。",
                w.display_name,
                w.account_number,
                role.as_str()
            )
        }
        None => format!(
            "アカウント: {}（アカウント番号 {}）。選択中の家計簿はありません。list_ledgers で確認し switch_ledger で選んでください。",
            w.display_name, w.account_number
        ),
    };
    let active_ledger = w
        .active_ledger
        .map(|(id, name, role)| json!({ "id": id, "name": name, "role": role.as_str() }));
    Ok(result::ok(
        text,
        envelope(
            "account",
            None,
            &[],
            json!({ "account_number": w.account_number, "display_name": w.display_name,
                    "active_ledger": active_ledger }),
        ),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #16 list_ledgers

pub async fn list_ledgers(c: &Call<'_>, _args: &Map<String, Value>) -> ToolResult {
    let active_id = c.auth.ledger.as_ref().map(|l| l.ledger_id);
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    let ledgers = crate::auth::ledger::list_ledgers(&mut conn, c.auth.user_id, active_id)
        .await
        .map_err(result::internal)?;
    drop(conn);
    if ledgers.is_empty() {
        return Ok(result::ok(
            "所属している家計簿はありません。".into(),
            envelope(
                "ledgers",
                None,
                &[],
                json!({ "ledgers": [], "active_ledger_id": null }),
            ),
            None,
        ));
    }
    let text = {
        let names: Vec<String> = ledgers
            .iter()
            .map(|l| {
                format!(
                    "{}（{}{}）",
                    l.name,
                    l.role.as_str(),
                    if l.is_active { "・選択中" } else { "" }
                )
            })
            .collect();
        format!(
            "家計簿は{}件あります: {}。",
            ledgers.len(),
            names.join("、")
        )
    };
    let rows: Vec<Value> = ledgers
        .iter()
        .map(|l| {
            json!({ "ledger_id": l.ledger_id, "name": l.name, "role": l.role.as_str(),
                    "is_active": l.is_active })
        })
        .collect();
    Ok(result::ok(
        text,
        envelope(
            "ledgers",
            None,
            &[],
            json!({ "ledgers": rows, "active_ledger_id": active_id }),
        ),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #17 switch_ledger

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SwitchArgs {
    ledger_id: i64,
}

pub async fn switch_ledger(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: SwitchArgs = parse(args)?;
    let out = crate::auth::ledger::switch_ledger(
        c.db(),
        c.auth.grant_id,
        c.auth.user_id,
        a.ledger_id,
        "mcp",
        Some(&c.auth.client_id),
        c.now,
    )
    .await;
    match out {
        Ok(o) => {
            let previous = match (o.previous_ledger_id, &o.previous_name) {
                (Some(id), Some(name)) => json!({ "id": id, "name": name }),
                _ => Value::Null,
            };
            let text = match &o.previous_name {
                Some(prev) => format!(
                    "家計簿を「{prev}」から「{}」に切り替えました（{}）。",
                    o.name,
                    o.role.as_str()
                ),
                None => format!(
                    "家計簿を「{}」に切り替えました（{}）。",
                    o.name,
                    o.role.as_str()
                ),
            };
            // The envelope `ledger` carries the new ledger with its role
            // (spec 7-18); `source` is "active" right after the switch.
            let ledger = json!({ "id": o.ledger_id, "name": o.name,
                                 "source": "active", "role": o.role.as_str() });
            Ok(result::ok(
                text,
                envelope(
                    "ledger_switched",
                    None,
                    &[],
                    json!({ "ledger": ledger, "previous": previous }),
                ),
                None,
            ))
        }
        // Not a member / no such ledger: the same error either way (spec 7-18).
        Err(SwitchError::NotSelectable) => Err(result::not_found()),
        // The grant was live when the Bearer was validated; if it vanished
        // mid-call that is a server-side inconsistency.
        Err(e @ (SwitchError::GrantNotFound | SwitchError::Db(_))) => Err(result::internal(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::ledger::LedgerRole;

    // [covers:mcp-account.switch-envelope-shape]
    #[test]
    fn switch_body_shape() {
        // The envelope body must be { ledger: {id,name,source,role}, previous }
        // with `previous` null on the first selection (spec 7-18).
        let v = envelope(
            "ledger_switched",
            None,
            &[],
            json!({ "ledger": { "id": 2, "name": "家族", "source": "active", "role": "owner" },
                    "previous": null }),
        );
        assert_eq!(v["view"], "ledger_switched");
        assert_eq!(v["ledger"]["role"], "owner");
        assert!(v["previous"].is_null());
    }

    fn role(s: &str) -> Option<LedgerRole> {
        LedgerRole::parse(s)
    }

    // [covers:mcp-account.role-parse]
    #[test]
    fn roles() {
        assert_eq!(role("viewer"), Some(LedgerRole::Viewer));
        assert_eq!(role("editor"), Some(LedgerRole::Editor));
        assert_eq!(role("owner"), Some(LedgerRole::Owner));
        assert_eq!(role("admin"), None);
        assert!(LedgerRole::Viewer < LedgerRole::Editor);
    }
}
