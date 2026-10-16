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
