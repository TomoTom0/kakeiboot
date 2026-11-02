//! Test-only injection points (TASK-147).
//!
//! The hooks exist only with the `test-hooks` cargo feature, which release
//! builds never enable (`mise run backend:test` / `backend:lint` turn it on).
//! Without the feature [`TestHooks`] is a zero-sized type and every pause
//! point is an empty inline function, so production code paths are
//! unchanged.
//!
//! A hook is an async callback the test installs on `AppState.test_hooks`;
//! the instrumented code awaits it at a fixed point, which lets a test park
//! one request at a deterministic position while another request runs to
//! completion (e.g. the login sign-counter race, spec_auth.md section 2-4).

#[cfg(feature = "test-hooks")]
use std::sync::Arc;

/// Async callback awaited at an injection point.
#[cfg(feature = "test-hooks")]
pub type Hook = Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>;

/// Per-application set of test hooks (all `None` by default).
#[derive(Clone, Default)]
pub struct TestHooks {
    /// `login_finish`: awaited immediately before `BEGIN IMMEDIATE` (the
    /// write lock). Before the TASK-147 fix this sits after the passkey read
    /// and verification, i.e. inside the sign-counter TOCTOU window; after
    /// the fix the read and verification move inside the transaction, so
    /// the same point lies ahead of the window.
    #[cfg(feature = "test-hooks")]
    pub login_before_write_lock: Option<Hook>,
    /// `reauth_finish`: awaited at the same structural point as the login
    /// hook — after the ceremony consumption and the assertion verification,
    /// immediately before `BEGIN IMMEDIATE` (TASK-154 step-up sign-counter
    /// freshness). The field is not awaited anywhere until the TASK-154
    /// implementation wires `reauth_finish` to it; installing it is a no-op
    /// until then, so tests park-or-run linearly either way.
    #[cfg(feature = "test-hooks")]
    pub reauth_before_write_lock: Option<Hook>,
}

impl TestHooks {
    /// Await the `login_before_write_lock` hook when installed.
    #[inline]
    pub async fn pause_login_before_write_lock(&self) {
        #[cfg(feature = "test-hooks")]
        if let Some(hook) = &self.login_before_write_lock {
            hook().await;
        }
    }

    /// Await the `reauth_before_write_lock` hook when installed.
    #[inline]
    pub async fn pause_reauth_before_write_lock(&self) {
        #[cfg(feature = "test-hooks")]
        if let Some(hook) = &self.reauth_before_write_lock {
            hook().await;
        }
    }
}
