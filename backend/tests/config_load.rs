mod common;

use budget_book::config::Config;

#[test]
fn repo_app_toml_loads_and_validates() {
    let cfg = common::repo_config();
    assert!(cfg.app.mcp.path.starts_with('/'));
    assert!(!cfg.app.mcp.allowed_hosts.is_empty());
    assert!(cfg.database_path().is_absolute());
}

#[test]
fn repo_port_is_fixed_assignment() {
    // configs/dev/app.toml carries the user-approved fixed port (40280-40284 range).
    let cfg = common::repo_config();
    assert_eq!(cfg.app.server.port, 40280);
}

#[test]
fn explicit_dir_wins_over_default() {
    let dir = common::repo_config_dir();
    assert_eq!(Config::resolve_dir(Some(dir.clone())), dir);
}

#[tokio::test]
async fn server_binds_os_assigned_port_when_port_is_zero() {
    let (addr, _cfg, ct) = common::spawn_app().await;
    assert_ne!(addr.port(), 0);
    ct.cancel();
}

// ---------------------------------------------------------------------------
// TASK-18: batch tool settings (mcp.toml [limits] / [image])

/// Every configs/<env>/mcp.toml in the repo as (env, text).
fn env_mcp_tomls() -> Vec<(String, String)> {
    let configs = common::repo_config_dir().parent().unwrap().to_path_buf();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&configs).unwrap() {
        let path = entry.unwrap().path();
        let file = path.join("mcp.toml");
        if path.is_dir() && file.exists() {
            out.push((
                path.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read_to_string(&file).unwrap(),
            ));
        }
    }
    out
}

/// Rewrite `text` so each extra `key = value` line is assigned exactly once,
/// right after its table header. Existing assignments of the same key are
/// dropped first, so the helper stays usable on config files that already
/// carry the keys (TOML forbids duplicate keys).
fn with_table_keys(text: &str, limits: &[&str], image: &[&str]) -> String {
    let extras_of = |table: &str| -> &[&str] {
        match table {
            "[limits]" => limits,
            "[image]" => image,
            _ => &[],
        }
    };
    let mut out = String::new();
    let mut table = "";
    let mut inserted = std::collections::HashSet::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            table = trimmed;
        }
        let extras = extras_of(table);
        let extra_keys: Vec<&str> = extras
            .iter()
            .map(|e| e.split('=').next().unwrap_or("").trim())
            .collect();
        // a line the extras supersede is replaced by the inserted copy
        if let Some((key, _)) = trimmed.split_once('=')
            && extra_keys.contains(&key.trim())
        {
            continue;
        }
        out.push_str(line);
        out.push('\n');
        if trimmed.starts_with('[') && !inserted.contains(table) {
            for key in extras {
                out.push_str(key);
                out.push('\n');
            }
            inserted.insert(table);
        }
    }
    out
}

// [covers:mcp-config.batch-keys]
#[test]
fn mcp_toml_batch_keys_and_startup_validation() {
    // 1. every environment config carries the batch keys with the initial
    //    values of the design (10/20/3/2/1/40)
    let tomls = env_mcp_tomls();
    assert!(!tomls.is_empty());
    for (env, text) in &tomls {
        let v: toml::Value = toml::from_str(text).unwrap();
        let get = |path: &[&str]| -> i64 {
            let mut cur = &v;
            for key in path {
                cur = cur.get(key).unwrap_or_else(|| {
                    panic!("configs/{env}/mcp.toml is missing [{}]", path.join("."))
                });
            }
            cur.as_integer().unwrap_or_else(|| {
                panic!(
                    "configs/{env}/mcp.toml {} is not an integer",
                    path.join(".")
                )
            })
        };
        assert_eq!(get(&["limits", "batch_max_drafts"]), 10, "{env}");
        assert_eq!(get(&["limits", "batch_max_approve"]), 20, "{env}");
        assert_eq!(get(&["image", "batch_fetch_concurrency"]), 3, "{env}");
        assert_eq!(get(&["image", "decode_concurrency"]), 2, "{env}");
        assert_eq!(get(&["image", "batch_decode_concurrency"]), 1, "{env}");
        assert_eq!(get(&["image", "batch_fetch_deadline_secs"]), 40, "{env}");
    }

    // 2. the parse boundary: the repo file plus the new keys parses cleanly
    let dev = &tomls.iter().find(|(e, _)| e == "dev").unwrap().1;
    let valid = with_table_keys(
        dev,
        &["batch_max_drafts = 10", "batch_max_approve = 20"],
        &[
            "batch_fetch_concurrency = 3",
            "decode_concurrency = 2",
            "batch_decode_concurrency = 1",
            "batch_fetch_deadline_secs = 40",
        ],
    );
    budget_book::config::parse_mcp_tools(&valid)
        .unwrap_or_else(|e| panic!("valid batch keys must parse: {e}"));

    // 3. startup validation: batch_decode_concurrency >= decode_concurrency
    //    is rejected (the single-tool path must always keep a free slot)
    let invalid = with_table_keys(
        dev,
        &["batch_max_drafts = 10", "batch_max_approve = 20"],
        &[
            "batch_fetch_concurrency = 3",
            "decode_concurrency = 2",
            "batch_decode_concurrency = 2",
            "batch_fetch_deadline_secs = 40",
        ],
    );
    assert!(
        budget_book::config::parse_mcp_tools(&invalid).is_err(),
        "batch_decode_concurrency = decode_concurrency must be a config error"
    );
}

