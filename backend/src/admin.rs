//! Operator CLI (`budget-book admin ...`, spec_auth.md section 9): user
//! lookup / notes / disable, setup / recovery token issue / list / revoke,
//! passkey list / revoke. Reads the same `configs/` and talks to the DB
//! directly (WAL allows running beside the server).
//!
//! Destructive operations ask for re-typed confirmations; every issue /
//! revoke / disable / note update is written to audit_events with
//! actor_kind=system and the OS user name in after_json. Token plaintext is
//! printed exactly once and never audited or logged.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Parser, Subcommand, ValueEnum};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, SqlitePool};

use crate::auth::invitation::{self, InvitationKind};
use crate::auth::tokens::{normalize_account_number, to_hex};
use crate::auth::{audit, register_invitation, session};
use crate::config::{Config, ResolvedAuth};

// ---------------------------------------------------------------------------
// argument model

#[derive(Parser, Debug)]
#[command(name = "budget-book admin", about = "budget-book operator CLI")]
pub struct Cli {
    #[arg(long, global = true, value_name = "DIR")]
    config_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    #[command(subcommand)]
    /// User lookup and management.
    User(UserCmd),
    #[command(subcommand)]
    /// Setup / recovery token management.
    Token(TokenCmd),
    #[command(subcommand)]
    /// Passkey listing and revocation.
    Passkey(PasskeyCmd),
    #[command(subcommand)]
    /// OAuth grant listing and revocation.
    Grant(GrantCmd),
    #[command(subcommand)]
    /// Web session listing and revocation.
    Session(SessionCmd),
    #[command(subcommand)]
    /// Anonymous recovery request triage.
    Recovery(RecoveryCmd),
    /// Take a single-file snapshot of the DB into --dest (TASK-83,
    /// spec_auth.md section 9: read-only open + `VACUUM INTO`).
    Backup {
        #[arg(long, value_name = "FILE")]
        dest: PathBuf,
    },
}

#[derive(Subcommand, Debug)]
pub enum UserCmd {
    /// Search users by name / notes / account number / ledger.
    List {
        #[arg(long)]
        query: Option<String>,
        /// Filter by ledger name or ID. Prefer the ID: auto-created
        /// personal ledgers share the name "default book" (TASK-16).
        #[arg(long)]
        ledger: Option<String>,
    },
    /// Show one user (lineage, ledgers, passkeys, sessions, grants).
    Show { user: String },
    /// Update the operator note (admin_note).
    Note { user: String, text: String },
    /// Disable a user (revokes grants and web sessions in the same tx).
    Disable { user: String },
}

