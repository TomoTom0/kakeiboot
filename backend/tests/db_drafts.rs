//! Draft lifecycle and approval transaction tests (TASK-8, spec_data-model.md
//! section 7). Covers drafts CHECK constraints, the store-layer functions, the
//! approval transaction, and reopen.

mod common;

use budget_book::domain::dto::{DraftItem, DraftPayload, LineKind, PaymentMethod, TaxMode};
use budget_book::store::{
    self, ApproveError, ApproveWarning, DRAFT_TTL_MS, NewDraft, NewDraftImageStatus, ReopenError,
};
use common::*;
use sqlx::SqlitePool;

fn base_payload() -> DraftPayload {
    DraftPayload {
        store_name: Some("イオン".into()),
        store_name_raw: Some("AEON".into()),
        store_category: None,
        purchased_on: Some("2026-10-01".into()),
        purchased_time: None,
        tax_mode: None,
        total_amount: Some(198),
        tax_amount: None,
        payment_method: None,
        note: None,
        label_colors: None,
        items: vec![DraftItem {
            line_no: 1,
            line_kind: LineKind::Item,
            parent_line_no: None,
            name: "牛乳".into(),
            name_raw: None,
            quantity: None,
            unit: None,
            unit_price: Some(198),
            amount: 198,
            tax_rate: None,
            category: None,
            bbox: None,
            category_source: None,
        }],
    }
}

fn item(line_no: i64, name: &str, amount: i64) -> DraftItem {
    DraftItem {
        line_no,
        line_kind: LineKind::Item,
        parent_line_no: None,
        name: name.into(),
        name_raw: None,
        quantity: None,
        unit: None,
        unit_price: None,
        amount,
        tax_rate: None,
        category: None,
        bbox: None,
        category_source: None,
    }
}

fn discount(line_no: i64, parent_line_no: i64, amount: i64) -> DraftItem {
    DraftItem {
        line_kind: LineKind::Discount,
        parent_line_no: Some(parent_line_no),
        ..item(line_no, "値引", amount)
    }
}

/// ledger 1 + owner user 1.
async fn fixture(pool: &SqlitePool) {
    insert_ledger(pool, 1).await;
    insert_user(pool, 1).await;
    insert_member(pool, 1, 1, "owner").await;
}

async fn new_manual_draft(pool: &SqlitePool, payload: &DraftPayload) -> i64 {
    store::create_draft(
        pool,
        payload,
        &NewDraft {
            ledger_id: 1,
            user_id: 1,
            image_status: NewDraftImageStatus::None,
            image_unavailable_reason: None,
            source_file_id: None,
            reported_filename: Some("r.jpg".into()),
            reported_taken_at: Some("2026-10-01T18:00:00".into()),
            batch_id: None,
        },
        NOW,
    )
    .await
    .unwrap()
}

// ---------------------------------------------------------------------------
// drafts CHECK constraints

// [covers:db-schema.draft-status-invalid-rejected]
#[tokio::test]
async fn draft_status_invalid_rejected() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO drafts (ledger_id, user_id, status, payload_json, image_status, created_at, updated_at, expires_at)
             VALUES (1, 1, 'waiting', '{}', 'none', 0, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.draft-pending-closed-consistency]
#[tokio::test]
async fn draft_pending_closed_consistency() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let id = insert_draft_min(&pool, 1, 1, "none", None).await;
    expect_db_err(
        "CHECK",
        sqlx::query("UPDATE drafts SET closed_at = 1 WHERE id = ?")
            .bind(id)
            .execute(&pool),
    )
    .await;
    // non-pending must carry closed_at (approved shape via direct UPDATE)
    sqlx::query(
        "UPDATE drafts SET closed_at = 1, status = 'approved', approved_revision = 1 WHERE id = ?",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    expect_db_err(
        "CHECK",
        sqlx::query("UPDATE drafts SET closed_at = NULL WHERE id = ?")
            .bind(id)
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.draft-approved-requires-revision]
#[tokio::test]
async fn draft_approved_requires_revision() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let id = insert_draft_min(&pool, 1, 1, "none", None).await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "UPDATE drafts SET status = 'approved', closed_at = 1, approved_receipt_id = NULL, approved_revision = NULL WHERE id = ?",
        )
        .bind(id)
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.draft-pending-requires-payload]
#[tokio::test]
async fn draft_pending_requires_payload() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO drafts (ledger_id, user_id, payload_json, image_status, created_at, updated_at, expires_at)
             VALUES (1, 1, NULL, 'none', 0, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.draft-pending-attached-image-consistency]
