//! Receipt image intake and delivery (spec_mcp-tools.md 5-3, 11-5;
//! spec_data-model.md 6-3): safe_fetch of the ChatGPT `download_url`
//! (host allowlist, size cap, no redirects), EXIF extraction, orientation
//! fix, resize, lossy WebP encode, storage under the image root, and the
//! short-lived access tokens used by `/media/img/<token>`.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde_json::{Map, Value};
use sqlx::SqlitePool;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::auth::tokens::{b64url_decode, b64url_encode, random_token, sha256};
use crate::config::McpImageSettings;

/// Why an image could not be saved (drafts.image_unavailable_reason, I3b).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFail {
    FetchFailed,
    TooLarge,
    DecodeFailed,
    Timeout,
}

impl ImageFail {
    pub fn reason(self) -> &'static str {
        match self {
            Self::FetchFailed => "fetch_failed",
            Self::TooLarge => "too_large",
            Self::DecodeFailed => "decode_failed",
            Self::Timeout => "fetch_timeout",
        }
    }
}

/// Raw bytes as downloaded plus the response's file name.
#[derive(Debug, Clone)]
pub struct Fetched {
    pub bytes: Vec<u8>,
    /// From Content-Disposition (`download` source, spec 5-3).
    pub filename: Option<String>,
    pub host: String,
}

/// What survives of a fetch once the downloaded bytes were handed to the
/// conversion: the original bytes are moved into the decode and dropped when
/// it finishes, so they are never kept alongside the result (TASK-18 2-5).
#[derive(Debug, Clone)]
pub struct FetchedMeta {
    pub filename: Option<String>,
    pub host: String,
}

impl Fetched {
    /// Split into the bytes (to be moved into the decode) and the metadata.
    pub fn split(self) -> (Vec<u8>, FetchedMeta) {
        (
            self.bytes,
            FetchedMeta {
                filename: self.filename,
                host: self.host,
            },
        )
    }
}

/// Build the HTTP client used for image downloads: redirects are never
/// followed (a 3xx is a failure), so the allowlist cannot be bypassed.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("budget-book/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Whether `host` is on the allowlist (exact match, or `*.suffix` for
/// subdomains of suffix).
pub fn host_allowed(host: &str, allowlist: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    allowlist.iter().any(|pat| {
        let pat = pat.to_ascii_lowercase();
        match pat.strip_prefix("*.") {
            Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
            None => host == pat,
        }
    })
}

/// Validate a download URL against the allowlist rules (spec 5-3).
pub fn check_url(raw: &str, cfg: &McpImageSettings) -> Result<url::Url, ImageFail> {
    let url: url::Url = raw.parse().map_err(|_| ImageFail::FetchFailed)?;
    let host = url.host_str().ok_or(ImageFail::FetchFailed)?.to_string();
    let is_ip = host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[');
    match url.scheme() {
        "https" => {}
        "http" if cfg.allow_insecure_loopback => {}
        _ => return Err(ImageFail::FetchFailed),
    }
    if is_ip && !cfg.allow_insecure_loopback {
        return Err(ImageFail::FetchFailed);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ImageFail::FetchFailed);
    }
    if !host_allowed(&host, &cfg.fetch_allowed_hosts) {
        return Err(ImageFail::FetchFailed);
    }
    Ok(url)
}

/// Download with the allowlist, size cap and no redirects.
pub async fn safe_fetch(
    client: &reqwest::Client,
    raw_url: &str,
    cfg: &McpImageSettings,
) -> Result<Fetched, ImageFail> {
    let url = check_url(raw_url, cfg)?;
    let host = url.host_str().unwrap_or_default().to_string();
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|_| ImageFail::FetchFailed)?;
    if !resp.status().is_success() {
        return Err(ImageFail::FetchFailed);
    }
    if resp
        .content_length()
        .is_some_and(|n| n > cfg.max_download_bytes)
    {
        return Err(ImageFail::TooLarge);
    }
    let filename = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(content_disposition_filename);
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ImageFail::FetchFailed)?;
        if bytes.len() as u64 + chunk.len() as u64 > cfg.max_download_bytes {
            return Err(ImageFail::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(ImageFail::FetchFailed);
    }
    Ok(Fetched {
        bytes,
        filename,
        host,
    })
}

