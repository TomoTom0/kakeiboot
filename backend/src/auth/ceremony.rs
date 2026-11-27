//! WebAuthn ceremony service (spec_auth.md sections 2-3 .. 2-7, 11-1, 11-2):
//! registration (setup / register / recovery), discoverable login, step-up
//! re-authentication, and adding a passkey while logged in.
//!
//! Ceremony state lives in `webauthn_ceremonies` (TTL from config), wrapped in
//! a small envelope that links the invitation hash and the captured display
//! name (the DDL has no invitation column; the state itself stays the
//! webauthn-rs value serialized via `danger-allow-state-serialisation`).

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnection;
use sqlx::{Connection, SqlitePool};
use uuid::Uuid;
use webauthn_rs::prelude::*;
use webauthn_rs_proto::{ResidentKeyRequirement, UserVerificationPolicy};

use super::invitation;
use super::register_invitation::{self, RegistrationToken, UserOrigin};
use super::session::{self, ValidSession};
use super::tokens::{self, TOKEN_LEN, from_hex, random_token, sha256, to_hex};
use crate::config::ResolvedAuth;
use crate::store;

/// Envelope stored in `webauthn_ceremonies.state_json`.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    /// Invitation token hash (hex) when this registration consumes a token.
    invitation_hash: Option<String>,
    /// Display name captured at register/start (setup / register only).
    display_name: Option<String>,
    /// The user handle (uuid bytes) issued in the register/start challenge.
    /// New-user registrations MUST persist this exact handle as
    /// `users.webauthn_user_handle`: a discoverable credential returns the
    /// challenge handle at login, so the stored handle has to be the same
    /// value. Absent on ceremonies written before this field existed and on
    /// every other ceremony kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_handle: Option<Vec<u8>>,
    /// The webauthn-rs ceremony state.
    state: serde_json::Value,
}

const DAY_MS: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// ceremony row helpers

async fn insert_ceremony(
    conn: &mut SqliteConnection,
    kind: &str,
    user_id: Option<i64>,
    state_json: &str,
    authz_hash: Option<&[u8]>,
    now: i64,
    ttl_secs: i64,
) -> sqlx::Result<[u8; TOKEN_LEN]> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO webauthn_ceremonies (id_hash, kind, user_id, state_json, authz_request_hash,
            created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256(&token).to_vec())
    .bind(kind)
    .bind(user_id)
    .bind(state_json)
    .bind(authz_hash)
    .bind(now)
    .bind(now + ttl_secs * 1000)
    .execute(conn)
    .await?;
    Ok(token)
}