#[tokio::test]
async fn draft_pending_attached_image_consistency() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    insert_image(&pool, 1, 1).await;
    // none / unavailable cannot hold an image while pending
    for status in ["none", "unavailable"] {
        expect_db_err(
            "CHECK",
            sqlx::query(
                "INSERT INTO drafts (ledger_id, user_id, payload_json, image_id, image_status, image_unavailable_reason,
                     created_at, updated_at, expires_at)
                 VALUES (1, 1, '{}', 1, ?, ?, 0, 0, 0)",
            )
            .bind(status)
            .bind(if status == "unavailable" { Some("chat_upload") } else { None })
            .execute(&pool),
        )
        .await;
    }
    // attached without image
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO drafts (ledger_id, user_id, payload_json, image_status, created_at, updated_at, expires_at)
             VALUES (1, 1, '{}', 'attached', 0, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // attached with image is the only valid combination
    sqlx::query(
        "INSERT INTO drafts (ledger_id, user_id, payload_json, image_id, image_status, created_at, updated_at, expires_at)
         VALUES (1, 1, '{}', 1, 'attached', 0, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.draft-unavailable-reason-consistency]
#[tokio::test]
async fn draft_unavailable_reason_consistency() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO drafts (ledger_id, user_id, payload_json, image_status, created_at, updated_at, expires_at)
             VALUES (1, 1, '{}', 'unavailable', 0, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    for status in ["none", "attached"] {
        expect_db_err(
            "CHECK",
            sqlx::query(
                "INSERT INTO drafts (ledger_id, user_id, payload_json, image_status, image_unavailable_reason,
                     created_at, updated_at, expires_at)
                 VALUES (1, 1, '{}', ?, 'chat_upload', 0, 0, 0)",
            )
            .bind(status)
            .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.draft-image-ledger-mismatch-rejected]
#[tokio::test]
async fn draft_image_ledger_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    insert_image(&pool, 1, 2).await; // image on ledger 2
    expect_db_err(
        "image ledger mismatch",
        sqlx::query(
            "INSERT INTO drafts (ledger_id, user_id, payload_json, image_id, image_status, created_at, updated_at, expires_at)
             VALUES (1, 1, '{}', 1, 'attached', 0, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
    expect_db_err(
        "image ledger mismatch",
        sqlx::query("UPDATE drafts SET image_id = 1, image_status = 'attached', image_unavailable_reason = NULL WHERE id = 1")
            .execute(&pool),
    )
    .await;
}

// ---------------------------------------------------------------------------
// store-layer draft operations

// [covers:db-schema.draft-update-increments-revision]
#[tokio::test]
async fn draft_update_increments_revision() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let payload = base_payload();
    let id = new_manual_draft(&pool, &payload).await;
    assert_eq!(
        store::update_draft_payload(&pool, id, 1, &payload, NOW)
            .await
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        store::update_draft_payload(&pool, id, 1, &payload, NOW)
            .await
            .unwrap(),
        Some(3)
    );
    assert_eq!(draft_state(&pool, id).await.4, 3);
    // closed drafts are not updated (0 rows -> None)
    store::discard_draft(&pool, id, 1, NOW).await.unwrap();
    assert_eq!(
        store::update_draft_payload(&pool, id, 1, &payload, NOW)
            .await
            .unwrap(),
        None
    );
    assert_eq!(draft_state(&pool, id).await.4, 3);
}

// [covers:db-schema.draft-image-attach-transition]
#[tokio::test]
async fn draft_image_attach_transition() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    // I3a: success path
    let a = store::create_draft(
        &pool,
        &base_payload(),
        &NewDraft {
            ledger_id: 1,
            user_id: 1,
            image_status: NewDraftImageStatus::Unavailable,
            image_unavailable_reason: Some("fetch_interrupted"),
            source_file_id: Some("file-1".into()),
            reported_filename: None,
            reported_taken_at: None,
            batch_id: None,
        },
        NOW,
    )
    .await
    .unwrap();
    insert_image(&pool, 1, 1).await;
    assert_eq!(
        store::attach_draft_image(&pool, a, 1, NOW).await.unwrap(),
        1
    );
    assert_eq!(
        draft_state(&pool, a).await,
        ("pending".into(), "attached".into(), None, Some(1), 2)
    );
    // I3b: failure path records the reason
    let b = insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
    assert_eq!(
        store::fail_draft_image(&pool, b, "fetch_failed", NOW)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        draft_state(&pool, b).await,
        (
            "pending".into(),
            "unavailable".into(),
            Some("fetch_failed".into()),
            None,
            2
        )
    );
    // closed draft: 0 rows, state unchanged (image stays orphaned)
    let c = insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
    store::discard_draft(&pool, c, 1, NOW).await.unwrap();
    insert_image(&pool, 2, 1).await;
    assert_eq!(
        store::attach_draft_image(&pool, c, 2, NOW).await.unwrap(),
        0
    );
    assert_eq!(
        store::fail_draft_image(&pool, c, "too_large", NOW)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        draft_state(&pool, c).await,
        (
            "discarded".into(),
            "unavailable".into(),
            Some("fetch_interrupted".into()),
            None,
            1
        )
    );
}

// [covers:db-schema.discard-sets-closed]
#[tokio::test]
async fn discard_sets_closed() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    insert_user(&pool, 2).await;
    let id = new_manual_draft(&pool, &base_payload()).await;
    // another user's draft: 0 rows
    assert_eq!(store::discard_draft(&pool, id, 2, NOW).await.unwrap(), 0);
    assert_eq!(draft_state(&pool, id).await.0, "pending");
    // own draft: 1 row
    assert_eq!(store::discard_draft(&pool, id, 1, NOW).await.unwrap(), 1);
    let (status, closed_at): (String, Option<i64>) =
        sqlx::query_as("SELECT status, closed_at FROM drafts WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((status.as_str(), closed_at), ("discarded", Some(NOW)));
    // double discard: 0 rows
    assert_eq!(store::discard_draft(&pool, id, 1, NOW).await.unwrap(), 0);
}

// [covers:db-schema.draft-closed-nulls-image-keeps-status]
#[tokio::test]
async fn draft_closed_nulls_image_keeps_status() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    // attached draft closed via approve keeps image_status, drops image_id
    insert_image(&pool, 1, 1).await;
    let payload = base_payload();
    let a = store::create_draft(
        &pool,
        &payload,
        &NewDraft {
            ledger_id: 1,
            user_id: 1,
            image_status: NewDraftImageStatus::Unavailable,
            image_unavailable_reason: Some("fetch_interrupted"),
            source_file_id: Some("file-a".into()),
            reported_filename: None,
            reported_taken_at: None,
            batch_id: None,
        },
        NOW,
    )
    .await
    .unwrap();
    store::attach_draft_image(&pool, a, 1, NOW).await.unwrap();
    store::approve_draft(&pool, a, 1, 2, NOW).await.unwrap();
    assert_eq!(
        draft_state(&pool, a).await,
        ("approved".into(), "attached".into(), None, None, 2)
    );
    // unavailable draft closed via discard keeps reason
    let b = insert_draft_min(&pool, 1, 1, "unavailable", Some("chat_upload")).await;
    store::discard_draft(&pool, b, 1, NOW).await.unwrap();
    assert_eq!(
        draft_state(&pool, b).await,
        (
            "discarded".into(),
            "unavailable".into(),
            Some("chat_upload".into()),
            None,
            1
        )
    );
    // attached draft closed via the TTL expire UPDATE
    insert_image(&pool, 2, 1).await;
    let c = insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
    sqlx::query("UPDATE drafts SET image_id = 2, image_status = 'attached', image_unavailable_reason = NULL WHERE id = ?")
        .bind(c)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE drafts SET expires_at = ? WHERE id = ?")
        .bind(NOW - 1)
        .bind(c)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE drafts SET status = 'expired', image_id = NULL, closed_at = ? WHERE status = 'pending' AND expires_at < ?")
        .bind(NOW)
        .bind(NOW)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        draft_state(&pool, c).await,
        ("expired".into(), "attached".into(), None, None, 1)
    );
}

// ---------------------------------------------------------------------------
// approval transaction

// [covers:db-schema.approve-expands-draft-to-receipt]
#[tokio::test]
async fn approve_expands_draft_to_receipt() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let mut payload = base_payload();
    payload.payment_method = Some(PaymentMethod::CreditCard);
    payload.note = Some("note".into());
    payload.items.push(discount(2, 1, -20));
    let id = new_manual_draft(&pool, &payload).await;
    let out = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    // receipt header
    type Header = (
        i64,
        i64,
        String,
        Option<i64>,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let header: Header = sqlx::query_as(
        "SELECT ledger_id, created_by, purchased_on, store_id, source, total_amount, tax_mode, payment_method, note, store_name_raw
         FROM receipts WHERE id = ?",
    )
    .bind(out.receipt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(header.0, 1);
    assert_eq!(header.1, 1);
    assert_eq!(header.2, "2026-10-01");
    assert!(header.3.is_some(), "store resolved or created");
    assert_eq!(header.4, "manual");
    assert_eq!(header.5, Some(198));
    assert_eq!(header.6, None);
    assert_eq!(header.7.as_deref(), Some("credit_card"));
    assert_eq!(header.8.as_deref(), Some("note"));
    assert_eq!(header.9.as_deref(), Some("AEON"));
    // items: item line first, then the discount
    type ItemRow = (i64, String, i64, Option<i64>, Option<i64>);
    let items: Vec<ItemRow> = sqlx::query_as(
        "SELECT line_no, line_kind, amount, parent_item_id, category_id FROM receipt_items
         WHERE receipt_id = ? ORDER BY line_no",
    )
    .bind(out.receipt_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        (items[0].0 as i64, items[0].1.as_str(), items[0].2),
        (1, "item", 198)
    );
    assert_eq!(
        (items[1].0, items[1].1.as_str(), items[1].2),
        (2, "discount", -20)
    );
    assert!(items[1].3.is_some(), "discount references the item row");
    // draft flipped
    let draft: (String, Option<i64>, Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT status, approved_receipt_id, approved_revision, image_id, closed_at FROM drafts WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(draft.0, "approved");
    assert_eq!(draft.1, Some(out.receipt_id));
    assert_eq!(draft.2, Some(1));
    assert_eq!(draft.3, None);
    assert_eq!(draft.4, Some(NOW));
    // audit row
    let audit: Option<(String, i64, String)> = sqlx::query_as(
        "SELECT entity_type, entity_id, action FROM audit_events WHERE entity_type = 'draft' AND entity_id = ?",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(audit, Some(("draft".into(), id, "approve".into())));
    // FTS picked the lines up through the triggers
    let fts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipt_items_fts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fts, 2);
}

// [covers:db-schema.approve-source-by-image-status]
#[tokio::test]
async fn approve_source_by_image_status() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    // none -> manual
    let manual = new_manual_draft(&pool, &base_payload()).await;
    let out1 = store::approve_draft(&pool, manual, 1, 1, NOW)
        .await
        .unwrap();
    // unavailable (image could not be saved) -> image
    let unavailable = store::create_draft(
        &pool,
        &base_payload(),
        &NewDraft {
            ledger_id: 1,
            user_id: 1,
            image_status: NewDraftImageStatus::Unavailable,
            image_unavailable_reason: Some("chat_upload"),
            source_file_id: None,
            reported_filename: None,
            reported_taken_at: None,
            batch_id: None,
        },
        NOW,
    )
    .await
    .unwrap();
    let out2 = store::approve_draft(&pool, unavailable, 1, 1, NOW)
        .await
        .unwrap();
    let sources: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, source FROM receipts WHERE id IN (?, ?) ORDER BY id")
            .bind(out1.receipt_id)
            .bind(out2.receipt_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(sources.len(), 2);
    assert!(sources.iter().any(|(_, s)| s == "manual"));
    assert!(sources.iter().any(|(_, s)| s == "image"));
    let images: Vec<(Option<i64>,)> =
        sqlx::query_as("SELECT image_id FROM receipts WHERE id IN (?, ?)")
            .bind(out1.receipt_id)
            .bind(out2.receipt_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        images.iter().all(|(i,)| i.is_none()),
        "no image attached in either case"
    );
}

// [covers:db-schema.approve-idempotent-returns-existing]
#[tokio::test]
async fn approve_idempotent_returns_existing() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let id = new_manual_draft(&pool, &base_payload()).await;
    let first = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    let second = store::approve_draft(&pool, id, 1, 1, NOW + 1)
        .await
        .unwrap();
    assert_eq!(first.receipt_id, second.receipt_id);
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(receipts, 1, "no second receipt on re-approval");
}

// [covers:db-schema.approve-idempotent-null-receipt-conflict]
#[tokio::test]
async fn approve_idempotent_null_receipt_conflict() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let id = new_manual_draft(&pool, &base_payload()).await;
    let out = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    // the 90-day purge physically deletes receipts; ON DELETE SET NULL clears
    // the draft's reference
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(out.receipt_id)
        .execute(&pool)
        .await
        .unwrap();
    let rid: Option<i64> =
        sqlx::query_scalar("SELECT approved_receipt_id FROM drafts WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rid, None);
    let err = store::approve_draft(&pool, id, 1, 1, NOW)
        .await
        .expect_err("receipt gone -> conflict, not idempotent success");
    match err {
        ApproveError::Conflict(status) => assert_eq!(status, "approved"),
        other => panic!("expected Conflict, got {other:?}"),
    }
}

// [covers:db-schema.approve-stale-revision-rejected]
#[tokio::test]
async fn approve_stale_revision_rejected() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let payload = base_payload();
    let id = new_manual_draft(&pool, &payload).await;
    store::update_draft_payload(&pool, id, 1, &payload, NOW)
        .await
        .unwrap();
    let err = store::approve_draft(&pool, id, 1, 1, NOW)
        .await
        .expect_err("stale revision");
    match err {
        ApproveError::StaleRevision {
            current,
            payload: p,
        } => {
            assert_eq!(current, 2);
            assert!(p.contains("牛乳"), "current payload is returned");
        }
        other => panic!("expected StaleRevision, got {other:?}"),
    }
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(receipts, 0, "nothing written on stale approval");
}

// [covers:db-schema.approve-conflict-closed-draft]
#[tokio::test]
async fn approve_conflict_closed_draft() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let id = new_manual_draft(&pool, &base_payload()).await;
    store::discard_draft(&pool, id, 1, NOW).await.unwrap();
    let err = store::approve_draft(&pool, id, 1, 1, NOW)
        .await
        .expect_err("conflict");
    match err {
        ApproveError::Conflict(status) => assert_eq!(status, "discarded"),
        other => panic!("expected Conflict, got {other:?}"),
    }
}