/// File name from a Content-Disposition value (`filename*=UTF-8''..`
/// preferred over `filename=".."`). Path components are stripped.
pub fn content_disposition_filename(v: &str) -> Option<String> {
    let mut plain = None;
    let mut extended = None;
    for part in v.split(';').map(str::trim) {
        let Some((k, val)) = part.split_once('=') else {
            continue;
        };
        match k.trim().to_ascii_lowercase().as_str() {
            "filename*" => {
                let val = val.trim().trim_matches('"');
                let enc = val.split_once("''").map(|(_, rest)| rest).unwrap_or(val);
                extended = Some(percent_decode(enc));
            }
            "filename" => plain = Some(val.trim().trim_matches('"').to_string()),
            _ => {}
        }
    }
    let name = extended.or(plain)?;
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if base.is_empty() {
        None
    } else {
        Some(base.chars().take(255).collect())
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && s.is_char_boundary(i + 3)
            && let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Result of the conversion (spec 5-3 変換).
#[derive(Debug, Clone)]
pub struct Processed {
    pub webp: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// sha256 of the downloaded bytes (before conversion).
    pub sha256: [u8; 32],
    /// EXIF fields without GPS (spec_data-model 6-3).
    pub exif_json: Option<String>,
    /// 'YYYY-MM-DDTHH:MM:SS' from DateTimeOriginal.
    pub taken_at_local: Option<String>,
    pub taken_at_offset: Option<String>,
}

/// EXIF extracted before any pixel work.
#[derive(Debug, Clone, Default)]
pub struct ExifInfo {
    pub json: Option<String>,
    pub orientation: Option<u8>,
    pub taken_at_local: Option<String>,
    pub taken_at_offset: Option<String>,
}

pub fn extract_exif(bytes: &[u8]) -> ExifInfo {
    let Ok(ex) = exif::Reader::new().read_from_container(&mut Cursor::new(bytes)) else {
        return ExifInfo::default();
    };
    let mut map = Map::new();
    let mut info = ExifInfo::default();
    for f in ex.fields() {
        if f.tag.context() == exif::Context::Gps || f.tag == exif::Tag::GPSInfoIFDPointer {
            continue; // GPS is never stored
        }
        if f.ifd_num != exif::In::PRIMARY {
            continue;
        }
        let shown = f.display_value().to_string();
        map.insert(
            f.tag.to_string(),
            Value::String(shown.chars().take(500).collect()),
        );
    }
    if let Some(f) = ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        && let Some(v) = f.value.get_uint(0)
    {
        info.orientation = u8::try_from(v).ok();
    }
    if let Some(f) = ex.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        && let exif::Value::Ascii(ref v) = f.value
        && let Some(raw) = v.first()
        && let Ok(dt) = exif::DateTime::from_ascii(raw)
    {
        info.taken_at_local = Some(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second
        ));
    }
    if let Some(f) = ex.get_field(exif::Tag::OffsetTimeOriginal, exif::In::PRIMARY)
        && let exif::Value::Ascii(ref v) = f.value
        && let Some(raw) = v.first()
    {
        let s = String::from_utf8_lossy(raw).trim().to_string();
        if !s.is_empty() {
            info.taken_at_offset = Some(s);
        }
    }
    if !map.is_empty() {
        info.json = Some(Value::Object(map).to_string());
    }
    info
}

/// EXIF -> orientation fix -> resize -> lossy WebP (CPU bound; call from
/// spawn_blocking).
pub fn process(bytes: &[u8], cfg: &McpImageSettings) -> Result<Processed, ImageFail> {
    let hash = sha256(bytes);
    let exif = extract_exif(bytes);
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| ImageFail::DecodeFailed)?;
    let (w, h) = reader
        .into_dimensions()
        .map_err(|_| ImageFail::DecodeFailed)?;
    if u64::from(w) * u64::from(h) > cfg.max_pixels {
        return Err(ImageFail::TooLarge);
    }
    let mut img = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| ImageFail::DecodeFailed)?
        .decode()
        .map_err(|_| ImageFail::DecodeFailed)?;
    if let Some(o) = exif
        .orientation
        .and_then(image::metadata::Orientation::from_exif)
    {
        img.apply_orientation(o);
    }
    let max = cfg.resize_max_edge;
    if img.width() > max || img.height() > max {
        img = img.resize(max, max, image::imageops::FilterType::Triangle);
    }
    let (width, height) = (img.width(), img.height());
    let webp: Vec<u8> = if img.color().has_alpha() {
        let buf = img.to_rgba8();
        webp::Encoder::from_rgba(&buf, width, height)
            .encode(cfg.webp_quality)
            .to_vec()
    } else {
        let buf = img.to_rgb8();
        webp::Encoder::from_rgb(&buf, width, height)
            .encode(cfg.webp_quality)
            .to_vec()
    };
    if webp.is_empty() {
        return Err(ImageFail::DecodeFailed);
    }
    Ok(Processed {
        webp,
        width,
        height,
        sha256: hash,
        exif_json: exif.json,
        taken_at_local: exif.taken_at_local,
        taken_at_offset: exif.taken_at_offset,
    })
}

