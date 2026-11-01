//! Tracing output capture for log assertions (request_log.rs,
//! oauth_refresh.rs).

use std::io::Write;
use std::sync::{Arc, Mutex};

/// Tracing output captured into a shared buffer (`MakeWriter` target).
#[derive(Clone, Default)]
pub struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl tracing_subscriber::fmt::MakeWriter<'_> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&self) -> Self::Writer {
        self.clone()
    }
}

/// Sets a thread-local fmt subscriber (TRACE, no ANSI) for the current test
/// and exposes the captured output. `#[tokio::test]` runs on a single
/// thread, so the oneshot router / spawned server tasks all log into the
/// same buffer.
///
/// A second (no-op) dispatcher stays registered alongside it: with exactly
/// one registered dispatcher, tracing-core (`has_just_one`) builds a new
/// callsite's cached interest from the registering thread's default, so a
/// parallel test thread without a subscriber reaching the same callsite
/// first would cache `never` and this test's events would be dropped.
pub struct LogCapture {
    buf: LogBuf,
    _guard: tracing::dispatcher::DefaultGuard,
    _second_dispatch: tracing::Dispatch,
}

impl LogCapture {
    pub fn new() -> Self {
        let second_dispatch = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(buf.clone())
            .finish();
        let dispatch = tracing::dispatcher::Dispatch::new(subscriber);
        let _guard = tracing::dispatcher::set_default(&dispatch);
        Self {
            buf,
            _guard,
            _second_dispatch: second_dispatch,
        }
    }

    pub fn output(&self) -> String {
        String::from_utf8(self.buf.0.lock().unwrap().clone()).unwrap()
    }
}