// [covers:db-schema.approve-requires-editor-role]
#[tokio::test]
async fn approve_requires_editor_role() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_user(&pool, 1).await; // editor
    insert_user(&pool, 2).await; // viewer on ledger 1
    insert_user(&pool, 3).await; // not a member
    insert_member(&pool, 1, 1, "editor").await;
    insert_member(&pool, 1, 2, "viewer").await;
    // each user approves their own draft (section 7-5 step 1 looks up by
    // id AND user_id); the role check then applies to the draft's ledger.
    let own_draft = |user: i64| {
        let pool = pool.clone();
        let payload = base_payload();
        async move {
            store::create_draft(
                &pool,
                &payload,
                &NewDraft {
                    ledger_id: 1,
                    user_id: user,
                    image_status: NewDraftImageStatus::None,
                    image_unavailable_reason: None,
                    source_file_id: None,
                    reported_filename: None,
                    reported_taken_at: None,
                    batch_id: None,
                },
                NOW,
            )
            .await
            .unwrap()
        }
    };
    // viewer: member of the ledger but the role is too low
    let viewer_draft = own_draft(2).await;
    let err = store::approve_draft(&pool, viewer_draft, 2, 1, NOW)
        .await
        .expect_err("viewer denied");
    assert!(matches!(err, ApproveError::Forbidden), "got {err:?}");
    // non-member: rejected
    let outsider_draft = own_draft(3).await;
    let err = store::approve_draft(&pool, outsider_draft, 3, 1, NOW)
        .await
        .expect_err("non-member denied");
    assert!(matches!(err, ApproveError::Forbidden), "got {err:?}");
    // both drafts untouched, nothing written
    assert_eq!(draft_state(&pool, viewer_draft).await.0, "pending");
    assert_eq!(draft_state(&pool, outsider_draft).await.0, "pending");
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(receipts, 0);
    // editor succeeds
    let editor_draft = own_draft(1).await;
    store::approve_draft(&pool, editor_draft, 1, 1, NOW)
        .await
        .unwrap();
}