/// Fetch + convert inside one deadline (spec 5-3: the I3a/I3b UPDATE runs
/// outside of it). The permit wait for the decode slot is part of the window
/// (TASK-18 L4) so a single-tool call never exceeds its own time limit.
pub async fn fetch_and_process(
    client: &reqwest::Client,
    url: &str,
    cfg: &McpImageSettings,
    gate: &DecodeGate,
) -> Result<(FetchedMeta, Processed), ImageFail> {
    let deadline = Instant::now() + std::time::Duration::from_secs(cfg.fetch_timeout_secs);
    let fetched = match tokio::time::timeout_at(deadline.into(), safe_fetch(client, url, cfg)).await
    {
        Ok(r) => r?,
        Err(_) => return Err(ImageFail::Timeout),
    };
    // the bytes move into the decode (no copy) and are freed when it ends
    let (bytes, meta) = fetched.split();
    process_gated(gate, false, bytes, cfg, deadline)
        .await
        .map(|p| (meta, p))
}

// ---------------------------------------------------------------------------
// decode gate + parallel batch fetch (TASK-18 2-5)

/// Process-wide decode slots shared by every concurrent tool call: `all` caps
/// the total concurrent decodes, `batch` caps how many of them one batch call
/// (or several) may occupy. `batch_decode_concurrency < decode_concurrency`
/// leaves at least one slot free for single-tool calls at all times.
#[derive(Debug, Clone)]
pub struct DecodeGate {
    all: Arc<Semaphore>,
    batch: Arc<Semaphore>,
}

/// Both permits of one gated decode, held until the decode finishes (the
/// closure moves them into `spawn_blocking`, so a deadline abort does not
/// free the slot while pixels are still being processed).
pub struct GatePermit {
    _batch: Option<OwnedSemaphorePermit>,
    _all: OwnedSemaphorePermit,
}

impl DecodeGate {
    pub fn new(decode_concurrency: usize, batch_decode_concurrency: usize) -> Self {
        Self {
            all: Arc::new(Semaphore::new(decode_concurrency)),
            batch: Arc::new(Semaphore::new(batch_decode_concurrency)),
        }
    }

    /// Acquire the decode slots (batch: batch -> all, both held). None when
    /// the deadline passes first; nothing is started in that case.
    pub async fn acquire(&self, batch: bool, deadline: Instant) -> Option<GatePermit> {
        // tokio's timeout polls the inner future before checking the deadline,
        // so a free permit would be taken after the deadline without this
        if Instant::now() >= deadline {
            return None;
        }
        if batch {
            let b = tokio::time::timeout_at(deadline.into(), self.batch.clone().acquire_owned())
                .await
                .ok()?
                .ok()?;
            let a = tokio::time::timeout_at(deadline.into(), self.all.clone().acquire_owned())
                .await
                .ok()?
                .ok()?; // on None the batch permit above is dropped and released
            Some(GatePermit {
                _batch: Some(b),
                _all: a,
            })
        } else {
            let a = tokio::time::timeout_at(deadline.into(), self.all.clone().acquire_owned())
                .await
                .ok()?
                .ok()?;
            Some(GatePermit {
                _batch: None,
                _all: a,
            })
        }
    }
}