#[derive(Subcommand, Debug)]
pub enum TokenCmd {
    /// Issue a setup or recovery registration URL.
    Issue {
        #[arg(long)]
        kind: TokenKind,
        /// Who this token was handed to (required for setup).
        #[arg(long)]
        note: Option<String>,
        /// Target user (account number or id, required for recovery).
        #[arg(long)]
        user: Option<String>,
        /// TTL like 30m / 2h / 1d (recovery max 24h).
        #[arg(long)]
        ttl: Option<String>,
        /// Skip the display-name re-entry confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// List tokens (unused and used).
    List {
        #[arg(long)]
        kind: Option<TokenKind>,
        #[arg(long)]
        user: Option<String>,
    },
    /// Delete a token by hash hex prefix (8+ chars).
    Revoke { token_id: String },
}

#[derive(Subcommand, Debug)]
pub enum PasskeyCmd {
    /// List a user's passkeys.
    List { user: String },
    /// Delete passkey rows (the last one too; the user cannot log in after).
    Revoke {
        user: String,
        passkey_id: Option<i64>,
        #[arg(long)]
        all: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum GrantCmd {
    /// List a user's OAuth grants.
    List { user: String },
    /// Revoke a grant (or all of a user's).
    Revoke {
        grant_id: Option<i64>,
        #[arg(long)]
        all_of: Option<String>,
    },
    /// List grants whose refresh family holds two or more concurrent tips
    /// (read-only; TASK-155). Omit --user to scan all users.
    ConcurrentFamilies {
        /// Target user (account number or id).
        #[arg(long)]
        user: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum SessionCmd {
    /// List a user's web sessions.
    List { user: String },
    /// Revoke a session by hash prefix (or all of a user's).
    Revoke {
        session_id: Option<String>,
        #[arg(long)]
        all_of: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum RecoveryCmd {
    /// List recovery requests (open ones with --status open).
    List {
        #[arg(long)]
        status: Option<String>,
    },
    /// Show one request with its candidate users.
    Show { request_number: String },
    /// Resolve a request: verify the user out-of-band and issue a recovery URL.
    Resolve {
        request_number: String,
        #[arg(long)]
        user: String,
        #[arg(long)]
        yes: bool,
    },
    /// Reject a request.
    Reject {
        request_number: String,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum TokenKind {
    Setup,
    Invite,
    Recovery,
    Register,
}

impl TokenKind {
    fn to_invitation_kind(self) -> Option<InvitationKind> {
        match self {
            Self::Setup => Some(InvitationKind::Setup),
            Self::Invite => Some(InvitationKind::Invite),
            Self::Recovery => Some(InvitationKind::Recovery),
            // register tokens live in their own table; there is no
            // InvitationKind mapping (issuance is web-only anyway).
            Self::Register => None,
        }
    }
}

/// Parse a `--ttl` duration (`45s`, `90m`, `24h`, `2d`) into milliseconds.
pub fn parse_ttl(s: &str) -> Option<i64> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).filter(|i| *i > 0)?;
    let (num, unit) = s.split_at(split);
    let value: i64 = num.parse().ok()?;
    if value <= 0 {
        return None;
    }
    let unit_ms = match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    Some(value * unit_ms)
}

/// Argument-level validation before touching the DB.
pub fn validate_args(cli: &Cli) -> anyhow::Result<()> {
    let Command::Token(cmd) = &cli.command else {
        return Ok(());
    };
    let (kind, note, user, ttl) = match cmd {
        TokenCmd::Issue {
            kind,
            note,
            user,
            ttl,
            ..
        } => (kind, note, user, ttl),
        // register tokens carry no target user: --user narrows recovery
        // targets (an invitations-only concept), so pairing it with
        // --kind register would list user-unrelated rows under a user
        // filter (TASK-32 review)
        TokenCmd::List {
            kind: Some(TokenKind::Register),
            user: Some(_),
        } => {
            anyhow::bail!(
                "--user is only valid for invitation tokens; register tokens are not user-scoped"
            );
        }
        _ => return Ok(()),
    };
    match kind {
        TokenKind::Setup => {
            if note.as_deref().map(str::trim).unwrap_or("").is_empty() {
                anyhow::bail!("--note is required for --kind setup (who it was handed to)");
            }
            if user.is_some() {
                anyhow::bail!("--user is only valid for --kind recovery");
            }
        }
        TokenKind::Invite => anyhow::bail!("invite tokens are issued from the web UI, not the CLI"),
        TokenKind::Register => {
            anyhow::bail!("register tokens are issued from the web UI, not the CLI")
        }
        TokenKind::Recovery => {
            if user.is_none() {
                anyhow::bail!("--user is required for --kind recovery");
            }
        }
    }
    if let Some(ttl) = ttl
        && parse_ttl(ttl).is_none()
    {
        anyhow::bail!("invalid --ttl {ttl:?}: use e.g. 45s, 90m, 24h, 2d");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// prompting (testable)

pub trait Prompter {
    fn read_line(&mut self) -> std::io::Result<String>;
}

pub struct StdPrompter;

impl Prompter for StdPrompter {
    fn read_line(&mut self) -> std::io::Result<String> {
        let mut s = String::new();
        std::io::stdin().read_line(&mut s)?;
        Ok(s.trim_end_matches(['\r', '\n']).to_string())
    }
}

/// Scripted answers for tests.
pub struct ScriptedPrompter {
    pub lines: Vec<String>,
}

impl Prompter for ScriptedPrompter {
    fn read_line(&mut self) -> std::io::Result<String> {
        Ok(if self.lines.is_empty() {
            String::new()
        } else {
            self.lines.remove(0)
        })
    }
}

fn prompt(p: &mut dyn Prompter, out: &mut dyn Write, msg: &str) -> std::io::Result<String> {
    writeln!(out, "{msg}")?;
    p.read_line()
}

// ---------------------------------------------------------------------------
// entry points

/// Parse argv (after `admin`), load configs, connect the DB, dispatch.
///
/// `backup` is dispatched before the shared `db::connect_file` call: it
/// resolves the db path itself and opens the source read-only (no create,
/// no migrations), so a misconfigured path must fail the open instead of
/// creating an empty migrated db (TASK-83, spec_auth.md section 9).
pub async fn run(args: Vec<String>) -> anyhow::Result<()> {
    let cli = Cli::try_parse_from(std::iter::once("budget-book-admin".to_string()).chain(args))?;
    validate_args(&cli)?;
    let dir = crate::config::Config::resolve_dir(cli.config_dir.clone());
    let cfg = Config::load(&dir)?;
    if let Command::Backup { dest } = &cli.command {
        backup(&cfg, dest).await?;
        println!("backup: {}", dest.display());
        return Ok(());
    }
    let pool = crate::db::connect_file(&cfg.database_path(), &cfg.app.database).await?;
    let mut out = std::io::stdout();
    let mut prompter = StdPrompter;
    run_with(&pool, &cfg, &cli, &mut prompter, &mut out).await
}

/// Testable core: same behavior with an injected prompter and output sink.
pub async fn run_with(
    pool: &SqlitePool,
    cfg: &Config,
    cli: &Cli,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    match &cli.command {
        Command::User(UserCmd::List { query, ledger }) => {
            user_list(pool, query.as_deref(), ledger.as_deref(), out).await
        }
        Command::User(UserCmd::Show { user }) => {
            let u = resolve_user(pool, user).await?;
            user_show(pool, &u, out).await
        }
        Command::User(UserCmd::Note { user, text }) => {
            let u = resolve_user(pool, user).await?;
            user_note(pool, &u, text, out).await
        }
        Command::User(UserCmd::Disable { user }) => {
            let u = resolve_user(pool, user).await?;
            user_disable(pool, &u, prompter, out).await
        }
        Command::Token(TokenCmd::Issue {
            kind,
            note,
            user,
            ttl,
            yes,
        }) => {
            token_issue(
                pool,
                &cfg.auth,
                *kind,
                note.as_deref(),
                user.as_deref(),
                ttl.as_deref(),
                *yes,
                prompter,
                out,
            )
            .await
        }
        Command::Token(TokenCmd::List { kind, user }) => {
            let target = match user {
                Some(u) => Some(resolve_user(pool, u).await?.id),
                None => None,
            };
            token_list(pool, *kind, target, out).await
        }
        Command::Token(TokenCmd::Revoke { token_id }) => token_revoke(pool, token_id, out).await,
        Command::Passkey(PasskeyCmd::List { user }) => {
            let u = resolve_user(pool, user).await?;
            passkey_list(pool, &u, out).await
        }
        Command::Passkey(PasskeyCmd::Revoke {
            user,
            passkey_id,
            all,
        }) => {
            let u = resolve_user(pool, user).await?;
            passkey_revoke(pool, &u, *passkey_id, *all, prompter, out).await
        }
        Command::Grant(GrantCmd::List { user }) => {
            let u = resolve_user(pool, user).await?;
            grant_list(pool, &u, out).await
        }
        Command::Grant(GrantCmd::Revoke { grant_id, all_of }) => {
            grant_revoke(pool, *grant_id, all_of.as_deref(), prompter, out).await
        }
        Command::Grant(GrantCmd::ConcurrentFamilies { user }) => {
            let target = match user {
                Some(u) => Some(resolve_user(pool, u).await?.id),
                None => None,
            };
            concurrent_families(pool, target, out).await
        }
        Command::Session(SessionCmd::List { user }) => {
            let u = resolve_user(pool, user).await?;
            session_list(pool, &u, out).await
        }
        Command::Session(SessionCmd::Revoke { session_id, all_of }) => {
            session_revoke(
                pool,
                session_id.as_deref(),
                all_of.as_deref(),
                prompter,
                out,
            )
            .await
        }
        Command::Recovery(RecoveryCmd::List { status }) => {
            recovery_list(pool, status.as_deref(), out).await
        }
        Command::Recovery(RecoveryCmd::Show { request_number }) => {
            recovery_show(pool, request_number, out).await
        }
        Command::Recovery(RecoveryCmd::Resolve {
            request_number,
            user,
            yes,
        }) => recovery_resolve(pool, &cfg.auth, request_number, user, *yes, prompter, out).await,
        Command::Recovery(RecoveryCmd::Reject {
            request_number,
            reason,
        }) => recovery_reject(pool, request_number, reason.as_deref(), out).await,
        // Backup opens its own read-only connection and never uses the
        // shared pool; `run` dispatches it before connecting (TASK-83).
        Command::Backup { .. } => anyhow::bail!(
            "backup resolves its own read-only connection and is only reachable via run()"
        ),
    }
}

// ---------------------------------------------------------------------------
// backup (TASK-83, spec_auth.md section 9)

/// `<dest>.tmp` staging path the snapshot is written to before the rename.
fn backup_tmp_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".tmp");
    PathBuf::from(s)
}

/// `admin backup --dest <file>`: single-file snapshot of the WAL database.
///
/// The source is opened read-only (`create_if_missing(false)`, no
/// migrations — deliberately not `db::connect_file`, which creates and
/// migrates: a misconfigured path must fail the open, never materialize an
/// empty migrated db). `VACUUM INTO` runs as a WAL reader, so parallel
/// writers keep running and the output is one point-in-time-consistent
/// file. SQLite refuses to overwrite an existing output file, so the tmp is
/// removed before the run (an interrupted run's leftover cannot wedge
/// reruns) and again on failure; success ends with `fs::rename` onto the
/// destination. Not written to audit_events: the actor is the operator and
/// the daily timer would be audit noise (journal and the backup-side
/// `last_success` file carry the record).
async fn backup(cfg: &Config, dest: &Path) -> anyhow::Result<()> {
    let opts = SqliteConnectOptions::new()
        .filename(cfg.database_path())
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_millis(cfg.app.database.busy_timeout_ms));
    let mut conn = SqliteConnection::connect_with(&opts).await?;
    let tmp = backup_tmp_path(dest);
    let _ = std::fs::remove_file(&tmp);
    let tmp_str = tmp.to_string_lossy().into_owned();
    if let Err(e) = sqlx::query("VACUUM INTO ?")
        .bind(tmp_str)
        .execute(&mut conn)
        .await
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    conn.close().await?;
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// user data

pub struct UserSummary {
    pub id: i64,
    pub account_number: String,
    pub display_name: String,
}

/// Resolve a CLI user argument: numeric id, else a normalized account number
/// (`bb abcd 2345`, `BB-ABCD-2345`, `abcd2345` all match).
pub async fn resolve_user(pool: &SqlitePool, arg: &str) -> anyhow::Result<UserSummary> {
    if let Ok(id) = arg.trim().parse::<i64>() {
        let row: Option<(i64, String, String)> =
            sqlx::query_as("SELECT id, account_number, display_name FROM users WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        if let Some((id, account_number, display_name)) = row {
            return Ok(UserSummary {
                id,
                account_number,
                display_name,
            });
        }
        anyhow::bail!("no user with id {id}");
    }
    let wanted = normalize_account_number(arg);
    if wanted.is_empty() {
        anyhow::bail!("empty user reference");
    }
    let rows: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, account_number, display_name FROM users")
            .fetch_all(pool)
            .await?;
    let matches: Vec<_> = rows
        .into_iter()
        .filter(|(_, acc, _)| normalize_account_number(acc) == wanted)
        .collect();
    match matches.len() {
        1 => {
            let (id, account_number, display_name) = matches[0].clone();
            Ok(UserSummary {
                id,
                account_number,
                display_name,
            })
        }
        0 => anyhow::bail!("no user matches {arg:?}"),
        n => anyhow::bail!("account number reference {arg:?} is ambiguous ({n} users)"),
    }
}

/// users columns for the list view.
type UserCols = (
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// users columns for the show view.
type UserShowCols = (
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
);

/// webauthn_credentials columns for passkey listings.
type PasskeyCols = (i64, Option<String>, i64, Option<i64>, String);

struct UserListEntry {
    id: i64,
    account_number: String,
    display_name: String,
    admin_note: Option<String>,
    invite_note: Option<String>,
    disabled: Option<i64>,
    memberships: Vec<(i64, String, String)>,
    passkeys: i64,
    last_login: Option<i64>,
}

async fn load_user_entries(pool: &SqlitePool) -> anyhow::Result<Vec<UserListEntry>> {
    let users: Vec<UserCols> = sqlx::query_as(
        "SELECT id, account_number, display_name, admin_note, invite_note, disabled_at
         FROM users ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    let memberships: Vec<(i64, i64, String, String)> = sqlx::query_as(
        "SELECT m.user_id, l.id, l.name, m.role
         FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id ORDER BY m.user_id, l.id",
    )
    .fetch_all(pool)
    .await?;
    let passkeys: Vec<(i64, i64)> =
        sqlx::query_as("SELECT user_id, COUNT(*) FROM webauthn_credentials GROUP BY user_id")
            .fetch_all(pool)
            .await?;
    let logins: Vec<(i64, Option<i64>)> =
        sqlx::query_as("SELECT user_id, MAX(last_seen_at) FROM web_sessions GROUP BY user_id")
            .fetch_all(pool)
            .await?;
    Ok(users
        .into_iter()
        .map(
            |(id, account_number, display_name, admin_note, invite_note, disabled)| UserListEntry {
                id,
                account_number,
                display_name,
                admin_note,
                invite_note,
                disabled,
                memberships: memberships
                    .iter()
                    .filter(|(uid, _, _, _)| *uid == id)
                    .map(|(_, lid, name, role)| (*lid, name.clone(), role.clone()))
                    .collect(),
                passkeys: passkeys
                    .iter()
                    .find(|(uid, _)| *uid == id)
                    .map(|(_, c)| *c)
                    .unwrap_or(0),
                last_login: logins
                    .iter()
                    .find(|(uid, _)| *uid == id)
                    .and_then(|(_, t)| *t),
            },
        )
        .collect())
}

async fn user_list(
    pool: &SqlitePool,
    query: Option<&str>,
    ledger: Option<&str>,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let entries = load_user_entries(pool).await?;
    let q = query.map(str::trim).filter(|s| !s.is_empty());
    let ledger_filter_id = ledger.and_then(|l| l.trim().parse::<i64>().ok());
    let mut shown = 0;
    for e in &entries {
        if let Some(q) = q {
            let ql = q.to_lowercase();
            let account_match =
                normalize_account_number(&e.account_number) == normalize_account_number(q);
            let text_match = e.display_name.to_lowercase().contains(&ql)
                || e.admin_note
                    .as_deref()
                    .is_some_and(|n| n.to_lowercase().contains(&ql))
                || e.invite_note
                    .as_deref()
                    .is_some_and(|n| n.to_lowercase().contains(&ql));
            if !account_match && !text_match {
                continue;
            }
        }
        if let Some(ledger) = ledger {
            let matches = e
                .memberships
                .iter()
                .any(|(lid, name, _)| Some(*lid) == ledger_filter_id || name == ledger);
            if !matches {
                continue;
            }
        }
        let ledgers: Vec<String> = e
            .memberships
            .iter()
            .map(|(lid, name, role)| format!("{name}(id={lid},{role})"))
            .collect();
        writeln!(
            out,
            "user {id} {account} {name} | note: {note} | ledgers: {ledgers} | passkeys: {pk} | last_login: {login}{disabled}",
            id = e.id,
            account = e.account_number,
            name = e.display_name,
            note = e.admin_note.as_deref().unwrap_or("-"),
            ledgers = ledgers.join(", "),
            pk = e.passkeys,
            login = e.last_login.map(ms_to_jst).as_deref().unwrap_or("-"),
            disabled = if e.disabled.is_some() {
                " | DISABLED"
            } else {
                ""
            },
        )?;
        shown += 1;
    }
    writeln!(out, "{shown} user(s)")?;
    Ok(())
}

async fn user_show(pool: &SqlitePool, u: &UserSummary, out: &mut dyn Write) -> anyhow::Result<()> {
    let now = session::now_ms();
    let row: Option<UserShowCols> = sqlx::query_as(
            "SELECT display_name, admin_note, invite_note, disabled_at, invited_via_kind, default_ledger_id
             FROM users WHERE id = ?",
        )
        .bind(u.id)
        .fetch_optional(pool)
        .await?;
    let Some((display_name, admin_note, invite_note, disabled_at, invited_via, default_ledger)) =
        row
    else {
        anyhow::bail!("user {} disappeared", u.id);
    };
    writeln!(out, "user {} {} {}", u.id, u.account_number, display_name)?;
    if let Some(d) = disabled_at {
        writeln!(out, "  disabled_at: {}", ms_to_jst(d))?;
    }
    writeln!(
        out,
        "  admin_note: {}",
        admin_note.as_deref().unwrap_or("-")
    )?;
    writeln!(
        out,
        "  invite_note: {} (Inviter's note: not operator-verified)",
        invite_note.as_deref().unwrap_or("-")
    )?;
    // lineage chain (spec 7-3)
    writeln!(
        out,
        "  invited_via: {}",
        invited_via.as_deref().unwrap_or("setup")
    )?;
    let mut inviter: Option<i64> = sqlx::query_scalar("SELECT invited_by FROM users WHERE id = ?")
        .bind(u.id)
        .fetch_one(pool)
        .await?;
    let mut depth = 0;
    while let Some(inviter_id) = inviter {
        if depth > 10 {
            writeln!(out, "  lineage: ... (too deep)")?;
            break;
        }
        let row: Option<(i64, String, String, Option<i64>)> = sqlx::query_as(
            "SELECT id, account_number, display_name, invited_by FROM users WHERE id = ?",
        )
        .bind(inviter_id)
        .fetch_optional(pool)
        .await?;
        let Some((id, acc, name, next)) = row else {
            break;
        };
        writeln!(out, "  invited_by: user {id} {acc} {name}")?;
        inviter = next;
        depth += 1;
    }
    if depth == 0 {
        writeln!(out, "  invited_by: -")?;
    }
    // ledgers + co-members
    let memberships: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT l.id, l.name, m.role FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = ? ORDER BY l.id",
    )
    .bind(u.id)
    .fetch_all(pool)
    .await?;
    writeln!(out, "  ledgers:")?;
    for (lid, name, role) in &memberships {
        let mark = if Some(*lid) == default_ledger {
            " (default)"
        } else {
            ""
        };
        let others: Vec<(i64, String, String, String)> = sqlx::query_as(
            "SELECT u.id, u.account_number, u.display_name, m.role
             FROM ledger_members m JOIN users u ON u.id = m.user_id
             WHERE m.ledger_id = ? AND m.user_id <> ? ORDER BY u.id",
        )
        .bind(lid)
        .bind(u.id)
        .fetch_all(pool)
        .await?;
        let others_str = if others.is_empty() {
            "-".to_string()
        } else {
            others
                .iter()
                .map(|(id, acc, name, role)| format!("{name}({id},{acc},{role})"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        writeln!(
            out,
            "    - {name}(id={lid}) role={role}{mark} others: {others_str}"
        )?;
    }
    // passkeys
    let passkeys: Vec<PasskeyCols> = sqlx::query_as(
        "SELECT id, label, created_at, last_used_at, passkey_json
         FROM webauthn_credentials WHERE user_id = ? ORDER BY id",
    )
    .bind(u.id)
    .fetch_all(pool)
    .await?;
    writeln!(out, "  passkeys ({}):", passkeys.len())?;
    for (pid, label, created, last_used, json) in &passkeys {
        writeln!(
            out,
            "    - #{pid} \"{}\" created={} last_used={} backup={}",
            label.as_deref().unwrap_or("-"),
            ms_to_jst(*created),
            last_used.map(ms_to_jst).as_deref().unwrap_or("-"),
            backup_flag(json),
        )?;
    }
    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL AND absolute_expires_at > ?",
    )
    .bind(u.id)
    .bind(now)
    .fetch_one(pool)
    .await?;
    writeln!(out, "  active web sessions: {sessions}")?;
    let grants: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, client_id FROM oauth_grants
         WHERE user_id = ? AND revoked_at IS NULL AND absolute_expires_at > ? ORDER BY id",
    )
    .bind(u.id)
    .bind(now)
    .fetch_all(pool)
    .await?;
    writeln!(out, "  active grants ({}):", grants.len())?;
    for (gid, client) in &grants {
        writeln!(out, "    - grant {gid} client={client}")?;
    }
    let subjects: Option<(i64, i64, i64)> = sqlx::query_as(
        "SELECT COUNT(*), MIN(first_seen_at), MAX(last_seen_at) FROM user_subject_hashes WHERE user_id = ?",
    )
    .bind(u.id)
    .fetch_optional(pool)
    .await?;
    if let Some((count, first, last)) = subjects {
        writeln!(
            out,
            "  subject hashes: {count} (first={} last={})",
            ms_to_jst(first),
            ms_to_jst(last)
        )?;
    }
    Ok(())
}

fn backup_flag(passkey_json: &str) -> &'static str {
    match serde_json::from_str::<serde_json::Value>(passkey_json) {
        Ok(v) => {
            let b = v
                .get("backup_state")
                .and_then(serde_json::Value::as_bool)
                .or_else(|| {
                    v.get("cred")
                        .and_then(|c| c.get("backup_state"))
                        .and_then(serde_json::Value::as_bool)
                });
            match b {
                Some(true) => "synced",
                Some(false) => "device",
                None => "?",
            }
        }
        Err(_) => "?",
    }
}

async fn user_note(
    pool: &SqlitePool,
    u: &UserSummary,
    text: &str,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let now = session::now_ms();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query("UPDATE users SET admin_note = ?, updated_at = ? WHERE id = ?")
        .bind(text)
        .bind(now)
        .bind(u.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n != 1 {
        anyhow::bail!("user {} not found", u.id);
    }
    audit(
        &mut tx,
        "system",
        "user",
        u.id,
        "user_note",
        Some(u.id),
        &serde_json::json!({ "os_user": invitation::os_user(), "admin_note": text }),
        now,
    )
    .await?;
    tx.commit().await?;
    writeln!(out, "updated admin_note of user {}", u.id)?;
    Ok(())
}
async fn user_disable(
    pool: &SqlitePool,
    u: &UserSummary,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    user_show(pool, u, out).await?;
    writeln!(
        out,
        "This disables the user and revokes all grants and web sessions."
    )?;
    let name = prompt(
        prompter,
        out,
        &format!("Re-type the display name ({}) to confirm:", u.display_name),
    )?;
    if name != u.display_name {
        anyhow::bail!("display name mismatch: aborted");
    }
    let acc = prompt(
        prompter,
        out,
        &format!("Re-type the account number ({}):", u.account_number),
    )?;
    if normalize_account_number(&acc) != normalize_account_number(&u.account_number) {
        anyhow::bail!("account number mismatch: aborted");
    }
    let now = session::now_ms();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query(
        "UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL",
    )
    .bind(now)
    .bind(now)
    .bind(u.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n != 1 {
        anyhow::bail!("user {} is already disabled", u.id);
    }
    sqlx::query(
        "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'admin'
         WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(u.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .bind(now)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        "system",
        "user",
        u.id,
        "user_disable",
        Some(u.id),
        &serde_json::json!({ "os_user": invitation::os_user() }),
        now,
    )
    .await?;
    tx.commit().await?;
    writeln!(out, "user {} disabled (grants and sessions revoked)", u.id)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tokens

#[allow(clippy::too_many_arguments)] // mirrors the CLI flags
async fn token_issue(
    pool: &SqlitePool,
    auth: &ResolvedAuth,
    kind: TokenKind,
    note: Option<&str>,
    user: Option<&str>,
    ttl: Option<&str>,
    yes: bool,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let now = session::now_ms();
    let ttl_ms = match kind {
        TokenKind::Setup => ttl
            .and_then(parse_ttl)
            .unwrap_or(auth.invitation.setup_ttl_hours * 3_600_000),
        TokenKind::Invite => anyhow::bail!("invite tokens are issued from the web UI"),
        // validate_args bails first; kept symmetric to the invite arm.
        TokenKind::Register => anyhow::bail!("register tokens are issued from the web UI"),
        TokenKind::Recovery => {
            let max = auth.invitation.recovery_ttl_max_hours * 3_600_000;
            let ttl = ttl
                .and_then(parse_ttl)
                .unwrap_or(auth.invitation.recovery_ttl_hours * 3_600_000);
            if ttl > max {
                anyhow::bail!(
                    "recovery --ttl is capped at {}h",
                    auth.invitation.recovery_ttl_max_hours
                );
            }
            ttl
        }
    };
    let mut target: Option<UserSummary> = None;
    let operator_note = note
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if kind == TokenKind::Recovery {
        let u = resolve_user(pool, user.expect("validated")).await?;
        user_show(pool, &u, out).await?;
        if !yes {
            let name = prompt(
                prompter,
                out,
                &format!("Re-type the display name ({}) to confirm:", u.display_name),
            )?;
            if name != u.display_name {
                anyhow::bail!("display name mismatch: aborted");
            }
        }
        target = Some(u);
    }
    let token = invitation::issue(
        pool,
        &invitation::NewInvitation {
            kind: kind
                .to_invitation_kind()
                .expect("register issuance is web-only (validated)"),
            operator_note,
            target_user_id: target.as_ref().map(|u| u.id),
            created_by: None,
            ledger_id: None,
            role: None,
            inviter_note: None,
            ttl_ms,
        },
        now,
    )
    .await?;
    let raw: [u8; 32] = crate::auth::tokens::b64url_decode(&token)
        .and_then(|b| b.try_into().ok())
        .expect("issued token round-trips");
    let hash_prefix = to_hex(&crate::auth::tokens::sha256(&raw))[..8].to_string();
    let mut conn = pool.acquire().await?;
    audit(
        &mut conn,
        "system",
        "invitation",
        0,
        "token_issue",
        target.as_ref().map(|u| u.id),
        &serde_json::json!({
            "os_user": invitation::os_user(),
            "kind": kind.to_invitation_kind().expect("register issuance is web-only (validated)").as_str(),
            "ttl_ms": ttl_ms,
            "target_user_id": target.as_ref().map(|u| u.id),
            "token_hash_prefix": hash_prefix,
        }),
        now,
    )
    .await?;
    let expires = ms_to_jst(now + ttl_ms);
    writeln!(out, "token issued (expires {expires}).")?;
    writeln!(out, "URL (shown once, pass it along out-of-band):")?;
    writeln!(out, "{}/register?token={token}", auth.public_origin)?;
    Ok(())
}

async fn token_list(
    pool: &SqlitePool,
    kind: Option<TokenKind>,
    user: Option<i64>,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    // Register rows join only when unfiltered or explicitly requested;
    // --user narrows recovery targets (an invitations-only concept).
    let register_rows = match (kind, user) {
        (Some(TokenKind::Register), _) | (None, None) => register_invitation::list(pool).await?,
        _ => Vec::new(),
    };
    // --kind register shows the register_invitations table only
    let rows = match kind {
        Some(TokenKind::Register) => Vec::new(),
        _ => invitation::list(pool, kind.and_then(|k| k.to_invitation_kind()), user).await?,
    };
    // merged view, newest first (both tables share the created_at clock)
    let mut merged: Vec<(i64, String)> = Vec::with_capacity(rows.len() + register_rows.len());
    for r in &rows {
        merged.push((
            r.created_at,
            format!(
                "{prefix} {kind} target_user={target} created={created} expires={expires} used={used} note={note}",
                prefix = &to_hex(&r.token_hash)[..8],
                kind = r.kind.as_str(),
                target = r
                    .target_user_id
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "-".into()),
                created = ms_to_jst(r.created_at),
                expires = ms_to_jst(r.expires_at),
                used = r.used_at.map(ms_to_jst).unwrap_or_else(|| "unused".into()),
                note = r.operator_note.as_deref().unwrap_or("-"),
            ),
        ));
    }
    for r in &register_rows {
        // register rows show the web issuer and mark the note as the
        // inviter's (not an operator note, spec_auth.md 7-2)
        merged.push((
            r.created_at,
            format!(
                "{prefix} register issued_by={issuer} created={created} expires={expires} used={used} note=inviter: {note}",
                prefix = &to_hex(&r.token_hash)[..8],
                issuer = r.created_by,
                created = ms_to_jst(r.created_at),
                expires = ms_to_jst(r.expires_at),
                used = r.used_at.map(ms_to_jst).unwrap_or_else(|| "unused".into()),
                note = r.inviter_note,
            ),
        ));
    }
    merged.sort_by_key(|(created_at, _)| std::cmp::Reverse(*created_at));
    for (_, line) in &merged {
        writeln!(out, "{line}")?;
    }
    writeln!(out, "{} token(s)", merged.len())?;
    Ok(())
}

async fn token_revoke(
    pool: &SqlitePool,
    token_id: &str,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let now = session::now_ms();
    // resolve the prefix across both tables (register_invitations joined in
    // TASK-32); one hit in each table is ambiguous as well. The resolved
    // hash is passed straight into the delete, so the row is identified by
    // the hash alone (no second prefix SELECT between resolve and delete).
    let upper = token_id.trim().to_ascii_uppercase();
    if upper.len() < 8 || !upper.bytes().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!("token id must be a hex prefix of at least 8 characters");
    }
    let inv = invitation::hashes_by_prefix(pool, &upper).await?;
    let reg = register_invitation::hashes_by_prefix(pool, &upper).await?;
    let hash = match (inv.as_slice(), reg.as_slice()) {
        ([h], []) => {
            invitation::revoke_by_hash(pool, h, now).await?;
            h.clone()
        }
        ([], [h]) => {
            register_invitation::revoke_by_hash(pool, h, now).await?;
            h.clone()
        }
        ([], []) => anyhow::bail!("no token matches prefix {token_id:?}"),
        (i, r) => anyhow::bail!(
            "prefix {token_id:?} matches {} tokens; use more characters",
            i.len() + r.len()
        ),
    };
    writeln!(out, "deleted token {}", &to_hex(&hash)[..8])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// passkeys

async fn passkey_list(
    pool: &SqlitePool,
    u: &UserSummary,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let rows: Vec<PasskeyCols> = sqlx::query_as(
        "SELECT id, label, created_at, last_used_at, passkey_json
         FROM webauthn_credentials WHERE user_id = ? ORDER BY id",
    )
    .bind(u.id)
    .fetch_all(pool)
    .await?;
    writeln!(out, "user {} {} {}", u.id, u.account_number, u.display_name)?;
    for (pid, label, created, last_used, json) in &rows {
        writeln!(
            out,
            "  passkey #{pid} \"{}\" created={} last_used={} backup={}",
            label.as_deref().unwrap_or("-"),
            ms_to_jst(*created),
            last_used.map(ms_to_jst).as_deref().unwrap_or("-"),
            backup_flag(json),
        )?;
    }
    writeln!(out, "{} passkey(s)", rows.len())?;
    Ok(())
}

async fn passkey_revoke(
    pool: &SqlitePool,
    u: &UserSummary,
    passkey_id: Option<i64>,
    all: bool,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    if !all && passkey_id.is_none() {
        anyhow::bail!("specify a passkey id or --all");
    }
    passkey_list(pool, u, out).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(u.id)
            .fetch_one(pool)
            .await?;
    let targets: Vec<i64> = if all {
        sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
            .bind(u.id)
            .fetch_all(pool)
            .await?
    } else {
        let pid = passkey_id.expect("checked");
        let owner: Option<i64> =
            sqlx::query_scalar("SELECT user_id FROM webauthn_credentials WHERE id = ?")
                .bind(pid)
                .fetch_optional(pool)
                .await?;
        if owner != Some(u.id) {
            anyhow::bail!("passkey {pid} does not belong to user {}", u.id);
        }
        vec![pid]
    };
    if targets.is_empty() {
        anyhow::bail!("no passkeys to revoke");
    }
    let name = prompt(
        prompter,
        out,
        &format!("Re-type the display name ({}) to confirm:", u.display_name),
    )?;
    if name != u.display_name {
        anyhow::bail!("display name mismatch: aborted");
    }
    let lock_out = all || count <= 1;
    if lock_out {
        writeln!(
            out,
            "WARNING: after this, user {} ({}) will have no passkey and cannot log in.",
            u.account_number, u.display_name
        )?;
        let acc = prompt(
            prompter,
            out,
            &format!("Re-type the account number ({}):", u.account_number),
        )?;
        if normalize_account_number(&acc) != normalize_account_number(&u.account_number) {
            anyhow::bail!("account number mismatch: aborted");
        }
    }
    let now = session::now_ms();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    for pid in &targets {
        let n = sqlx::query("DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?")
            .bind(pid)
            .bind(u.id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if n != 1 {
            anyhow::bail!("passkey {pid} vanished");
        }
        audit(
            &mut tx,
            "system",
            "webauthn_credential",
            *pid,
            "passkey_revoke",
            Some(u.id),
            &serde_json::json!({ "os_user": invitation::os_user() }),
            now,
        )
        .await?;
    }
    tx.commit().await?;
    writeln!(out, "revoked {} passkey(s) of user {}", targets.len(), u.id)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// OAuth grants (spec_auth.md section 9)

/// oauth_grants list columns: (id, client_id, scope, active_ledger_id, last_used_at, created_at).
type GrantListRow = (i64, String, String, Option<i64>, Option<i64>, i64);

async fn grant_list(pool: &SqlitePool, u: &UserSummary, out: &mut dyn Write) -> anyhow::Result<()> {
    let now = session::now_ms();
    let rows: Vec<GrantListRow> = sqlx::query_as(
        "SELECT g.id, g.client_id, g.scope, g.active_ledger_id, g.last_used_at, g.created_at
         FROM oauth_grants g WHERE g.user_id = ?
           AND g.revoked_at IS NULL AND g.absolute_expires_at > ? ORDER BY g.id",
    )
    .bind(u.id)
    .bind(now)
    .fetch_all(pool)
    .await?;
    writeln!(out, "user {} {} {}", u.id, u.account_number, u.display_name)?;
    for (gid, client_id, scope, active, last_used, created) in &rows {
        let ledger = match active {
            Some(lid) => {
                let name: Option<String> =
                    sqlx::query_scalar("SELECT name FROM ledgers WHERE id = ?")
                        .bind(lid)
                        .fetch_optional(pool)
                        .await?;
                name.unwrap_or_else(|| format!("(id={lid}, not a member)"))
            }
            None => "-".to_string(),
        };
        writeln!(
            out,
            "  grant {gid} client={client_id} scope={scope} active_ledger={ledger} \
             created={} last_used={}",
            ms_to_jst(*created),
            last_used.map(ms_to_jst).as_deref().unwrap_or("-"),
        )?;
    }
    writeln!(out, "{} active grant(s)", rows.len())?;
    Ok(())
}

/// Resolve `--all-of <user>` / `<grant_id>`; confirm by display-name
/// re-entry (spec_auth.md section 9).
async fn grant_revoke(
    pool: &SqlitePool,
    grant_id: Option<i64>,
    all_of: Option<&str>,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    if grant_id.is_none() && all_of.is_none() {
        anyhow::bail!("specify a grant id or --all-of <user>");
    }
    let targets: Vec<(i64, i64, String)> = if let Some(user) = all_of {
        let u = resolve_user(pool, user).await?;
        sqlx::query_as(
            "SELECT id, user_id, client_id FROM oauth_grants
             WHERE user_id = ? AND revoked_at IS NULL ORDER BY id",
        )
        .bind(u.id)
        .fetch_all(pool)
        .await?
    } else {
        let gid = grant_id.expect("checked");
        let row: Option<(i64, i64, String)> = sqlx::query_as(
            "SELECT id, user_id, client_id FROM oauth_grants WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(gid)
        .fetch_optional(pool)
        .await?;
        row.map(|r| vec![r]).unwrap_or_default()
    };
    if targets.is_empty() {
        anyhow::bail!("no matching active grant");
    }
    for (gid, uid, client) in &targets {
        writeln!(out, "grant {gid} of user {uid} client={client}")?;
    }
    let first_user = resolve_user(pool, &targets[0].1.to_string()).await?;
    let name = prompt(
        prompter,
        out,
        &format!(
            "Re-type the display name ({}) to confirm:",
            first_user.display_name
        ),
    )?;
    if name != first_user.display_name {
        anyhow::bail!("display name mismatch: aborted");
    }
    let now = session::now_ms();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    for (gid, uid, _) in &targets {
        let n = sqlx::query(
            "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'admin'
             WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(gid)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 1 {
            audit(
                &mut tx,
                "system",
                "oauth_grant",
                *gid,
                "grant_revoke",
                Some(*uid),
                &serde_json::json!({ "os_user": invitation::os_user() }),
                now,
            )
            .await?;
        }
    }
    tx.commit().await?;
    writeln!(out, "revoked {} grant(s)", targets.len())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// concurrent refresh families (TASK-155)

/// `concurrent_families` grant aggregate: one row per grant holding >= 2 tips.
#[derive(Debug, sqlx::FromRow)]
struct ConcurrentFamilyRow {
    id: i64,
    user_id: i64,
    account_number: String,
    display_name: String,
    client_id: String,
    revoked_at: Option<i64>,
    absolute_expires_at: i64,
    tips: i64,
}

/// One tip row of a listed family: the tip's own hash, the referencing
/// parent's hash (`child_hash` reverse lookup; `parent_hash` is always NULL),
/// and its created/expires timestamps.
type ConcurrentTipRow = (Vec<u8>, Option<Vec<u8>>, i64, i64);

/// `admin grant concurrent-families [--user U]`: read-only inquiry for grants
/// whose refresh token family still holds two or more concurrent tips — the
/// residue the pre-TASK-140 grace-period re-presentation could leave behind
/// and migration 0012 cannot revoke (both branches are referenced by another
/// row's `child_hash`, so neither is an orphan).
///
/// A tip follows the 0012 definition: `used_at IS NULL AND revoked_at IS NULL`
/// and referenced by some row's `child_hash`. Expired tips count (their
/// evidence rows survive until the sweep) and dead grants are listed with
/// their state rather than filtered out, so the output stays a stable
/// observation. Every SELECT runs inside one `BEGIN DEFERRED` read
/// transaction: header counts, tip details and grant state must come from a
/// single snapshot, not from pool reads a rotation or sweep can interleave
/// with. No audit and no prompt — like the other list commands.
///
/// Observation limit: a zero count does not prove no concurrency ever
/// existed. Refresh rows expire 30 days after issue without extension, so
/// once only the referencing parent rows are swept, surviving tips lose
/// their reference and the family falls below detection.
async fn concurrent_families(
    pool: &SqlitePool,
    user: Option<i64>,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN DEFERRED").await?;
    // `? IS NULL OR g.user_id = ?` folds the optional --user filter into one
    // static statement (sqlx 0.9 only takes static SQL): a NULL bind (no
    // --user) keeps the scan user-wide.
    let families: Vec<ConcurrentFamilyRow> = sqlx::query_as(
        "SELECT g.id, g.user_id, u.account_number, u.display_name, g.client_id,
                g.revoked_at, g.absolute_expires_at, COUNT(*) AS tips
         FROM oauth_refresh_tokens r
         JOIN oauth_grants g ON g.id = r.grant_id
         JOIN users u       ON u.id = g.user_id
         WHERE r.used_at IS NULL AND r.revoked_at IS NULL
           AND r.token_hash IN (SELECT child_hash FROM oauth_refresh_tokens
                                WHERE child_hash IS NOT NULL)
           AND (? IS NULL OR g.user_id = ?)
         GROUP BY r.grant_id
         HAVING COUNT(*) >= 2
         ORDER BY g.id",
    )
    .bind(user)
    .bind(user)
    .fetch_all(&mut *tx)
    .await?;
    let mut total_tips = 0;
    for f in &families {
        // token_hash tiebreak: same-ms insertions must order stably
        let tips: Vec<ConcurrentTipRow> = sqlx::query_as(
            "SELECT r.token_hash, p.token_hash AS parent_token_hash,
                    r.created_at, r.expires_at
             FROM oauth_refresh_tokens r
             LEFT JOIN oauth_refresh_tokens p ON p.child_hash = r.token_hash
             WHERE r.grant_id = ? AND r.used_at IS NULL AND r.revoked_at IS NULL
               AND r.token_hash IN (SELECT child_hash FROM oauth_refresh_tokens
                                    WHERE child_hash IS NOT NULL)
             ORDER BY r.created_at, r.token_hash",
        )
        .bind(f.id)
        .fetch_all(&mut *tx)
        .await?;
        writeln!(
            out,
            "grant {} user {} {} {} client={} grant_revoked={} grant_expires={} tips={}",
            f.id,
            f.user_id,
            f.account_number,
            f.display_name,
            f.client_id,
            f.revoked_at.map(ms_to_jst).as_deref().unwrap_or("-"),
            ms_to_jst(f.absolute_expires_at),
            f.tips,
        )?;
        for (hash, parent, created, expires) in &tips {
            writeln!(
                out,
                "  tip {} parent={} created={} expires={}",
                &to_hex(hash)[..8],
                parent
                    .as_ref()
                    .map(|p| to_hex(p)[..8].to_string())
                    .unwrap_or_else(|| "-".into()),
                ms_to_jst(*created),
                ms_to_jst(*expires),
            )?;
        }
        total_tips += f.tips;
    }
    tx.commit().await?;
    writeln!(
        out,
        "{fam} concurrent family(ies), {total_tips} tip(s)",
        fam = families.len()
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// web sessions (spec_auth.md section 9)

async fn session_list(
    pool: &SqlitePool,
    u: &UserSummary,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let now = session::now_ms();
    let rows: Vec<SessionListRow> = sqlx::query_as(
        "SELECT id_hash, created_at, last_seen_at, user_agent FROM web_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND absolute_expires_at > ? ORDER BY created_at",
    )
    .bind(u.id)
    .bind(now)
    .fetch_all(pool)
    .await?;
    writeln!(out, "user {} {} {}", u.id, u.account_number, u.display_name)?;
    for (hash, created, last_seen, ua) in &rows {
        writeln!(
            out,
            "  session {} created={} last_seen={} ua={}",
            &to_hex(hash)[..8],
            ms_to_jst(*created),
            last_seen.map(ms_to_jst).as_deref().unwrap_or("-"),
            ua.as_deref()
                .map(|s| s.chars().take(40).collect::<String>())
                .unwrap_or_else(|| "-".into()),
        )?;
    }
    writeln!(out, "{} active session(s)", rows.len())?;
    Ok(())
}

async fn session_revoke(
    pool: &SqlitePool,
    session_id: Option<&str>,
    all_of: Option<&str>,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    if session_id.is_none() && all_of.is_none() {
        anyhow::bail!("specify a session hash prefix or --all-of <user>");
    }
    let user = match all_of {
        Some(user) => resolve_user(pool, user).await?,
        None => {
            // find the session owner by hash prefix
            let prefix = session_id.expect("checked");
            let rows: Vec<(Vec<u8>, i64)> = sqlx::query_as(
                "SELECT id_hash, user_id FROM web_sessions WHERE revoked_at IS NULL",
            )
            .fetch_all(pool)
            .await?;
            let matches: Vec<i64> = rows
                .iter()
                .filter(|(hash, _)| to_hex(hash).starts_with(prefix.to_ascii_lowercase().as_str()))
                .map(|(_, uid)| *uid)
                .collect();
            match matches.len() {
                0 => anyhow::bail!("no session matches prefix {prefix:?}"),
                1 => resolve_user(pool, &matches[0].to_string()).await?,
                n => anyhow::bail!("prefix {prefix:?} matches {n} sessions; use more characters"),
            }
        }
    };
    let name = prompt(
        prompter,
        out,
        &format!(
            "Re-type the display name ({}) to confirm:",
            user.display_name
        ),
    )?;
    if name != user.display_name {
        anyhow::bail!("display name mismatch: aborted");
    }
    let now = session::now_ms();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = if let Some(prefix) = session_id {
        let rows: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT id_hash FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
        )
        .bind(user.id)
        .fetch_all(&mut *tx)
        .await?;
        let mut count = 0u64;
        for hash in rows {
            if to_hex(&hash).starts_with(prefix.to_ascii_lowercase().as_str()) {
                count += sqlx::query(
                    "UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
                )
                .bind(now)
                .bind(&hash)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            }
        }
        count
    } else {
        sqlx::query(
            "UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    audit(
        &mut tx,
        "system",
        "user",
        user.id,
        "session_revoke",
        Some(user.id),
        &serde_json::json!({ "os_user": invitation::os_user(), "count": n }),
        now,
    )
    .await?;
    tx.commit().await?;
    writeln!(out, "revoked {n} session(s) of user {}", user.id)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// recovery requests (spec_auth.md sections 8, 9)

/// web_sessions list columns: (id_hash, created_at, last_seen_at, user_agent).
type SessionListRow = (Vec<u8>, i64, Option<i64>, Option<String>);

/// recovery_requests row with candidate users.
struct RecoveryRow {
    id: i64,
    request_number: String,
    status: String,
    subject_hash: Option<Vec<u8>>,
    ip_hash: Option<Vec<u8>>,
    note: Option<String>,
    created_at: i64,
    closed_at: Option<i64>,
    close_note: Option<String>,
}

/// recovery_requests columns in fetch order.
type RecoveryRowRaw = (
    i64,
    String,
    String,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
    Option<String>,
    i64,
    Option<i64>,
    Option<String>,
);

async fn fetch_recovery(
    pool: &SqlitePool,
    request_number: &str,
) -> anyhow::Result<Option<RecoveryRow>> {
    let row: Option<RecoveryRowRaw> =
        sqlx::query_as(
            "SELECT id, request_number, status, subject_hash, ip_hash, note, created_at, closed_at, close_note
             FROM recovery_requests WHERE request_number = ?",
        )
        .bind(request_number)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(
        |(
            id,
            request_number,
            status,
            subject_hash,
            ip_hash,
            note,
            created_at,
            closed_at,
            close_note,
        )| RecoveryRow {
            id,
            request_number,
            status,
            subject_hash,
            ip_hash,
            note,
            created_at,
            closed_at,
            close_note,
        },
    ))
}

/// Candidate users with the evidence source (spec_auth.md section 8-1).
async fn recovery_candidates(
    pool: &SqlitePool,
    request_id: i64,
) -> anyhow::Result<Vec<(i64, String, String, Option<String>, String)>> {
    Ok(sqlx::query_as(
        "SELECT u.id, u.account_number, u.display_name, u.admin_note, c.source
         FROM recovery_request_candidates c JOIN users u ON u.id = c.user_id
         WHERE c.request_id = ? ORDER BY u.id, c.source",
    )
    .bind(request_id)
    .fetch_all(pool)
    .await?)
}

async fn recovery_list(
    pool: &SqlitePool,
    status: Option<&str>,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    // overall-limit overflows first (spec_auth.md 8-2)
    let today = jst_today();
    let overflow: Option<i64> =
        sqlx::query_scalar("SELECT count FROM recovery_overflow_daily WHERE day = ?")
            .bind(&today)
            .fetch_optional(pool)
            .await?;
    if let Some(n) = overflow {
        writeln!(out, "overflow today ({today}): {n} request(s) not accepted")?;
    }
    let rows: Vec<(i64, String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, request_number, status, created_at, closed_at FROM recovery_requests
         ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    let mut shown = 0;
    for (id, number, st, created, closed) in rows {
        if let Some(want) = status
            && st != want
        {
            continue;
        }
        let candidates = recovery_candidates(pool, id).await?;
        writeln!(
            out,
            "{number} [{st}] created={} closed={} candidates={}",
            ms_to_jst(created),
            closed.map(ms_to_jst).as_deref().unwrap_or("-"),
            candidates
                .iter()
                .map(|(uid, _, _, _, source)| format!("{uid}:{source}"))
                .collect::<Vec<_>>()
                .join(","),
        )?;
        shown += 1;
    }
    writeln!(out, "{shown} request(s)")?;
    Ok(())
}

/// JST calendar day `YYYY-MM-DD` for the overflow counter.
fn jst_today() -> String {
    let secs = session::now_ms().div_euclid(1000) + 9 * 3600;
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}")
}

async fn recovery_show(
    pool: &SqlitePool,
    request_number: &str,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let Some(row) = fetch_recovery(pool, request_number).await? else {
        anyhow::bail!("no recovery request {request_number:?}");
    };
    writeln!(
        out,
        "{} [{}] created={} closed={} close_note={}",
        row.request_number,
        row.status,
        ms_to_jst(row.created_at),
        row.closed_at.map(ms_to_jst).as_deref().unwrap_or("-"),
        row.close_note.as_deref().unwrap_or("-"),
    )?;
    writeln!(out, "  note: {}", row.note.as_deref().unwrap_or("-"),)?;
    writeln!(
        out,
        "  subject_hash: {}",
        row.subject_hash
            .as_ref()
            .map(|h| to_hex(h)[..8].to_string())
            .unwrap_or_else(|| "-".into()),
    )?;
    writeln!(
        out,
        "  ip_hash: {}",
        row.ip_hash
            .as_ref()
            .map(|h| to_hex(h)[..8].to_string())
            .unwrap_or_else(|| "-".into()),
    )?;
    for (uid, account, display, admin_note, source) in recovery_candidates(pool, row.id).await? {
        writeln!(
            out,
            "  candidate user {uid} {account} {display} note={} evidence={source}",
            admin_note.as_deref().unwrap_or("-"),
        )?;
    }
    Ok(())
}

async fn recovery_resolve(
    pool: &SqlitePool,
    auth: &ResolvedAuth,
    request_number: &str,
    user_arg: &str,
    yes: bool,
    prompter: &mut dyn Prompter,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let Some(row) = fetch_recovery(pool, request_number).await? else {
        anyhow::bail!("no recovery request {request_number:?}");
    };
    if row.status != "open" {
        anyhow::bail!("request {request_number} is already {}", row.status);
    }
    let user = resolve_user(pool, user_arg).await?;
    user_show(pool, &user, out).await?;
    let candidates = recovery_candidates(pool, row.id).await?;
    let is_candidate = candidates.iter().any(|(uid, ..)| *uid == user.id);
    let mut extra_note = serde_json::Value::Null;
    if !is_candidate {
        writeln!(
            out,
            "WARNING: user {} is not a candidate of this request.",
            user.display_name
        )?;
        let reason = prompt(
            prompter,
            out,
            "Reason for issuing to a non-candidate user (recorded in audit):",
        )?;
        if reason.trim().is_empty() {
            anyhow::bail!("a reason is required for non-candidate issuance");
        }
        extra_note = serde_json::json!({ "non_candidate_reason": reason.trim() });
    }
    if !yes {
        let name = prompt(
            prompter,
            out,
            &format!(
                "Re-type the display name ({}) to confirm:",
                user.display_name
            ),
        )?;
        if name != user.display_name {
            anyhow::bail!("display name mismatch: aborted");
        }
    }
    // same processing as `token issue --kind recovery` (spec_auth.md section 9)
    let now = session::now_ms();
    let ttl_ms = auth.invitation.recovery_ttl_hours * 3_600_000;
    let token = invitation::issue(
        pool,
        &invitation::NewInvitation {
            kind: InvitationKind::Recovery,
            operator_note: None,
            target_user_id: Some(user.id),
            created_by: None,
            ledger_id: None,
            role: None,
            inviter_note: None,
            ttl_ms,
        },
        now,
    )
    .await?;
    let raw: [u8; 32] = crate::auth::tokens::b64url_decode(&token)
        .and_then(|b| b.try_into().ok())
        .expect("issued token round-trips");
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query(
        "UPDATE recovery_requests SET status = 'resolved', closed_at = ?, close_note = ?
         WHERE id = ? AND status = 'open'",
    )
    .bind(now)
    .bind(format!("resolved by CLI for user {}", user.id))
    .bind(row.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n != 1 {
        anyhow::bail!("request {request_number} is no longer open");
    }
    audit(
        &mut tx,
        "system",
        "recovery_request",
        row.id,
        "recovery_resolve",
        Some(user.id),
        &serde_json::json!({
            "os_user": invitation::os_user(),
            "request_number": row.request_number,
            "non_candidate": !is_candidate,
            "extra": extra_note,
            "token_hash_prefix": to_hex(&crate::auth::tokens::sha256(&raw))[..8].to_string(),
        }),
        now,
    )
    .await?;
    tx.commit().await?;
    writeln!(out, "resolved {request_number}; recovery URL (shown once):")?;
    writeln!(out, "{}/register?token={token}", auth.public_origin)?;
    Ok(())
}

async fn recovery_reject(
    pool: &SqlitePool,
    request_number: &str,
    reason: Option<&str>,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let Some(row) = fetch_recovery(pool, request_number).await? else {
        anyhow::bail!("no recovery request {request_number:?}");
    };
    if row.status != "open" {
        anyhow::bail!("request {request_number} is already {}", row.status);
    }
    let now = session::now_ms();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query(
        "UPDATE recovery_requests SET status = 'rejected', closed_at = ?, close_note = ?
         WHERE id = ? AND status = 'open'",
    )
    .bind(now)
    .bind(reason.unwrap_or("rejected by operator"))
    .bind(row.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n != 1 {
        anyhow::bail!("request {request_number} is no longer open");
    }
    audit(
        &mut tx,
        "system",
        "recovery_request",
        row.id,
        "recovery_reject",
        None,
        &serde_json::json!({ "os_user": invitation::os_user(), "reason": reason }),
        now,
    )
    .await?;
    tx.commit().await?;
    writeln!(out, "rejected {request_number}")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// time formatting (JST = UTC+9, no DST)

/// unix ms -> `YYYY-MM-DD HH:MM:SS` in JST.
pub fn ms_to_jst(ms: i64) -> String {
    let secs = ms.div_euclid(1000) + 9 * 3600;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

// ---------------------------------------------------------------------------
// tests

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:auth-invitation.recovery-ttl-bounds]
    #[test]
    fn ttl_parsing() {
        assert_eq!(parse_ttl("45s"), Some(45_000));
        assert_eq!(parse_ttl("90m"), Some(5_400_000));
        assert_eq!(parse_ttl("24h"), Some(86_400_000));
        assert_eq!(parse_ttl("2d"), Some(172_800_000));
        assert_eq!(parse_ttl("abc"), None);
        assert_eq!(parse_ttl("h"), None);
        assert_eq!(parse_ttl("-1h"), None);
        assert_eq!(parse_ttl("1x"), None);
        assert_eq!(parse_ttl("0h"), None);
    }

    // [covers:auth-invitation.setup-note-required]
    #[test]
    fn setup_token_requires_note() {
        let cli = cli_from(&["token", "issue", "--kind", "setup"]);
        assert!(validate_args(&cli).is_err());
        let cli = cli_from(&["token", "issue", "--kind", "setup", "--note", "for wife"]);
        assert!(validate_args(&cli).is_ok());
    }

    #[test]
    fn recovery_requires_user_and_valid_ttl() {
        let cli = cli_from(&["token", "issue", "--kind", "recovery"]);
        assert!(validate_args(&cli).is_err());
        let cli = cli_from(&["token", "issue", "--kind", "recovery", "--user", "3"]);
        assert!(validate_args(&cli).is_ok());
        let cli = cli_from(&[
            "token", "issue", "--kind", "recovery", "--user", "3", "--ttl", "25h",
        ]);
        assert!(validate_args(&cli).is_ok()); // bound checked at issue time
        let cli = cli_from(&[
            "token", "issue", "--kind", "recovery", "--user", "3", "--ttl", "bogus",
        ]);
        assert!(validate_args(&cli).is_err());
    }

    #[test]
    fn invite_not_issuable_from_cli() {
        let cli = cli_from(&["token", "issue", "--kind", "invite"]);
        assert!(validate_args(&cli).is_err());
    }

    fn cli_from(args: &[&str]) -> Cli {
        Cli::try_parse_from(
            std::iter::once("budget-book-admin".to_string())
                .chain(args.iter().map(|s| s.to_string())),
        )
        .expect("parse")
    }

    #[test]
    fn jst_formatting() {
        assert_eq!(ms_to_jst(0), "1970-01-01 09:00:00");
        // 2026-10-13 00:00:00 UTC = 2026-10-13 09:00:00 JST
        assert_eq!(ms_to_jst(1_791_849_600_000), "2026-10-13 09:00:00");
        // 2024-02-29 12:00:00 UTC = 2024-02-29 21:00:00 JST
        assert_eq!(ms_to_jst(1_709_208_000_000), "2024-02-29 21:00:00");
    }
}