// [covers:db-schema.approve-not-found-unknown-id]
#[tokio::test]
async fn approve_not_found_unknown_id() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    insert_user(&pool, 2).await;
    let id = new_manual_draft(&pool, &base_payload()).await;
    // another user's draft (user_id mismatch)
    let err = store::approve_draft(&pool, id, 2, 1, NOW)
        .await
        .expect_err("not found");
    assert!(matches!(err, ApproveError::NotFound), "got {err:?}");
    // unknown id
    let err = store::approve_draft(&pool, 999, 1, 1, NOW)
        .await
        .expect_err("not found");
    assert!(matches!(err, ApproveError::NotFound), "got {err:?}");
}

// [covers:db-schema.approve-resolves-or-creates-store]
#[tokio::test]
async fn approve_resolves_or_creates_store() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    // existing store plus a registered alias
    let existing: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, created_at, updated_at)
         VALUES (1, 'イオン', 'イオン', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
         VALUES (1, 'イオン○○', ?, 0)",
    )
    .bind(existing)
    .execute(&pool)
    .await
    .unwrap();
    let cat = insert_category(&pool, "store_categories", 1, None, "スーパー").await;

    // alias hits the existing store; store category resolves
    let mut p1 = base_payload();
    p1.store_name = Some("イオン○○".into());
    p1.store_category = Some("スーパー".into());
    let id1 = new_manual_draft(&pool, &p1).await;
    let out1 = store::approve_draft(&pool, id1, 1, 1, NOW).await.unwrap();
    let (store_id, cat_id, cat_src): (i64, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT store_id, s.category_id, s.category_source FROM receipts r
         JOIN stores s ON s.id = r.store_id WHERE r.id = ?",
    )
    .bind(out1.receipt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(store_id, existing, "alias resolves to the existing store");
    assert_eq!(cat_id, Some(cat));
    assert_eq!(cat_src.as_deref(), Some("model"));

    // unknown store is created together with its alias
    let mut p2 = base_payload();
    p2.store_name = Some("新しい店".into());
    p2.store_name_raw = Some("ATARASHII TEN".into());
    let id2 = new_manual_draft(&pool, &p2).await;
    let out2 = store::approve_draft(&pool, id2, 1, 1, NOW).await.unwrap();
    let (new_id, name_norm, alias_store): (i64, String, i64) = sqlx::query_as(
        "SELECT s.id, s.name_norm, (SELECT a.store_id FROM store_aliases a WHERE a.ledger_id = 1 AND a.alias_norm = s.name_norm)
         FROM receipts r JOIN stores s ON s.id = r.store_id WHERE r.id = ?",
    )
    .bind(out2.receipt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(new_id, existing);
    assert_eq!(name_norm, store::normalize_text("新しい店"));
    assert_eq!(
        alias_store, new_id,
        "alias registered for the created store"
    );
}

// [covers:db-schema.approve-keeps-user-store-category]
#[tokio::test]
async fn approve_keeps_user_store_category() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let user_cat = insert_category(&pool, "store_categories", 1, None, "その他").await;
    let model_cat = insert_category(&pool, "store_categories", 1, None, "スーパー").await;
    let store_id: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, category_id, category_source, created_at, updated_at)
         VALUES (1, '店', '店', ?, 'user', 0, 0) RETURNING id",
    )
    .bind(user_cat)
    .fetch_one(&pool)
    .await
    .unwrap();

    let approve_with = |category: &'static str| {
        let pool = pool.clone();
        async move {
            let mut payload = base_payload();
            payload.store_name = Some("店".into());
            payload.store_category = Some(category.into());
            let id = new_manual_draft(&pool, &payload).await;
            store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap()
        }
    };

    // a user-chosen category survives approval with a different model value
    let out = approve_with("スーパー").await;
    let (sid, cat, src): (i64, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT r.store_id, s.category_id, s.category_source FROM receipts r
         JOIN stores s ON s.id = r.store_id WHERE r.id = ?",
    )
    .bind(out.receipt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sid, store_id, "name resolution hits the existing store");
    assert_eq!(cat, Some(user_cat), "user category is not overwritten");
    assert_eq!(src.as_deref(), Some("user"));

    // once the row is no longer user-sourced, approval updates it again
    sqlx::query("UPDATE stores SET category_source = 'model' WHERE id = ?")
        .bind(store_id)
        .execute(&pool)
        .await
        .unwrap();
    let out = approve_with("スーパー").await;
    let (cat, src): (Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT s.category_id, s.category_source FROM receipts r
         JOIN stores s ON s.id = r.store_id WHERE r.id = ?",
    )
    .bind(out.receipt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cat, Some(model_cat));
    assert_eq!(src.as_deref(), Some("model"));
}