/// Run `work` on the blocking pool while holding the gate permits for its
/// whole duration. A deadline miss before the permits are acquired never
/// starts the work; a deadline miss afterwards abandons the result but the
/// running decode keeps its permits (concurrency stays capped).
pub async fn run_gated<T, F>(
    gate: &DecodeGate,
    batch: bool,
    deadline: Instant,
    work: F,
) -> Result<T, ImageFail>
where
    F: FnOnce() -> Result<T, ImageFail> + Send + 'static,
    T: Send + 'static,
{
    let Some(permit) = gate.acquire(batch, deadline).await else {
        return Err(ImageFail::Timeout);
    };
    let joined = tokio::task::spawn_blocking(move || {
        let _held = permit;
        work()
    });
    match tokio::time::timeout_at(deadline.into(), joined).await {
        Ok(Ok(r)) => r,
        Ok(Err(_join_err)) => Err(ImageFail::DecodeFailed),
        Err(_) => Err(ImageFail::Timeout),
    }
}

/// Decode + convert under the gate (single-tool: `batch = false`).
pub async fn process_gated(
    gate: &DecodeGate,
    batch: bool,
    bytes: Vec<u8>,
    cfg: &McpImageSettings,
    deadline: Instant,
) -> Result<Processed, ImageFail> {
    let cfg = cfg.clone();
    run_gated(gate, batch, deadline, move || process(&bytes, &cfg)).await
}

/// Knobs of one batch fetch round (TASK-18 2-5).
#[derive(Debug, Clone, Copy)]
pub struct BatchFetchOpts {
    /// Concurrent downloads inside this call.
    pub fetch_concurrency: usize,
    /// Whole-call deadline; nothing new starts after it.
    pub deadline: Instant,
}

/// Fetch + convert each file with the per-image window
/// `min(start + fetch_timeout_secs, batch deadline)` and the shared decode
/// gate. Results keep the input keys; a file_id sent once is fetched once.
/// Results come back in completion order (`buffer_unordered`: a slow head
/// does not hold back the start of the next downloads). The downloaded bytes
/// of each file are moved into its decode and freed when it finishes, so at
/// most `fetch_concurrency` original files are held at a time; only the
/// converted WebP (`Processed`) is returned.
pub async fn fetch_images<K>(
    client: &reqwest::Client,
    gate: &DecodeGate,
    cfg: &McpImageSettings,
    files: Vec<(K, String)>,
    opts: BatchFetchOpts,
) -> Vec<(K, Result<(FetchedMeta, Processed), ImageFail>)>
where
    K: Send + Clone + 'static,
{
    use futures_util::StreamExt as _;
    let items = files.into_iter().map(|(key, url)| {
        let client = client.clone();
        let gate = gate.clone();
        let cfg = cfg.clone();
        async move {
            let out = async {
                let item_deadline = std::cmp::min(
                    Instant::now() + std::time::Duration::from_secs(cfg.fetch_timeout_secs),
                    opts.deadline,
                );
                if Instant::now() >= item_deadline {
                    return Err(ImageFail::Timeout);
                }
                let fetched =
                    tokio::time::timeout_at(item_deadline.into(), safe_fetch(&client, &url, &cfg))
                        .await
                        .map_err(|_| ImageFail::Timeout)??;
                let (bytes, meta) = fetched.split();
                let processed = process_gated(&gate, true, bytes, &cfg, item_deadline).await?;
                Ok((meta, processed))
            };
            (key, out.await)
        }
    });
    futures_util::stream::iter(items)
        .buffer_unordered(opts.fetch_concurrency.max(1))
        .collect()
        .await
}

