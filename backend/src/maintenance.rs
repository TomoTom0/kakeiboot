//! The TTL sweep runner (spec_data-model.md section 12): `cleanup_expired`
//! once at startup and then on the configured interval, until cancelled.

use std::path::PathBuf;

use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use crate::store;

/// JST `YYYY-MM-DD` of `now - days` (for the recovery_overflow_daily cutoff).
fn jst_date_days_ago(now: i64, days: i64) -> String {
    let secs = (now - days * 86_400_000).div_euclid(1000) + 9 * 3600;
    let days_since_epoch = secs.div_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days_since_epoch + 719_468;
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

/// Run the sweep loop; returns when `ct` fires. Image files below `image_root`
/// are deleted before their rows (spec_data-model.md section 12).
pub async fn run_cleanup_loop(
    pool: SqlitePool,
    image_root: PathBuf,
    interval_secs: u64,
    ct: CancellationToken,
) {
    let interval = std::time::Duration::from_secs(interval_secs.max(1));
    loop {
        let now = crate::auth::session::now_ms();
        let cutoff = jst_date_days_ago(now, 90);
        let root = image_root.clone();
        let result = store::cleanup_expired(&pool, now, &cutoff, move |path| {
            let full = root.join(path);
            match std::fs::remove_file(&full) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        })
        .await;
        match result {
            Ok(report) => tracing::debug!(?report, "cleanup sweep finished"),
            Err(e) => tracing::warn!(error = %e, "cleanup sweep failed"),
        }
        tokio::select! {
            () = ct.cancelled() => break,
            _ = tokio::time::sleep(interval) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:auth-cleanup.jst-cutoff-date]
    #[test]
    fn jst_cutoff_format() {
        // 2026-10-13 00:00:00 UTC = 2026-10-13 09:00:00 JST; 90 days earlier
        assert_eq!(jst_date_days_ago(1_791_849_600_000, 90), "2026-07-15");
        // unix epoch minus 90 days in JST
        assert_eq!(jst_date_days_ago(0, 90), "1969-10-03");
        // crossing a leap boundary: 2024-03-01 JST is 2024-02-29 UTC -1d
        assert_eq!(jst_date_days_ago(1_709_208_000_000, 1), "2024-02-28");
    }
}