// [covers:db-schema.approve-unknown-category-nulls-with-warning]
#[tokio::test]
async fn approve_unknown_category_nulls_with_warning() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let top = insert_category(&pool, "item_categories", 1, None, "食費").await;
    let sub = insert_category(&pool, "item_categories", 1, Some(top), "食料品").await;
    let mut payload = base_payload();
    payload.items[0].category = Some("食費/食料品".into());
    payload.items.push({
        let mut it = item(2, "雑貨", 100);
        it.category = Some("存在しない/カテゴリ".into());
        it
    });
    payload.total_amount = Some(298); // keep the printed total consistent
    let id = new_manual_draft(&pool, &payload).await;
    let out = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    assert_eq!(
        out.warnings,
        vec![ApproveWarning::UnknownItemCategory {
            line_no: 2,
            name: "存在しない/カテゴリ".into(),
        }]
    );
    let cats: Vec<(i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT line_no, category_id, category_source FROM receipt_items WHERE receipt_id = ? ORDER BY line_no",
    )
    .bind(out.receipt_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(cats[0], (1, Some(sub), Some("model".into())));
    assert_eq!(cats[1], (2, None, Some("model".into())), "unknown -> NULL");
}

// [covers:db-schema.approve-computes-amount-incl]
#[tokio::test]
async fn approve_computes_amount_incl() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    // inclusive: amount as-is
    let mut incl = base_payload();
    incl.tax_mode = Some(TaxMode::Inclusive);
    incl.items[0].tax_rate = Some(10);
    let id1 = new_manual_draft(&pool, &incl).await;
    let out1 = store::approve_draft(&pool, id1, 1, 1, NOW).await.unwrap();
    let a: i64 = sqlx::query_scalar("SELECT amount_incl FROM receipt_items WHERE receipt_id = ?")
        .bind(out1.receipt_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(a, 198);

    // exclusive with printed tax: per-line conversion plus gap on the largest line
    let mut excl = base_payload();
    excl.tax_mode = Some(TaxMode::Exclusive);
    excl.tax_amount = Some(133);
    excl.items = vec![
        {
            let mut it = item(1, "大", 1000);
            it.tax_rate = Some(10);
            it
        },
        {
            let mut it = item(2, "中", 500);
            it.tax_rate = Some(8);
            it
        },
        {
            let mut it = discount(3, 1, -100);
            it.tax_rate = Some(8);
            it
        },
    ];
    let id2 = new_manual_draft(&pool, &excl).await;
    let out2 = store::approve_draft(&pool, id2, 1, 1, NOW).await.unwrap();
    let amounts: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT line_no, amount_incl FROM receipt_items WHERE receipt_id = ? ORDER BY line_no",
    )
    .bind(out2.receipt_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    // 1000*1.10=1100, 500*1.08=540, -100*1.08=-108 -> sum 1532; target 1400+133=1533
    // gap 1 goes to the largest line -> 1101
    assert_eq!(amounts, vec![(1, 1101), (2, 540), (3, -108)]);
    let total: i64 =
        sqlx::query_scalar("SELECT sum(amount_incl) FROM receipt_items WHERE receipt_id = ?")
            .bind(out2.receipt_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(total, 1533, "tax-inclusive total matches net + printed tax");
}

// [covers:db-schema.approve-warns-total-diff]
#[tokio::test]
async fn approve_warns_total_diff() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let mut payload = base_payload();
    payload.total_amount = Some(600); // items total is 198
    let id = new_manual_draft(&pool, &payload).await;
    let out = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    assert_eq!(
        out.warnings,
        vec![ApproveWarning::TotalDiff {
            items_total: 198,
            total_amount: 600,
        }]
    );
    let printed: Option<i64> = sqlx::query_scalar("SELECT total_amount FROM receipts WHERE id = ?")
        .bind(out.receipt_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(printed, Some(600), "printed total is stored as-is");
}

// [covers:db-schema.approve-discount-copies-category]
#[tokio::test]
async fn approve_discount_copies_category() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let top = insert_category(&pool, "item_categories", 1, None, "食費").await;
    let sub = insert_category(&pool, "item_categories", 1, Some(top), "食料品").await;
    let mut payload = base_payload();
    payload.items[0].category = Some("食費/食料品".into());
    payload.items.push(discount(2, 1, -20));
    let id = new_manual_draft(&pool, &payload).await;
    let out = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    let rows: Vec<(i64, String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT id, line_kind, parent_item_id, category_id FROM receipt_items
         WHERE receipt_id = ? ORDER BY line_no",
    )
    .bind(out.receipt_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    let (item_id, _, _, item_cat) = rows[0].clone();
    assert_eq!(item_cat, Some(sub));
    assert_eq!(
        rows[1].2,
        Some(item_id),
        "discount parent is the item row id"
    );
    assert_eq!(rows[1].3, Some(sub), "category copied from the parent item");
}

// [covers:db-schema.dto-bbox-array-roundtrip]
#[tokio::test]
async fn approve_serializes_bbox_as_number_array() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let mut payload = base_payload();
    payload.items[0].bbox = Some([0.1, 0.2, 0.3, 0.4]);
    let id = new_manual_draft(&pool, &payload).await;
    // create serializes the payload: bbox is the [number x 4] array of
    // spec_mcp-tools.md section 7-1, not an object
    let stored: String = sqlx::query_scalar("SELECT payload_json FROM drafts WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        stored.contains("\"bbox\":[0.1,0.2,0.3,0.4]"),
        "bbox serialized as a number array, got {stored}"
    );
    // approve deserializes it back and writes the bbox_* columns
    let out = store::approve_draft(&pool, id, 1, 1, NOW).await.unwrap();
    let bbox: (f64, f64, f64, f64) = sqlx::query_as(
        "SELECT bbox_x, bbox_y, bbox_w, bbox_h FROM receipt_items WHERE receipt_id = ?",
    )
    .bind(out.receipt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bbox, (0.1, 0.2, 0.3, 0.4));
    // and the stored JSON parses back into the same DTO value
    let back: DraftPayload = serde_json::from_str(&stored).unwrap();
    assert_eq!(back.items[0].bbox, Some([0.1, 0.2, 0.3, 0.4]));
}

