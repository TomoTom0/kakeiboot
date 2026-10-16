use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use budget_book::{app, config::Config, db};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

fn parse_config_dir(args: &[String]) -> anyhow::Result<Option<PathBuf>> {
    let mut dir = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--config-dir" => {
                i += 1;
                let value = args.get(i).context("--config-dir requires a value")?;
                dir = Some(PathBuf::from(value));
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
        i += 1;
    }
    Ok(dir)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Operator CLI: `budget-book admin ...` (spec_auth.md section 9).
    if args.first().map(String::as_str) == Some("admin") {
        return budget_book::admin::run(args[1..].to_vec()).await;
    }

    let dir = Config::resolve_dir(parse_config_dir(&args)?);
    let cfg =
        Config::load(&dir).with_context(|| format!("loading configs from {}", dir.display()))?;

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&cfg.app.log.filter));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let pool = db::connect_file(&cfg.database_path(), &cfg.app.database).await?;
    let ct = CancellationToken::new();
    let state = app::AppState::new(&cfg, pool.clone())?;
    let router = app::router(&cfg, state, ct.child_token());
    let listeners = app::bind(&cfg).await?;
    let mut servers = Vec::with_capacity(listeners.len());
    for listener in listeners {
        app::log_bound(listener.local_addr()?, &cfg.app.mcp.path);
        let router = router.clone();
        let ct_server = ct.clone();
        servers.push(tokio::spawn(async move {
            app::serve(listener, router, ct_server).await
        }));
    }

    // TTL sweep at startup and on the configured interval
    // (spec_data-model.md section 12).
    {
        let pool = pool.clone();
        let image_root = cfg.image_root();
        let interval = cfg.app.maintenance.cleanup_interval_secs;
        let cleanup_ct = ct.child_token();
        tokio::spawn(async move {
            budget_book::maintenance::run_cleanup_loop(pool, image_root, interval, cleanup_ct).await
        });
    }

    let shutdown = ct.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutdown requested");
        shutdown.cancel();
    });

    let timeout = Duration::from_secs(cfg.app.server.shutdown_timeout_secs);
    let all = futures_util::future::join_all(servers);
    tokio::pin!(all);
    let results = tokio::select! {
        results = &mut all => results,
        _ = async { ct.cancelled().await; tokio::time::sleep(timeout).await } => {
            tracing::warn!("graceful shutdown timed out");
            return Ok(());
        }
    };
    for res in results {
        res??;
    }
    pool.close().await;
    Ok(())
}