/// Metadata recorded with a stored image (spec_data-model 6-3).
#[derive(Debug, Clone)]
pub struct NewImage<'a> {
    pub ledger_id: i64,
    pub uploaded_by: i64,
    pub source_file_id: Option<&'a str>,
    pub source_host: Option<&'a str>,
    pub reported_filename: Option<&'a str>,
    pub reported_taken_at: Option<&'a str>,
}

/// Write the WebP under `<root>/YYYY/MM/<ulid>.webp` and insert the images
/// row. Returns the image id. On a DB failure the file is removed again.
pub async fn store_image(
    pool: &SqlitePool,
    root: &Path,
    p: &Processed,
    fetched_filename: Option<&str>,
    meta: &NewImage<'_>,
    now: i64,
) -> anyhow::Result<i64> {
    let rnd = random_token();
    let mut lo = [0u8; 16];
    lo.copy_from_slice(&rnd[..16]);
    let key = ulid::Ulid::from_parts(now.max(0) as u64, u128::from_be_bytes(lo))
        .to_string()
        .to_ascii_lowercase();
    let d = super::util::jst_date(now);
    let rel = format!("{}/{}.webp", d.format("%Y/%m"), key);
    let abs: PathBuf = root.join(&rel);
    if let Some(parent) = abs.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&abs, &p.webp).await?;
    // provenance rules (spec 5-3): download name > model name; EXIF > model
    let (orig_name, orig_src) = match (fetched_filename, meta.reported_filename) {
        (Some(n), _) => (Some(n.to_string()), Some("download")),
        (None, Some(n)) => (Some(n.to_string()), Some("model")),
        _ => (None, None),
    };
    let (taken, taken_src, offset) = match (&p.taken_at_local, meta.reported_taken_at) {
        (Some(t), _) => (Some(t.clone()), Some("exif"), p.taken_at_offset.clone()),
        (None, Some(t)) => (Some(normalize_taken_at(t)), Some("model"), None),
        _ => (None, None, None),
    };
    let res = sqlx::query_scalar::<_, i64>(
        "INSERT INTO images (ledger_id, uploaded_by, file_key, storage_path, mime_type, width, height,
            byte_size, sha256, source_file_id, source_host, original_filename, original_filename_source,
            taken_at_local, taken_at_offset, taken_at_source, exif_json, created_at)
         VALUES (?, ?, ?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(meta.ledger_id)
    .bind(meta.uploaded_by)
    .bind(&key)
    .bind(&rel)
    .bind(i64::from(p.width))
    .bind(i64::from(p.height))
    .bind(p.webp.len() as i64)
    .bind(p.sha256.to_vec())
    .bind(meta.source_file_id)
    .bind(meta.source_host)
    .bind(&orig_name)
    .bind(orig_src)
    .bind(&taken)
    .bind(&offset)
    .bind(taken_src)
    .bind(&p.exif_json)
    .bind(now)
    .fetch_one(pool)
    .await;
    match res {
        Ok(id) => Ok(id),
        Err(e) => {
            let _ = tokio::fs::remove_file(&abs).await;
            Err(e.into())
        }
    }
}