// ---------------------------------------------------------------------------
// reopen

// [covers:db-schema.reopen-creates-new-pending]
#[tokio::test]
async fn reopen_creates_new_pending() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    insert_image(&pool, 1, 1).await;
    let payload = base_payload();
    let reported = NewDraft {
        ledger_id: 1,
        user_id: 1,
        image_status: NewDraftImageStatus::Unavailable,
        image_unavailable_reason: Some("fetch_interrupted"),
        source_file_id: Some("file-r".into()),
        reported_filename: Some("photo.jpg".into()),
        reported_taken_at: Some("2026-10-01T18:00:00".into()),
        batch_id: None,
    };
    let attached = store::create_draft(&pool, &payload, &reported, NOW)
        .await
        .unwrap();
    store::attach_draft_image(&pool, attached, 1, NOW)
        .await
        .unwrap();
    store::discard_draft(&pool, attached, 1, NOW).await.unwrap();
    let new_id = store::reopen_draft(&pool, attached, 1, NOW + 1)
        .await
        .unwrap();
    // new pending draft per section 7-2
    assert_eq!(
        draft_state(&pool, new_id).await,
        (
            "pending".into(),
            "unavailable".into(),
            Some("reopened".into()),
            None,
            1
        )
    );
    let copied: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT payload_json, reported_filename, reported_taken_at FROM drafts WHERE id = ?",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        copied.0.as_deref(),
        Some(serde_json::to_string(&payload).unwrap().as_str())
    );
    assert_eq!(copied.1.as_deref(), Some("photo.jpg"));
    assert_eq!(copied.2.as_deref(), Some("2026-10-01T18:00:00"));
    let (expires, source_file): (i64, Option<String>) =
        sqlx::query_as("SELECT expires_at, source_file_id FROM drafts WHERE id = ?")
            .bind(new_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(expires, NOW + 1 + DRAFT_TTL_MS);
    assert!(source_file.is_none(), "source_file_id is not carried over");
    // original row untouched
    assert_eq!(draft_state(&pool, attached).await.0, "discarded");
    // audit row: entity is the new draft, after_json carries reopened_from
    let audit: (i64, String, String) = sqlx::query_as(
        "SELECT entity_id, action, after_json FROM audit_events
         WHERE action = 'reopen' AND entity_type = 'draft'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit.0, new_id);
    assert_eq!(audit.1, "reopen");
    assert!(
        audit.2.contains(&format!("\"reopened_from\":{attached}")),
        "audit: {}",
        audit.2
    );

    // a discarded manual (none) draft reopens as none
    let manual = new_manual_draft(&pool, &payload).await;
    store::discard_draft(&pool, manual, 1, NOW).await.unwrap();
    let new2 = store::reopen_draft(&pool, manual, 1, NOW).await.unwrap();
    assert_eq!(
        draft_state(&pool, new2).await,
        ("pending".into(), "none".into(), None, None, 1)
    );
}