/// Fetch and delete a live ceremony (single use, spec_auth.md section 2-5).
/// Returns `(user_id, authz_request_hash, state_json)` or None when the row
/// is missing or expired.
#[allow(clippy::type_complexity)]
async fn take_ceremony(
    conn: &mut SqliteConnection,
    token: &[u8; TOKEN_LEN],
    kind: &str,
    now: i64,
) -> sqlx::Result<Option<(Option<i64>, Option<Vec<u8>>, String)>> {
    let row: Option<(Option<i64>, Option<Vec<u8>>, String)> = sqlx::query_as(
        "DELETE FROM webauthn_ceremonies
         WHERE id_hash = ? AND kind = ? AND expires_at > ?
         RETURNING user_id, authz_request_hash, state_json",
    )
    .bind(sha256(token).to_vec())
    .bind(kind)
    .bind(now)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// Overwrite `authenticator_selection.resident_key` with `preferred`
/// (spec_auth.md section 2-3; `required` hid platform / cloud authenticators
/// from the picker on some clients during TASK-7 on-device checks). User
/// verification stays required. The passkey API's default request
/// extensions (credProt / uvm / credProps) are dropped as well: they are not
/// required by the spec and credProt can hide platform authenticators from
/// the browser's picker on some clients.
fn overwrite_resident_key_preferred(ccr: &mut CreationChallengeResponse) {
    let sel = ccr
        .public_key
        .authenticator_selection
        .get_or_insert_with(Default::default);
    sel.resident_key = Some(ResidentKeyRequirement::Preferred);
    // keep the legacy Level-1 field consistent (residentKey is authoritative
    // for modern clients, but a contradictory false can confuse pickers)
    sel.require_resident_key = false;
    sel.user_verification = UserVerificationPolicy::Required;
    ccr.public_key.extensions = None;
}

fn normalize_label(label: Option<&str>) -> Option<String> {
    label
        .map(str::trim)
        // 100 characters (not bytes), matching the display_name rule.
        .filter(|s| !s.is_empty() && s.chars().count() <= 100)
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// registration (spec_auth.md sections 2-3, 11-1)

#[derive(Debug, thiserror::Error)]
pub enum RegisterStartError {
    #[error("invalid token")]
    InvalidToken,
    #[error("display_name is required for this token kind")]
    DisplayNameRequired,
    #[error("display_name is not accepted for this token kind")]
    DisplayNameNotAllowed,
    #[error("webauthn error: {0}")]
    Webauthn(String),
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

pub struct RegisterStartOutcome {
    pub ccr: CreationChallengeResponse,
    pub ceremony: [u8; TOKEN_LEN],
    pub ttl_secs: i64,
}

/// Validate the token (invitations / register_invitations), start a
/// discoverable-credential registration with `resident_key = preferred`
/// (spec_auth.md section 2-3). Recovery targets an existing user; every
/// other kind (setup / register) creates a new one.
pub async fn register_start(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    cfg: &ResolvedAuth,
    token_str: &str,
    display_name: Option<&str>,
    now: i64,
) -> Result<RegisterStartOutcome, RegisterStartError> {
    let token = invitation::parse_token(token_str).ok_or(RegisterStartError::InvalidToken)?;
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let reg = register_invitation::find_registration_token(&mut conn, &token)
        .await
        .map_err(anyhow::Error::from)?
        .ok_or(RegisterStartError::InvalidToken)?;
    if !reg.is_usable(now) {
        return Err(RegisterStartError::InvalidToken);
    }
    let display_name = if reg.is_recovery() {
        if display_name.is_some_and(|s| !s.trim().is_empty()) {
            return Err(RegisterStartError::DisplayNameNotAllowed);
        }
        None
    } else {
        Some(
            display_name
                .map(str::trim)
                // 100 characters (not bytes), matching the label rule.
                .filter(|s| !s.is_empty() && s.chars().count() <= 100)
                .ok_or(RegisterStartError::DisplayNameRequired)?,
        )
    };
    let (uuid, ceremony_user, exclude, user_display) = if reg.is_recovery() {
        let RegistrationToken::Invitation(inv) = &reg else {
            return Err(RegisterStartError::InvalidToken);
        };
        // recovery targets an existing, enabled user (spec 2-1).
        let row: Option<(Vec<u8>, String)> = sqlx::query_as(
            "SELECT webauthn_user_handle, display_name FROM users
             WHERE id = ? AND disabled_at IS NULL",
        )
        .bind(inv.target_user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(anyhow::Error::from)?;
        let Some((handle, display)) = row else {
            return Err(RegisterStartError::InvalidToken);
        };
        let creds: Vec<Vec<u8>> =
            sqlx::query_scalar("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
                .bind(inv.target_user_id)
                .fetch_all(&mut *conn)
                .await
                .map_err(anyhow::Error::from)?;
        let uuid = Uuid::from_slice(&handle).map_err(|e| RegisterStartError::Db(e.into()))?;
        (uuid, inv.target_user_id, creds, display)
    } else {
        (
            Uuid::new_v4(),
            None,
            Vec::new(),
            display_name.expect("checked above").to_string(),
        )
    };
    let user_name = format!("{user_display} (kakeiboot)");
    let exclude: Option<Vec<CredentialID>> = if exclude.is_empty() {
        None
    } else {
        Some(exclude.into_iter().map(CredentialID::from).collect())
    };
    let new_user_handle = if reg.is_recovery() {
        None
    } else {
        Some(uuid.into_bytes().to_vec())
    };
    let (mut ccr, state) = webauthn
        .start_passkey_registration(uuid, &user_name, &user_display, exclude)
        .map_err(|e| RegisterStartError::Webauthn(e.to_string()))?;
    overwrite_resident_key_preferred(&mut ccr);

    let envelope = Envelope {
        invitation_hash: Some(to_hex(reg.token_hash())),
        display_name: display_name.map(str::to_string),
        user_handle: new_user_handle,
        state: serde_json::to_value(&state).map_err(|e| RegisterStartError::Db(e.into()))?,
    };
    let state_json =
        serde_json::to_string(&envelope).map_err(|e| RegisterStartError::Db(e.into()))?;
    let ceremony = insert_ceremony(
        &mut conn,
        "register",
        ceremony_user,
        &state_json,
        None,
        now,
        cfg.ceremony.ttl_secs,
    )
    .await
    .map_err(anyhow::Error::from)?;
    Ok(RegisterStartOutcome {
        ccr,
        ceremony,
        ttl_secs: cfg.ceremony.ttl_secs,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum RegisterFinishError {
    #[error("ceremony invalid or expired")]
    CeremonyInvalid,
    #[error("registration failed: {0}")]
    RegistrationFailed(String),
    #[error("token no longer usable")]
    TokenInvalid,
    #[error("invariant violated")]
    Invariant,
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

pub struct FinishOutcome {
    pub session: [u8; TOKEN_LEN],
    pub absolute_expires_at: i64,
}

/// Complete a token-based registration inside one BEGIN IMMEDIATE
/// transaction (spec_auth.md section 2-3 / 11-1).
#[allow(clippy::too_many_arguments)] // finish inputs mirror the spec's request body
pub async fn register_finish(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    cfg: &ResolvedAuth,
    ceremony_token: &[u8; TOKEN_LEN],
    credential: &RegisterPublicKeyCredential,
    label: Option<&str>,
    user_agent: Option<&str>,
    max_ledger_name_chars: usize,
    now: i64,
) -> Result<FinishOutcome, RegisterFinishError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let Some((ceremony_user, _, state_json)) =
        take_ceremony(&mut conn, ceremony_token, "register", now)
            .await
            .map_err(anyhow::Error::from)?
    else {
        return Err(RegisterFinishError::CeremonyInvalid);
    };
    let envelope: Envelope =
        serde_json::from_str(&state_json).map_err(|_| RegisterFinishError::CeremonyInvalid)?;
    let Some(invitation_hash) = envelope.invitation_hash.clone() else {
        // add-mode ceremonies are finished via passkey_add_finish only.
        return Err(RegisterFinishError::Invariant);
    };
    let state: PasskeyRegistration =
        serde_json::from_value(envelope.state).map_err(|_| RegisterFinishError::CeremonyInvalid)?;
    let passkey = webauthn
        .finish_passkey_registration(credential, &state)
        .map_err(|e| RegisterFinishError::RegistrationFailed(e.to_string()))?;
    let cred_id: Vec<u8> = passkey.cred_id().to_vec();
    let passkey_json =
        serde_json::to_string(&passkey).map_err(|e| RegisterFinishError::Db(e.into()))?;

    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(anyhow::Error::from)?;
    let hash = from_hex(&invitation_hash).ok_or(RegisterFinishError::Invariant)?;
    let reg = register_invitation::find_registration_by_hash(&mut tx, &hash)
        .await
        .map_err(anyhow::Error::from)?
        .ok_or(RegisterFinishError::TokenInvalid)?;
    if !reg.is_usable(now) {
        return Err(RegisterFinishError::TokenInvalid);
    }
    let user_id = if reg.is_recovery() {
        let uid = match &reg {
            RegistrationToken::Invitation(inv) => inv.target_user_id,
            RegistrationToken::Register(_) => None,
        }
        .ok_or(RegisterFinishError::Invariant)?;
        if ceremony_user != Some(uid) {
            return Err(RegisterFinishError::Invariant);
        }
        // recovery invalidates all existing web sessions (spec 2-8).
        session::revoke_user_sessions(&mut tx, uid, now)
            .await
            .map_err(anyhow::Error::from)?;
        uid
    } else {
        let display_name = envelope
            .display_name
            .clone()
            .ok_or(RegisterFinishError::Invariant)?;
        // the stored handle must be the challenge's uuid: a discoverable
        // credential returns that handle at every login (spec 2-2).
        let handle = envelope
            .user_handle
            .clone()
            .ok_or(RegisterFinishError::Invariant)?;
        let handle = Uuid::from_slice(&handle).map_err(|_| RegisterFinishError::Invariant)?;
        // Share design section 5 (D-D1): a new user's default is always
        // their personal ledger; the default changes only through
        // PUT /api/auth/me/default-ledger.
        create_user_with_personal_ledger(
            &mut tx,
            &handle,
            &display_name,
            &reg.user_origin(),
            max_ledger_name_chars,
            now,
        )
        .await?
    };
    let label =
        normalize_label(label).or_else(|| user_agent.map(super::tokens::default_label_from_ua));
    let cred_row_id: i64 = sqlx::query_scalar(
        "INSERT INTO webauthn_credentials (user_id, credential_id, passkey_json, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(user_id)
    .bind(&cred_id)
    .bind(&passkey_json)
    .bind(&label)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    // single-use token: the conditional UPDATE decides the winner (on the
    // table owning the token).
    if !reg
        .mark_used(&mut tx, Some(user_id), now)
        .await
        .map_err(anyhow::Error::from)?
    {
        return Err(RegisterFinishError::TokenInvalid);
    }
    super::audit(
        &mut tx,
        "web",
        if matches!(reg, RegistrationToken::Register(_)) {
            "register_invitation"
        } else {
            "invitation"
        },
        0,
        "token_use",
        Some(user_id),
        &serde_json::json!({
            "kind": reg.kind_str(),
            "token_hash_prefix": to_hex(reg.token_hash())[..8].to_string()
        }),
        now,
    )
    .await
    .map_err(anyhow::Error::from)?;
    if reg.is_recovery() {
        super::audit(
            &mut tx,
            "web",
            "webauthn_credential",
            cred_row_id,
            "create",
            Some(user_id),
            &serde_json::json!({ "via": "recovery" }),
            now,
        )
        .await
        .map_err(anyhow::Error::from)?;
    } else {
        super::audit(
            &mut tx,
            "web",
            "user",
            user_id,
            "create",
            Some(user_id),
            &serde_json::json!({ "kind": reg.kind_str() }),
            now,
        )
        .await
        .map_err(anyhow::Error::from)?;
    }
    let out = issue_session_in_tx(&mut tx, user_id, user_agent, now, cfg).await?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(out)
}

/// Create a user with a personal ledger (owner) and the category seed, then
/// set `default_ledger_id` to the personal ledger (spec_data-model.md
/// section 4). Lineage comes from the `UserOrigin`; user creation never
/// joins another ledger (share design section 2-1: identity creation does
/// not change membership). `handle` is the uuid from the register/start
/// challenge — the value the credential will present at every login, so it
/// must be the stored `webauthn_user_handle` verbatim. The personal ledger
/// is named `<表示名>の家計簿` (TASK-79), capped to
/// `max_ledger_name_chars` by `store::personal_ledger_name`.
async fn create_user_with_personal_ledger(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    handle: &Uuid,
    display_name: &str,
    origin: &UserOrigin,
    max_ledger_name_chars: usize,
    now: i64,
) -> Result<i64, RegisterFinishError> {
    let account_number = generate_unique_account_number(tx).await?;
    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (webauthn_user_handle, account_number, display_name, admin_note,
            invite_note, invited_by, invited_via_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(handle.as_bytes().as_slice())
    .bind(&account_number)
    .bind(display_name)
    .bind(&origin.admin_note)
    .bind(&origin.invite_note)
    .bind(origin.invited_by)
    .bind(origin.via_kind)
    .bind(now)
    .bind(now)
    .fetch_one(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;
    let ledger_id: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(store::personal_ledger_name(
        display_name,
        max_ledger_name_chars,
    ))
    .bind(now)
    .bind(now)
    .fetch_one(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;
    store::seed_categories(tx, ledger_id, now).await?;
    let color = store::assign_member_color(tx, user_id).await?;
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at, color) VALUES (?, ?, 'owner', ?, ?)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(now)
    .bind(color)
    .execute(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(ledger_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(user_id)
}

/// `BB-XXXX-XXXX` unique against the existing rows (regenerate on collision,
/// spec_data-model.md section 10-2).
async fn generate_unique_account_number(
    conn: &mut SqliteConnection,
) -> Result<String, RegisterFinishError> {
    loop {
        let candidate = tokens::candidate_account_number();
        let taken: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE account_number = ?")
            .bind(&candidate)
            .fetch_optional(&mut *conn)
            .await
            .map_err(anyhow::Error::from)?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
}

/// Insert a web session row inside the caller's transaction.
async fn issue_session_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: i64,
    user_agent: Option<&str>,
    now: i64,
    cfg: &ResolvedAuth,
) -> Result<FinishOutcome, RegisterFinishError> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at,
            idle_expires_at, absolute_expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256(&token).to_vec())
    .bind(user_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now + cfg.session.idle_days * DAY_MS)
    .bind(now + cfg.session.absolute_days * DAY_MS)
    .bind(user_agent)
    .execute(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;
    Ok(FinishOutcome {
        absolute_expires_at: now + cfg.session.absolute_days * DAY_MS,
        session: token,
    })
}

// ---------------------------------------------------------------------------
// discoverable login (spec_auth.md sections 2-4, 11-2)

#[derive(Debug, thiserror::Error)]
pub enum LoginStartError {
    #[error("unknown authorization request")]
    InvalidReq,
    #[error("webauthn error: {0}")]
    Webauthn(String),
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

pub struct LoginStartOutcome {
    pub rcr: RequestChallengeResponse,
    pub ceremony: [u8; TOKEN_LEN],
    pub ttl_secs: i64,
}

pub async fn login_start(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    cfg: &ResolvedAuth,
    req: Option<&str>,
    now: i64,
) -> Result<LoginStartOutcome, LoginStartError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let authz_hash: Option<Vec<u8>> = match req {
        Some(req) => {
            let bytes: [u8; 32] = tokens::b64url_decode(req)
                .and_then(|b| b.try_into().ok())
                .ok_or(LoginStartError::InvalidReq)?;
            let hash = sha256(&bytes).to_vec();
            let exists: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM oauth_authorization_requests WHERE id_hash = ? AND expires_at > ?",
            )
            .bind(&hash)
            .bind(now)
            .fetch_optional(&mut *conn)
            .await
            .map_err(anyhow::Error::from)?;
            if exists.is_none() {
                return Err(LoginStartError::InvalidReq);
            }
            Some(hash)
        }
        None => None,
    };
    let (mut rcr, state) = webauthn
        .start_discoverable_authentication()
        .map_err(|e| LoginStartError::Webauthn(e.to_string()))?;
    // Drop the library's request extensions (uvm) and the conditional-mediation
    // hint (frontend uses the modal flow only): neither is required and they
    // can affect the browser's credential picker.
    rcr.public_key.extensions = None;
    rcr.mediation = None;
    let envelope = Envelope {
        invitation_hash: None,
        display_name: None,
        user_handle: None,
        state: serde_json::to_value(&state).map_err(|e| LoginStartError::Db(e.into()))?,
    };
    let state_json = serde_json::to_string(&envelope).map_err(|e| LoginStartError::Db(e.into()))?;
    let ceremony = insert_ceremony(
        &mut conn,
        "authenticate",
        None,
        &state_json,
        authz_hash.as_deref(),
        now,
        cfg.ceremony.ttl_secs,
    )
    .await
    .map_err(anyhow::Error::from)?;
    Ok(LoginStartOutcome {
        rcr,
        ceremony,
        ttl_secs: cfg.ceremony.ttl_secs,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum LoginFinishError {
    #[error("ceremony invalid or expired")]
    CeremonyInvalid,
    #[error("mismatch")]
    Mismatch,
    #[error("authentication rejected")]
    Authentication,
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

pub struct LoginFinishOutcome {
    pub session: [u8; TOKEN_LEN],
    pub absolute_expires_at: i64,
    pub next: Option<&'static str>,
}

#[allow(clippy::too_many_arguments)]
pub async fn login_finish(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    cfg: &ResolvedAuth,
    ceremony_token: &[u8; TOKEN_LEN],
    credential: &PublicKeyCredential,
    old_session: Option<&[u8; TOKEN_LEN]>,
    now: i64,
    test_hooks: &crate::test_hooks::TestHooks,
) -> Result<LoginFinishOutcome, LoginFinishError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let Some((_, authz_hash, state_json)) =
        take_ceremony(&mut conn, ceremony_token, "authenticate", now)
            .await
            .map_err(anyhow::Error::from)?
    else {
        return Err(LoginFinishError::CeremonyInvalid);
    };
    let envelope: Envelope =
        serde_json::from_str(&state_json).map_err(|_| LoginFinishError::CeremonyInvalid)?;
    let state: DiscoverableAuthentication =
        serde_json::from_value(envelope.state).map_err(|_| LoginFinishError::CeremonyInvalid)?;

    // identify + resolve the owner by credential id (spec 2-4). The
    // credential id is UNIQUE and maps 1:1 to a user server-side, so it is
    // the resolution key; the presented user handle is compared against the
    // stored handle for audit only. Requiring handle equality here would
    // permanently lock out credentials registered before 2026-10-17, whose
    // stored handle was generated independently of the challenge handle.
    let (uuid, cred_id) = match webauthn.identify_discoverable_authentication(credential) {
        Ok((uuid, cred_id)) => (uuid, cred_id.to_vec()),
        Err(_) => {
            mismatch_audit(&mut conn, None, now).await?;
            return Err(LoginFinishError::Mismatch);
        }
    };

    // From the owner resolution on, everything runs in one BEGIN IMMEDIATE
    // transaction (spec 2-4, TASK-147): the user / passkey reads, the
    // verification against the stored sign counter, the credential update,
    // the carried-cookie revocation, the new session and the audit row. The
    // counter is checked against the latest stored value under the write
    // lock, so concurrent logins with one credential never roll it back.
    // Failure audits are written in the same transaction and committed
    // before the 401. Inside the transaction nothing acquires another pool
    // connection (that would self-deadlock until busy_timeout).
    // test-only pause point (feature `test-hooks`; no-op otherwise): just
    // ahead of taking the write lock (TASK-147 sign-counter race tests).
    test_hooks.pause_login_before_write_lock().await;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(anyhow::Error::from)?;
    let row: Option<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT u.id, u.webauthn_user_handle FROM users u
         JOIN webauthn_credentials c ON c.user_id = u.id
         WHERE c.credential_id = ? AND u.disabled_at IS NULL",
    )
    .bind(&cred_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let Some((user_id, stored_handle)) = row else {
        mismatch_audit(&mut tx, Some((&uuid, &cred_id)), now).await?;
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Err(LoginFinishError::Mismatch);
    };
    let handle_matches = stored_handle.as_slice() == uuid.as_bytes();
    let creds = load_passkeys(&mut tx, user_id).await?;
    if creds.is_empty() {
        mismatch_audit(&mut tx, Some((&uuid, &cred_id)), now).await?;
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Err(LoginFinishError::Mismatch);
    }
    let discoverable: Vec<DiscoverableKey> =
        creds.iter().map(|(_, _, pk)| pk.clone().into()).collect();
    let result = match webauthn.finish_discoverable_authentication(credential, state, &discoverable)
    {
        Ok(r) => r,
        Err(e) => {
            // every verification failure rejects the login (spec 2-4); the
            // audit action distinguishes counter regressions from other
            // failures (bad signature, origin mismatch, ...).
            let cred_row_id = creds
                .iter()
                .find(|(_, cid, _)| cid == &cred_id)
                .map(|(id, _, _)| *id)
                .unwrap_or(0);
            let action = if matches!(
                e,
                webauthn_rs::prelude::WebauthnError::CredentialPossibleCompromise
            ) {
                "counter_regression"
            } else {
                "login_failed"
            };
            super::audit(
                &mut tx,
                "web",
                "webauthn_credential",
                cred_row_id,
                action,
                Some(user_id),
                &serde_json::json!({
                    "error": e.to_string(),
                    "credential_id_hash_prefix": to_hex(&sha256(&cred_id))[..8].to_string()
                }),
                now,
            )
            .await
            .map_err(anyhow::Error::from)?;
            tx.commit().await.map_err(anyhow::Error::from)?;
            return Err(LoginFinishError::Authentication);
        }
    };

    // success path: credential update (from the creds read above, under the
    // write lock), carried-cookie revocation, new session and audit land
    // together (or not at all).
    update_credential_after_auth(&mut tx, user_id, &cred_id, &creds, &result, now).await?;

    // a carried session cookie is revoked regardless of its user (spec 2-4).
    if let Some(old) = old_session {
        sqlx::query(
            "UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(sha256(old).to_vec())
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    }
    let session_token = random_token();
    sqlx::query(
        "INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at,
            idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256(&session_token).to_vec())
    .bind(user_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now + cfg.session.idle_days * DAY_MS)
    .bind(now + cfg.session.absolute_days * DAY_MS)
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    super::audit(
        &mut tx,
        "web",
        "user",
        user_id,
        "login",
        Some(user_id),
        &if handle_matches {
            serde_json::json!({})
        } else {
            // legacy credentials registered before the challenge handle was
            // persisted still log in; the flag makes those rows visible.
            serde_json::json!({ "user_handle_match": false })
        },
        now,
    )
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(LoginFinishOutcome {
        absolute_expires_at: now + cfg.session.absolute_days * DAY_MS,
        session: session_token,
        next: if authz_hash.is_some() {
            Some("consent")
        } else {
            None
        },
    })
}

async fn mismatch_audit(
    conn: &mut SqliteConnection,
    ids: Option<(&Uuid, &[u8])>,
    now: i64,
) -> Result<(), LoginFinishError> {
    let after = match ids {
        Some((uuid, cred_id)) => serde_json::json!({
            "user_handle_prefix": to_hex(&uuid.as_bytes()[..4]),
            "credential_id_hash_prefix": to_hex(&sha256(cred_id))[..8].to_string()
        }),
        None => serde_json::json!({ "reason": "identify_failed" }),
    };
    super::audit(conn, "web", "user", 0, "login_mismatch", None, &after, now)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(())
}

/// (row id, credential id, passkey) for one user.
async fn load_passkeys(
    conn: &mut SqliteConnection,
    user_id: i64,
) -> anyhow::Result<Vec<(i64, Vec<u8>, Passkey)>> {
    let rows: Vec<(i64, Vec<u8>, String)> = sqlx::query_as(
        "SELECT id, credential_id, passkey_json FROM webauthn_credentials WHERE user_id = ? ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|(id, cid, json)| {
            let pk: Passkey = serde_json::from_str(&json)?;
            Ok((id, cid, pk))
        })
        .collect()
}

/// Persist `update_credential` results (spec 2-4) and `last_used_at`.
///
/// Both callers (`login_finish` / `reauth_finish`) pass `creds` read inside
/// the same `BEGIN IMMEDIATE` transaction as `conn` (TASK-147 / 154): the
/// stored `passkey_json` is overwritten whole from that snapshot, so a
/// snapshot read before the write lock could roll the sign counter back.
async fn update_credential_after_auth(
    conn: &mut SqliteConnection,
    user_id: i64,
    cred_id: &[u8],
    creds: &[(i64, Vec<u8>, Passkey)],
    result: &AuthenticationResult,
    now: i64,
) -> anyhow::Result<()> {
    if let Some((row_id, _, pk)) = creds.iter().find(|(_, cid, _)| cid == cred_id) {
        let mut pk = pk.clone();
        if pk.update_credential(result).is_some() {
            let json = serde_json::to_string(&pk)?;
            sqlx::query(
                "UPDATE webauthn_credentials SET passkey_json = ?, updated_at = ? WHERE id = ?",
            )
            .bind(&json)
            .bind(now)
            .bind(row_id)
            .execute(&mut *conn)
            .await?;
        }
    }
    sqlx::query(
        "UPDATE webauthn_credentials SET last_used_at = ? WHERE credential_id = ? AND user_id = ?",
    )
    .bind(now)
    .bind(cred_id)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// step-up re-authentication (spec_auth.md section 2-6)

#[derive(Debug, thiserror::Error)]
pub enum ReauthError {
    #[error("no passkeys to authenticate with")]
    NoCredentials,
    #[error("ceremony invalid or expired")]
    CeremonyInvalid,
    #[error("ceremony belongs to another session")]
    UserMismatch,
    #[error("authentication rejected")]
    Authentication,
    #[error("webauthn error: {0}")]
    Webauthn(String),
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

pub struct AuthStartOutcome {
    pub rcr: RequestChallengeResponse,
    pub ceremony: [u8; TOKEN_LEN],
    pub ttl_secs: i64,
}

pub async fn reauth_start(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    cfg: &ResolvedAuth,
    user_id: i64,
    now: i64,
) -> Result<AuthStartOutcome, ReauthError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let creds = load_passkeys(&mut conn, user_id).await?;
    if creds.is_empty() {
        return Err(ReauthError::NoCredentials);
    }
    let passkeys: Vec<Passkey> = creds.into_iter().map(|(_, _, pk)| pk).collect();
    let (mut rcr, state) = webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|e| ReauthError::Webauthn(e.to_string()))?;
    // Same cleanup as login: no request extensions, no mediation hint.
    rcr.public_key.extensions = None;
    rcr.mediation = None;
    let envelope = Envelope {
        invitation_hash: None,
        display_name: None,
        user_handle: None,
        state: serde_json::to_value(&state).map_err(|e| ReauthError::Db(e.into()))?,
    };
    let state_json = serde_json::to_string(&envelope).map_err(|e| ReauthError::Db(e.into()))?;
    let ceremony = insert_ceremony(
        &mut conn,
        "authenticate",
        Some(user_id),
        &state_json,
        None,
        now,
        cfg.ceremony.ttl_secs,
    )
    .await
    .map_err(anyhow::Error::from)?;
    Ok(AuthStartOutcome {
        rcr,
        ceremony,
        ttl_secs: cfg.ceremony.ttl_secs,
    })
}

/// Sign-counter rule of spec_auth.md sections 2-4 / 2-6 (the same rule
/// webauthn-rs applies during its own verification): when either side is a
/// positive counter, an assertion that did not advance past the stored value
/// (`received <= stored`) is a regression. A counter-0-fixed authenticator
/// (received = 0 / stored = 0) passes — the check is simply skipped for it.
fn counter_regressed(received: u32, stored: u32) -> bool {
    (received > 0 || stored > 0) && received <= stored
}

/// Non-discoverable step-up finish. The ceremony must belong to the session's
/// user (mismatch: 403, ceremony deleted). On success the same session row's
/// `auth_at` is renewed.
pub async fn reauth_finish(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    s: &ValidSession,
    ceremony_token: &[u8; TOKEN_LEN],
    credential: &PublicKeyCredential,
    now: i64,
    test_hooks: &crate::test_hooks::TestHooks,
) -> Result<(), ReauthError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    // Atomic consumption (spec 2-5, TASK-154): DELETE ... RETURNING admits
    // exactly one of concurrent submissions of the same ceremony. The expiry
    // check rides the WHERE clause; a missing or expired row is the same 400
    // as the old peek miss. The owner check uses the returned row.
    let Some((ceremony_user, _, state_json)) =
        take_ceremony(&mut conn, ceremony_token, "authenticate", now)
            .await
            .map_err(anyhow::Error::from)?
    else {
        return Err(ReauthError::CeremonyInvalid);
    };
    if ceremony_user != Some(s.user_id) {
        return Err(ReauthError::UserMismatch);
    }
    let envelope: Envelope =
        serde_json::from_str(&state_json).map_err(|_| ReauthError::CeremonyInvalid)?;
    let state: PasskeyAuthentication =
        serde_json::from_value(envelope.state).map_err(|_| ReauthError::CeremonyInvalid)?;
    let result = match webauthn.finish_passkey_authentication(credential, &state) {
        Ok(r) => r,
        Err(e) => {
            // step-up failure (spec_auth.md 10-5, TASK-15): WARN with the
            // reason; the error text carries no secrets. Pure CPU work on the
            // ceremony snapshot, so it stays outside the write lock.
            tracing::warn!(action = %"reauth_failed", error = %e, "auth failure");
            return Err(ReauthError::Authentication);
        }
    };
    // From the ownership resolution on, everything runs in one BEGIN
    // IMMEDIATE transaction (spec 2-6, TASK-154): the passkey read, the
    // counter re-check against the latest stored value, the credential
    // update and the auth_at renewal. The verification above used the
    // ceremony snapshot, whose counter can be up to the ceremony TTL old;
    // re-checking under the write lock closes that window, so a delayed or
    // parked step-up assertion never rolls the stored counter back. Every
    // failure below leaves nothing written (the dropped transaction rolls
    // back). Inside the transaction nothing acquires another pool connection
    // (that would self-deadlock until busy_timeout). test-only pause point
    // (feature `test-hooks`; no-op otherwise): just ahead of taking the
    // write lock.
    test_hooks.pause_reauth_before_write_lock().await;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(anyhow::Error::from)?;
    // the authenticated credential must belong to this user (spec 2-6);
    // resolving it against the passkeys read inside the transaction also
    // closes the race where the credential is deleted mid-flight and a
    // stale auth_at renewal would still land.
    let creds = load_passkeys(&mut tx, s.user_id).await?;
    if !creds
        .iter()
        .any(|(_, cid, _)| cid.as_slice() == result.cred_id().as_slice())
    {
        tracing::warn!(action = %"reauth_mismatch", "auth failure");
        return Err(ReauthError::Authentication);
    }
    // fresh-counter re-check (spec 2-6): this stored value is the latest,
    // not the ceremony snapshot the assertion was verified against.
    let stored_raw: i64 = sqlx::query_scalar(
        "SELECT json_extract(passkey_json, '$.cred.counter') FROM webauthn_credentials
         WHERE user_id = ? AND credential_id = ?",
    )
    .bind(s.user_id)
    .bind(result.cred_id().as_slice())
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let stored = u32::try_from(stored_raw).map_err(anyhow::Error::from)?;
    if counter_regressed(result.counter(), stored) {
        // step-up failures stay WARN-only (spec 10-5 exception): no
        // audit_events row; the user recovers by retrying.
        let cred_prefix = to_hex(&sha256(result.cred_id()))[..8].to_string();
        tracing::warn!(action = %"counter_regression", credential_id_hash_prefix = %cred_prefix, "auth failure");
        return Err(ReauthError::Authentication);
    }
    update_credential_after_auth(&mut tx, s.user_id, result.cred_id(), &creds, &result, now)
        .await?;
    let renewed = sqlx::query("UPDATE web_sessions SET auth_at = ? WHERE id_hash = ?")
        .bind(now)
        .bind(&s.id_hash)
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?
        .rows_affected();
    if renewed == 0 {
        // the session row vanished between the handler's check and this
        // update: fail the step-up so the credential update rolls back with
        // it (tx atomicity) instead of silently succeeding.
        tracing::warn!(action = %"reauth_failed", reason = "session_row_vanished", "auth failure");
        return Err(ReauthError::Authentication);
    }
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// adding a passkey while logged in (spec_auth.md sections 2-6, 2-7)

pub struct PasskeyAddStartOutcome {
    pub ccr: CreationChallengeResponse,
    pub ceremony: [u8; TOKEN_LEN],
    pub ttl_secs: i64,
}

pub async fn passkey_add_start(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    cfg: &ResolvedAuth,
    s: &ValidSession,
    now: i64,
) -> Result<PasskeyAddStartOutcome, ReauthError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let row: Option<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT webauthn_user_handle, display_name FROM users WHERE id = ? AND disabled_at IS NULL",
    )
    .bind(s.user_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(anyhow::Error::from)?;
    let Some((handle, display)) = row else {
        return Err(ReauthError::NoCredentials);
    };
    let uuid = Uuid::from_slice(&handle).map_err(|e| ReauthError::Db(e.into()))?;
    let exclude: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
            .bind(s.user_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(anyhow::Error::from)?;
    let user_name = format!("{display} (kakeiboot)");
    let (mut ccr, state) = webauthn
        .start_passkey_registration(
            uuid,
            &user_name,
            &display,
            if exclude.is_empty() {
                None
            } else {
                Some(exclude.into_iter().map(CredentialID::from).collect())
            },
        )
        .map_err(|e| ReauthError::Webauthn(e.to_string()))?;
    overwrite_resident_key_preferred(&mut ccr);
    let envelope = Envelope {
        invitation_hash: None,
        display_name: None,
        user_handle: None,
        state: serde_json::to_value(&state).map_err(|e| ReauthError::Db(e.into()))?,
    };
    let state_json = serde_json::to_string(&envelope).map_err(|e| ReauthError::Db(e.into()))?;
    let ceremony = insert_ceremony(
        &mut conn,
        "register",
        Some(s.user_id),
        &state_json,
        None,
        now,
        cfg.ceremony.ttl_secs,
    )
    .await
    .map_err(anyhow::Error::from)?;
    Ok(PasskeyAddStartOutcome {
        ccr,
        ceremony,
        ttl_secs: cfg.ceremony.ttl_secs,
    })
}

#[allow(clippy::too_many_arguments)] // finish inputs mirror the spec's request body
pub async fn passkey_add_finish(
    pool: &SqlitePool,
    webauthn: &Webauthn,
    s: &ValidSession,
    ceremony_token: &[u8; TOKEN_LEN],
    credential: &RegisterPublicKeyCredential,
    label: Option<&str>,
    user_agent: Option<&str>,
    now: i64,
) -> Result<(), ReauthError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let Some((ceremony_user, _, state_json)) =
        take_ceremony(&mut conn, ceremony_token, "register", now)
            .await
            .map_err(anyhow::Error::from)?
    else {
        return Err(ReauthError::CeremonyInvalid);
    };
    if ceremony_user != Some(s.user_id) {
        return Err(ReauthError::UserMismatch);
    }
    let envelope: Envelope =
        serde_json::from_str(&state_json).map_err(|_| ReauthError::CeremonyInvalid)?;
    if envelope.invitation_hash.is_some() {
        // token-based registrations go through register_finish.
        return Err(ReauthError::CeremonyInvalid);
    }
    let state: PasskeyRegistration =
        serde_json::from_value(envelope.state).map_err(|_| ReauthError::CeremonyInvalid)?;
    let passkey = webauthn
        .finish_passkey_registration(credential, &state)
        .map_err(|_| ReauthError::Authentication)?;
    let passkey_json = serde_json::to_string(&passkey).map_err(|e| ReauthError::Db(e.into()))?;
    let label =
        normalize_label(label).or_else(|| user_agent.map(super::tokens::default_label_from_ua));
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(anyhow::Error::from)?;
    let cred_row_id: i64 = sqlx::query_scalar(
        "INSERT INTO webauthn_credentials (user_id, credential_id, passkey_json, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(s.user_id)
    .bind(passkey.cred_id().as_slice())
    .bind(&passkey_json)
    .bind(&label)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    super::audit(
        &mut tx,
        "web",
        "webauthn_credential",
        cred_row_id,
        "create",
        Some(s.user_id),
        &serde_json::json!({ "via": "settings" }),
        now,
    )
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(())
}