/// "YYYY-MM-DDTHH:MM" -> "YYYY-MM-DDTHH:MM:00".
fn normalize_taken_at(s: &str) -> String {
    if s.len() == 16 {
        format!("{s}:00")
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// access tokens (spec 11-5)

/// An issued image URL for `_meta.images`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImageUrl {
    pub url: String,
    pub expires_at: String,
    pub width: i64,
    pub height: i64,
}

/// Issue a token for one image to one user and build the URL.
pub async fn issue_image_url(
    pool: &SqlitePool,
    public_origin: &str,
    image_id: i64,
    user_id: i64,
    ttl_secs: i64,
    now: i64,
) -> anyhow::Result<Option<ImageUrl>> {
    let row: Option<(i64, i64, i64)> =
        sqlx::query_as("SELECT ledger_id, width, height FROM images WHERE id = ?")
            .bind(image_id)
            .fetch_optional(pool)
            .await?;
    let Some((ledger_id, width, height)) = row else {
        return Ok(None);
    };
    let token = random_token();
    let expires_at = now + ttl_secs * 1000;
    sqlx::query(
        "INSERT INTO image_access_tokens (token_hash, image_id, ledger_id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256(&token).to_vec())
    .bind(image_id)
    .bind(ledger_id)
    .bind(user_id)
    .bind(now)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(Some(ImageUrl {
        url: format!("{public_origin}/media/img/{}", b64url_encode(&token)),
        expires_at: super::util::jst_iso(expires_at),
        width,
        height,
    }))
}

/// Delivery-time recheck in one query (spec 11-5 1-3). Returns the storage
/// path and the token expiry, or None (404 regardless of the reason).
pub async fn resolve_token(
    pool: &SqlitePool,
    token_b64: &str,
    now: i64,
) -> anyhow::Result<Option<(String, i64)>> {
    let Some(raw) = b64url_decode(token_b64) else {
        return Ok(None);
    };
    if raw.len() != crate::auth::tokens::TOKEN_LEN {
        return Ok(None);
    }
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT im.storage_path, t.expires_at
         FROM image_access_tokens t
         JOIN images im ON im.id = t.image_id
         JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
         JOIN ledger_members m ON m.ledger_id = im.ledger_id AND m.user_id = t.user_id
         WHERE t.token_hash = ? AND t.expires_at > ?
           AND (EXISTS (SELECT 1 FROM receipts r WHERE r.image_id = im.id AND r.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM drafts d WHERE d.image_id = im.id AND d.status = 'pending'
                        AND d.user_id = t.user_id))",
    )
    .bind(sha256(&raw).to_vec())
    .bind(now)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> McpImageSettings {
        McpImageSettings {
            fetch_allowed_hosts: vec![
                "files.oaiusercontent.com".into(),
                "*.oaiusercontent.com".into(),
            ],
            fetch_timeout_secs: 5,
            max_download_bytes: 1024,
            max_pixels: 100,
            resize_max_edge: 8,
            webp_quality: 80.0,
            access_token_ttl_secs: 900,
            allow_insecure_loopback: false,
            batch_fetch_concurrency: 3,
            decode_concurrency: 2,
            batch_decode_concurrency: 1,
            batch_fetch_deadline_secs: 40,
        }
    }

    // [covers:mcp-image.safe-fetch-url-rules]
    #[test]
    fn url_rules() {
        let c = cfg();
        assert!(check_url("https://files.oaiusercontent.com/x?sig=1", &c).is_ok());
        assert!(check_url("https://a.b.oaiusercontent.com/x", &c).is_ok());
        assert!(check_url("https://oaiusercontent.com.evil.com/x", &c).is_err());
        assert!(check_url("https://evil.com/x", &c).is_err());
        assert!(check_url("http://files.oaiusercontent.com/x", &c).is_err());
        assert!(check_url("https://127.0.0.1/x", &c).is_err());
        assert!(check_url("https://u:p@files.oaiusercontent.com/x", &c).is_err());
        assert!(check_url("not a url", &c).is_err());
    }

    #[test]
    fn content_disposition_names() {
        assert_eq!(
            content_disposition_filename("attachment; filename=\"IMG_1.jpg\"").as_deref(),
            Some("IMG_1.jpg")
        );
        assert_eq!(
            content_disposition_filename(
                "attachment; filename=\"x.jpg\"; filename*=UTF-8''%E3%83%AC%E3%82%B7%E3%83%BC%E3%83%88.jpg"
            )
            .as_deref(),
            Some("レシート.jpg")
        );
        assert_eq!(
            content_disposition_filename("attachment; filename=\"../../etc/passwd\"").as_deref(),
            Some("passwd")
        );
        assert_eq!(content_disposition_filename("inline"), None);
    }

    // [covers:mcp-image.too-large-pixels]
    #[test]
    fn pixel_cap_is_too_large() {
        let img = image::RgbImage::from_pixel(20, 20, image::Rgb([1, 2, 3]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert_eq!(process(&png, &cfg()).unwrap_err(), ImageFail::TooLarge);
        assert_eq!(
            process(b"not an image", &cfg()).unwrap_err(),
            ImageFail::DecodeFailed
        );
    }

    // -------------------------------------------------------------------------
    // decode gate (TASK-18 2-5)

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A controllable "decode" job: counts invocations and concurrent runs.
    #[derive(Clone)]
    struct Probe {
        calls: Arc<AtomicUsize>,
        in_flight: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
    }

    impl Probe {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                in_flight: Arc::new(AtomicUsize::new(0)),
                max_in_flight: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// Closure for `run_gated`: records entry/exit and sleeps.
        fn job(&self, ms: u64) -> impl FnOnce() -> Result<usize, ImageFail> + Send + 'static {
            let (calls, in_flight, max) = (
                self.calls.clone(),
                self.in_flight.clone(),
                self.max_in_flight.clone(),
            );
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max.fetch_max(cur, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(ms));
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Ok(cur)
            }
        }
    }

    // [covers:mcp-image.decode-gate]
    #[tokio::test]
    async fn decode_gate_caps_concurrency_and_honors_the_deadline() {
        let gate = DecodeGate::new(1, 1);
        let far = Instant::now() + std::time::Duration::from_secs(30);
        let probe = Probe::new();
        // two "decodes" on a 1-permit gate: the second waits, its wait is cut
        // by its own deadline and it never runs
        let a = run_gated(&gate, false, far, probe.job(150));
        let short = Instant::now() + std::time::Duration::from_millis(60);
        let b = run_gated(&gate, false, short, probe.job(150));
        let (ra, rb) = futures_util::join!(a, b);
        assert!(ra.is_ok(), "the running decode completes: {ra:?}");
        assert_eq!(rb.unwrap_err(), ImageFail::Timeout, "the waiter is cut off");
        // a permit that cannot be taken before the deadline never starts work
        let past = Instant::now() - std::time::Duration::from_secs(1);
        let never = run_gated(&gate, false, past, probe.job(1));
        assert_eq!(never.await.unwrap_err(), ImageFail::Timeout);
        // the abandoned decode finished in the background and released its
        // permit: one more decode runs immediately
        let c = run_gated(&gate, false, far, probe.job(1));
        assert!(c.await.is_ok());
        assert_eq!(probe.calls.load(Ordering::SeqCst), 2, "only a and c ran");
        assert_eq!(probe.max_in_flight.load(Ordering::SeqCst), 1, "capped at 1");
    }

    // [covers:mcp-image.decode-gate-single-reserved]
    #[tokio::test]
    async fn decode_gate_reserves_a_slot_for_single_calls() {
        // decode_concurrency = 2, batch_decode_concurrency = 1
        let gate = DecodeGate::new(2, 1);
        let far = Instant::now() + std::time::Duration::from_secs(30);
        let probe = Probe::new();
        // a batch decode holds both permits for a while (spawned so it runs
        // concurrently with the calls below)
        let batch_hold = {
            let (gate, job) = (gate.clone(), probe.job(150));
            tokio::spawn(async move { run_gated(&gate, true, far, job).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        // a single-tool decode must not wait behind the batch occupant
        let t0 = Instant::now();
        let single = run_gated(&gate, false, far, probe.job(1)).await;
        assert!(single.is_ok());
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(120),
            "the single path is not starved: {:?}",
            t0.elapsed()
        );
        // a second concurrent batch decode is capped: it waits for the batch
        // permit and its short deadline cuts the wait without running
        let short = Instant::now() + std::time::Duration::from_millis(50);
        let b2 = run_gated(&gate, true, short, probe.job(150));
        assert_eq!(b2.await.unwrap_err(), ImageFail::Timeout);
        assert!(
            batch_hold.await.unwrap().is_ok(),
            "the first batch decode finishes"
        );
        assert_eq!(probe.max_in_flight.load(Ordering::SeqCst), 2);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 2, "b2 never ran");
    }
}