// [covers:db-schema.reopen-rejects-pending-and-approved]
#[tokio::test]
async fn reopen_rejects_pending_and_approved() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    let payload = base_payload();
    let pending = new_manual_draft(&pool, &payload).await;
    let err = store::reopen_draft(&pool, pending, 1, NOW)
        .await
        .expect_err("pending rejected");
    assert!(
        matches!(err, ReopenError::NotClosed(ref s) if s == "pending"),
        "got {err:?}"
    );
    let approved = new_manual_draft(&pool, &payload).await;
    store::approve_draft(&pool, approved, 1, 1, NOW)
        .await
        .unwrap();
    let err = store::reopen_draft(&pool, approved, 1, NOW)
        .await
        .expect_err("approved rejected");
    assert!(
        matches!(err, ReopenError::NotClosed(ref s) if s == "approved"),
        "got {err:?}"
    );
}

// ---------------------------------------------------------------------------
// TASK-18 batch creation

fn batch_new(image_status: NewDraftImageStatus, reason: Option<&'static str>) -> NewDraft {
    NewDraft {
        ledger_id: 1,
        user_id: 1,
        image_status,
        image_unavailable_reason: reason,
        source_file_id: None,
        reported_filename: None,
        reported_taken_at: None,
        batch_id: Some("01ARSTESTBATCHID0000000".into()),
    }
}