// ---------------------------------------------------------------------------
// TASK-32: register invitation TTL (auth.toml [auth.invitation])

/// Every configs/<env>/auth.toml in the repo as (env, text).
fn env_auth_tomls() -> Vec<(String, String)> {
    let configs = common::repo_config_dir().parent().unwrap().to_path_buf();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&configs).unwrap() {
        let path = entry.unwrap().path();
        let file = path.join("auth.toml");
        if path.is_dir() && file.exists() {
            out.push((
                path.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read_to_string(&file).unwrap(),
            ));
        }
    }
    out
}

/// The canonical valid auth.toml (mirrors the AUTH_VALID_TOML fixture in
/// src/config.rs) with the TASK-32 `register_ttl_hours` key added.
fn auth_toml_with_register_ttl(hours: i64) -> String {
    format!(
        r#"
[auth]
profile = "dev"

[auth.env.dev]
rp_id = "localhost"
rp_origin = "http://localhost:40281"
public_origin = "http://localhost:40281"
issuer = "http://localhost:40281"
resource = "http://localhost:40281/mcp"

[auth.session]
idle_days = 14
absolute_days = 30
step_up_secs = 600
last_seen_update_secs = 300

[auth.ceremony]
ttl_secs = 300

[auth.invitation]
setup_ttl_hours = 24
invite_ttl_hours = 72
recovery_ttl_hours = 1
recovery_ttl_max_hours = 24
register_ttl_hours = {hours}

[auth.rate_limit]
webauthn_per_minute = 20
token_accept_per_minute = 10
token_accept_fail_block = 10
token_accept_block_minutes = 15
authorize_per_minute = 30
token_endpoint_per_minute = 60
mcp_per_minute = 120
recovery_anonymous_per_minute = 5
trust_cf_connecting_ip = false

[auth.oauth]
default_scopes = "ledger.read ledger.write"
cimd_allowed_hosts = ["chatgpt.com"]
redirect_uri_allowlist = ["https://chatgpt.com/connector_platform_oauth_redirect"]
authz_request_ttl_secs = 600
code_ttl_secs = 60
access_token_ttl_secs = 3600
refresh_sliding_days = 30
grant_absolute_days = 90
rotation_grace_secs = 60
clock_skew_secs = 60

[auth.oauth.dev]
allow_insecure_loopback = false

[auth.recovery_request]
per_subject_hours = 24
append_per_day = 3
per_ip_per_day = 3
global_per_day = 10
anonymous_ip_per_day = 1
note_max_chars = 200
note_total_max_chars = 1000
"#
    )
}

// [covers:auth-invitation.register-ttl-config]
#[test]
fn register_ttl_hours_config() {
    // 1. every environment's auth.toml carries register_ttl_hours = 24
    //    (deny_unknown_fields: the key is mandatory once the code knows it)
    let tomls = env_auth_tomls();
    assert_eq!(tomls.len(), 3, "dev / stg / prod");
    for (env, text) in &tomls {
        let v: toml::Value = toml::from_str(text).unwrap();
        let invitation = v
            .get("auth")
            .and_then(|a| a.get("invitation"))
            .unwrap_or_else(|| panic!("configs/{env}/auth.toml is missing [auth.invitation]"));
        let hours = invitation
            .get("register_ttl_hours")
            .unwrap_or_else(|| panic!("configs/{env}/auth.toml is missing register_ttl_hours"))
            .as_integer()
            .unwrap_or_else(|| {
                panic!("configs/{env}/auth.toml register_ttl_hours is not an integer")
            });
        assert_eq!(hours, 24, "{env}");
    }

    // 2. the key is a known field and the default 24 resolves cleanly
    let file = budget_book::config::parse_auth(&auth_toml_with_register_ttl(24))
        .expect("register_ttl_hours must be a known auth.toml key");
    file.auth
        .resolve("/mcp")
        .expect("register_ttl_hours = 24 resolves");

    // 3. startup validation: register_ttl_hours = 0 is rejected
    let zero = budget_book::config::parse_auth(&auth_toml_with_register_ttl(0))
        .expect("parses; the rejection happens at resolve time");
    assert!(
        zero.auth.resolve("/mcp").is_err(),
        "register_ttl_hours = 0 must be a config error"
    );
}