// [covers:db-drafts.create-many-atomic]
#[tokio::test]
async fn create_drafts_is_atomic_and_shares_the_batch_id() {
    let pool = mem_pool().await;
    fixture(&pool).await;
    // three entries in one call: entry order ids, one shared batch_id
    let p1 = base_payload();
    let mut p2 = base_payload();
    p2.store_name = Some("店2".into());
    let mut p3 = base_payload();
    p3.store_name = Some("店3".into());
    let ids = store::create_drafts(
        &pool,
        &[
            (p1.clone(), batch_new(NewDraftImageStatus::None, None)),
            (
                p2.clone(),
                batch_new(NewDraftImageStatus::Unavailable, Some("chat_upload")),
            ),
            (p3.clone(), batch_new(NewDraftImageStatus::None, None)),
        ],
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(ids.len(), 3);
    let rows: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, batch_id FROM drafts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 3, "every entry inserted");
    assert_eq!(
        rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        ids,
        "ids come back in entry order"
    );
    assert!(
        rows.iter()
            .all(|(_, b)| b.as_deref() == Some("01ARSTESTBATCHID0000000")),
        "one batch_id shared by the whole call: {rows:?}"
    );

    // a constraint violation mid-call rolls the whole insertion back
    let mut p4 = base_payload();
    p4.store_name = Some("店4".into());
    // none + a reason violates the drafts CHECK (reason requires unavailable)
    let bad = NewDraft {
        image_unavailable_reason: Some("chat_upload"),
        ..batch_new(NewDraftImageStatus::None, None)
    };
    let err = store::create_drafts(
        &pool,
        &[
            (p4.clone(), batch_new(NewDraftImageStatus::None, None)),
            (p4, bad),
        ],
        NOW,
    )
    .await;
    assert!(err.is_err(), "the constraint violation surfaces");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drafts WHERE payload_json LIKE '%店4%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0, "no partial insert survived the rollback");
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 3, "only the first call's rows remain");
}
