//! Loading of `configs/*.toml` (single source of truth for settings).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Environment variable that overrides the configs directory.
pub const CONFIG_DIR_ENV: &str = "BUDGET_BOOK_CONFIG_DIR";
/// Default configs directory (relative to the current directory).
pub const DEFAULT_CONFIG_DIR: &str = "configs/dev";
/// File name of the application settings inside the configs directory.
pub const APP_CONFIG_FILE: &str = "app.toml";
/// File name of the authentication settings inside the configs directory.
pub const AUTH_CONFIG_FILE: &str = "auth.toml";
/// File name of the MCP tool settings inside the configs directory.
pub const MCP_CONFIG_FILE: &str = "mcp.toml";

// ---------------------------------------------------------------------------
// mcp.toml (spec_mcp-tools.md sections 1, 3-5, 5-3, 11-5)

/// Contents of `configs/mcp.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpToolsConfig {
    pub limits: McpLimits,
    pub image: McpImageSettings,
    pub widget: McpWidgetSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpLimits {
    pub max_items: usize,
    pub max_name_chars: usize,
    /// TASK-20: ledger display-name cap (spec_mcp-tools.md 3-5) —
    /// rename_ledger (MCP) and PATCH /api/ledgers/{l} (web). Chars after
    /// trim; over the cap is an input error (isError / 400).
    pub max_ledger_name_chars: usize,
    pub max_note_chars: usize,
    pub search_default_limit: i64,
    pub search_max_limit: i64,
    /// TASK-73: free-text search query cap (spec_mcp-tools.md 3-5) —
    /// search_receipts store / item_query, summarize_spending filters,
    /// get_catalog store_query and the web q / store / item_query / stores
    /// query params. Chars at the input (pre-normalize); over the cap is a
    /// whole-call input error.
    pub max_query_chars: usize,
    pub stats_max_rows: usize,
    pub catalog_max_stores: i64,
    pub widget_refs_max: usize,
    pub drafts_default_limit: i64,
    pub drafts_max_limit: i64,
    pub max_label_title_chars: usize,
    pub max_label_batch: usize,
    /// #20 create_receipt_drafts element cap (TASK-18). Entries beyond the cap
    /// are returned as not-saved elements, not a rejection.
    pub batch_max_drafts: usize,
    /// #21 approve_receipt_drafts items cap (whole-call validation error).
    pub batch_max_approve: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpImageSettings {
    pub fetch_allowed_hosts: Vec<String>,
    pub fetch_timeout_secs: u64,
    pub max_download_bytes: u64,
    pub max_pixels: u64,
    pub resize_max_edge: u32,
    pub webp_quality: f32,
    pub access_token_ttl_secs: i64,
    pub allow_insecure_loopback: bool,
    /// Concurrent downloads inside one create_receipt_drafts call.
    pub batch_fetch_concurrency: usize,
    /// Process-wide concurrent decode slots (single-tool calls included).
    pub decode_concurrency: usize,
    /// Decode slots a batch call may occupy. Must stay below
    /// `decode_concurrency` so a single-tool call always finds a free slot.
    pub batch_decode_concurrency: usize,
    /// Whole-call fetch + convert deadline of create_receipt_drafts.
    pub batch_fetch_deadline_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpWidgetSettings {
    pub html_path: PathBuf,
}

/// Parse and validate `mcp.toml`.
pub fn parse_mcp_tools(text: &str) -> Result<McpToolsConfig, ConfigError> {
    let cfg: McpToolsConfig = toml::from_str(text).map_err(|source| ConfigError::Parse {
        path: PathBuf::from(MCP_CONFIG_FILE),
        source,
    })?;
    let l = &cfg.limits;
    if l.max_items == 0
        || l.max_name_chars == 0
        || l.max_ledger_name_chars == 0
        || l.max_note_chars == 0
        || l.search_default_limit <= 0
        || l.search_max_limit < l.search_default_limit
        || l.max_query_chars == 0
        || l.stats_max_rows == 0
        || l.catalog_max_stores <= 0
        || l.widget_refs_max == 0
        || l.drafts_default_limit <= 0
        || l.drafts_max_limit < l.drafts_default_limit
        || l.max_label_title_chars == 0
        || l.max_label_batch == 0
        || l.batch_max_drafts == 0
        || l.batch_max_approve == 0
    {
        return Err(ConfigError::Invalid(
            "mcp.toml [limits] values must be positive (max >= default)".into(),
        ));
    }
    let i = &cfg.image;
    if i.fetch_allowed_hosts.is_empty()
        || i.fetch_timeout_secs == 0
        || i.max_download_bytes == 0
        || i.max_pixels == 0
        || i.resize_max_edge == 0
        || !(0.0..=100.0).contains(&i.webp_quality)
        || i.access_token_ttl_secs <= 0
        || i.batch_fetch_concurrency == 0
        || i.decode_concurrency == 0
        || i.batch_fetch_deadline_secs == 0
    {
        return Err(ConfigError::Invalid(
            "mcp.toml [image] values must be positive (quality 0-100, allowlist non-empty)".into(),
        ));
    }
    // The single-tool path must always keep a free decode slot: the batch
    // occupancy cap has to stay strictly below the whole-process cap.
    if i.batch_decode_concurrency == 0 || i.batch_decode_concurrency >= i.decode_concurrency {
        return Err(ConfigError::Invalid(
            "mcp.toml [image] batch_decode_concurrency must be 1..decode_concurrency-1 (a single-tool call always keeps a free decode slot)".into(),
        ));
    }
    Ok(cfg)
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse {path}: {source}")]
    Parse {
        path: PathBuf,
        source: toml::de::Error,
    },
    #[error("invalid config: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub mcp: McpConfig,
    pub database: DatabaseConfig,
    pub log: LogConfig,
    pub frontend: FrontendConfig,
    pub maintenance: MaintenanceConfig,
    pub data_io: DataIoConfig,
}

/// TASK-58 settings-page export / import caps. The payload cap bounds the
/// export response (serialized) and the import request body (route body
/// limit); the count caps bound one import transaction's DB work.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataIoConfig {
    pub max_payload_bytes: usize,
    pub max_receipts: usize,
    pub max_items_total: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    /// Bind addresses (loopback only: ["127.0.0.1", "::1"] so that
    /// localhost-resolving clients on either stack reach the server).
    pub hosts: Vec<String>,
    pub port: u16,
    pub shutdown_timeout_secs: u64,
}

/// Vite dev server settings (development only; read from the shared config file).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontendConfig {
    pub dev_port: u16,
    /// Built frontend directory served by the backend (SPA + assets);
    /// relative paths resolve against the project root.
    #[serde(default = "default_static_dir")]
    pub static_dir: PathBuf,
}

fn default_static_dir() -> PathBuf {
    PathBuf::from("frontend/dist")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpConfig {
    pub path: String,
    pub allowed_hosts: Vec<String>,
    pub max_request_body_bytes: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseConfig {
    pub path: PathBuf,
    pub max_connections: u32,
    pub busy_timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogConfig {
    pub filter: String,
}

/// TTL sweep scheduling and the image storage root (spec_data-model.md
/// section 12; runs once at startup and then on the interval).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaintenanceConfig {
    pub cleanup_interval_secs: u64,
    /// Root directory for stored images; relative paths resolve against the
    /// project root.
    pub image_root: PathBuf,
}

// ---------------------------------------------------------------------------
// auth.toml (spec_auth.md sections 1, 2-1, 2-5, 3, 8-2, 10-1, 10-3)

/// Contents of `configs/auth.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthFile {
    pub auth: AuthSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthSettings {
    /// Which `[auth.env.<profile>]` section to use.
    pub profile: String,
    /// Environment specific origin / RP settings keyed by profile name.
    pub env: HashMap<String, EnvOriginSettings>,
    pub session: SessionSettings,
    pub ceremony: CeremonySettings,
    pub invitation: InvitationSettings,
    pub rate_limit: RateLimitSettings,
    pub oauth: OAuthSettings,
    pub recovery_request: RecoveryRequestSettings,
}

/// Per-environment origin / Relying Party settings (`[auth.env.dev]` etc.).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvOriginSettings {
    pub rp_id: String,
    pub rp_origin: String,
    pub public_origin: String,
    pub issuer: String,
    pub resource: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSettings {
    pub idle_days: i64,
    pub absolute_days: i64,
    pub step_up_secs: i64,
    pub last_seen_update_secs: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CeremonySettings {
    pub ttl_secs: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvitationSettings {
    pub setup_ttl_hours: i64,
    pub invite_ttl_hours: i64,
    pub recovery_ttl_hours: i64,
    pub recovery_ttl_max_hours: i64,
    /// register invitation (web, any active user) TTL in hours (TASK-32).
    pub register_ttl_hours: i64,
    /// ledger share ticket (web, ledger owner) TTL in hours (share design
    /// section 3-1, D-J4: 168h, split from `invite_ttl_hours`).
    pub share_ttl_hours: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RateLimitSettings {
    pub webauthn_per_minute: u32,
    pub token_accept_per_minute: u32,
    pub token_accept_fail_block: u32,
    pub token_accept_block_minutes: u32,
    pub authorize_per_minute: u32,
    pub token_endpoint_per_minute: u32,
    pub mcp_per_minute: u32,
    pub recovery_anonymous_per_minute: u32,
    pub trust_cf_connecting_ip: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthSettings {
    pub default_scopes: String,
    pub cimd_allowed_hosts: Vec<String>,
    pub redirect_uri_allowlist: Vec<String>,
    pub authz_request_ttl_secs: i64,
    pub code_ttl_secs: i64,
    pub access_token_ttl_secs: i64,
    pub refresh_sliding_days: i64,
    pub grant_absolute_days: i64,
    pub rotation_grace_secs: i64,
    pub clock_skew_secs: i64,
    pub dev: OAuthDevSettings,
}

/// Dev/test-only relaxations so CIMD / JWKS can be served by a local plain
/// HTTP mock server (spec_auth.md section 4-3 assumes https + public hosts).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthDevSettings {
    /// Accept http:// client_id / redirect URIs on loopback hosts and let
    /// safe_fetch connect to loopback/private addresses. Rejected at startup
    /// when the selected profile uses https.
    pub allow_insecure_loopback: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryRequestSettings {
    pub per_subject_hours: i64,
    pub append_per_day: u32,
    pub per_ip_per_day: u32,
    pub global_per_day: u32,
    pub anonymous_ip_per_day: u32,
    pub note_max_chars: usize,
    pub note_total_max_chars: usize,
}

/// Auth settings after profile selection and the startup validation of
/// spec_auth.md section 1 (issuer/resource consistency, RP ID == origin host,
/// no trailing slashes).
#[derive(Debug, Clone)]
pub struct ResolvedAuth {
    pub profile: String,
    pub rp_id: String,
    pub rp_origin: String,
    pub public_origin: String,
    pub issuer: String,
    pub resource: String,
    pub session: SessionSettings,
    pub ceremony: CeremonySettings,
    pub invitation: InvitationSettings,
    pub rate_limit: RateLimitSettings,
    pub oauth: OAuthSettings,
    pub recovery_request: RecoveryRequestSettings,
}

impl AuthSettings {
    /// Select the profile and run the spec_auth.md section 1 validation.
    /// `mcp_path` is `[mcp].path` from app.toml; `resource` must equal
    /// `<public_origin><mcp_path>`.
    pub fn resolve(&self, mcp_path: &str) -> Result<ResolvedAuth, ConfigError> {
        let env = self.env.get(&self.profile).ok_or_else(|| {
            ConfigError::Invalid(format!(
                "[auth.env.{}] section not found for profile {:?}",
                self.profile, self.profile
            ))
        })?;
        validate_origin(&env.public_origin, "public_origin")?;
        validate_origin(&env.rp_origin, "rp_origin")?;
        validate_origin(&env.issuer, "issuer")?;
        if env.issuer != env.public_origin {
            return Err(ConfigError::Invalid(format!(
                "issuer must equal public_origin (got {issuer} vs {origin})",
                issuer = env.issuer,
                origin = env.public_origin
            )));
        }
        if env.resource != format!("{}{}", env.public_origin, mcp_path) {
            return Err(ConfigError::Invalid(format!(
                "resource must equal public_origin + mcp path {mcp_path} (got {})",
                env.resource
            )));
        }
        if env.resource.ends_with('/') {
            return Err(ConfigError::Invalid(
                "resource must not end with '/'".into(),
            ));
        }
        let public = parse_url(&env.public_origin, "public_origin")?;
        let rp = parse_url(&env.rp_origin, "rp_origin")?;
        if env.rp_id != public.host_str().unwrap_or_default()
            || env.rp_id != rp.host_str().unwrap_or_default()
        {
            return Err(ConfigError::Invalid(format!(
                "rp_id must equal the host of rp_origin and public_origin (got {rp_id})",
                rp_id = env.rp_id
            )));
        }
        if self.session.idle_days <= 0
            || self.session.absolute_days <= 0
            || self.session.idle_days > self.session.absolute_days
        {
            return Err(ConfigError::Invalid(
                "session idle_days/absolute_days must be positive with idle <= absolute".into(),
            ));
        }
        if self.session.step_up_secs <= 0 || self.session.last_seen_update_secs <= 0 {
            return Err(ConfigError::Invalid(
                "session.step_up_secs and last_seen_update_secs must be positive".into(),
            ));
        }
        if self.ceremony.ttl_secs <= 0 {
            return Err(ConfigError::Invalid(
                "ceremony.ttl_secs must be positive".into(),
            ));
        }
        if self.invitation.recovery_ttl_hours <= 0
            || self.invitation.recovery_ttl_hours > self.invitation.recovery_ttl_max_hours
            || self.invitation.setup_ttl_hours <= 0
            || self.invitation.invite_ttl_hours <= 0
            || self.invitation.register_ttl_hours <= 0
            || self.invitation.share_ttl_hours <= 0
        {
            return Err(ConfigError::Invalid(
                "invitation TTLs must be positive and recovery default within its max".into(),
            ));
        }
        if self.oauth.cimd_allowed_hosts.is_empty() || self.oauth.redirect_uri_allowlist.is_empty()
        {
            return Err(ConfigError::Invalid(
                "oauth allowlists must not be empty".into(),
            ));
        }
        if self.oauth.authz_request_ttl_secs <= 0
            || self.oauth.code_ttl_secs <= 0
            || self.oauth.access_token_ttl_secs <= 0
            || self.oauth.refresh_sliding_days <= 0
            || self.oauth.grant_absolute_days <= 0
            || self.oauth.rotation_grace_secs < 0
            || self.oauth.clock_skew_secs < 0
        {
            return Err(ConfigError::Invalid(
                "oauth TTLs must be positive (skews non-negative)".into(),
            ));
        }
        if self.oauth.dev.allow_insecure_loopback && public.scheme() == "https" {
            return Err(ConfigError::Invalid(
                "oauth.dev.allow_insecure_loopback must not be enabled with an https profile"
                    .into(),
            ));
        }
        Ok(ResolvedAuth {
            profile: self.profile.clone(),
            rp_id: env.rp_id.clone(),
            rp_origin: env.rp_origin.clone(),
            public_origin: env.public_origin.clone(),
            issuer: env.issuer.clone(),
            resource: env.resource.clone(),
            session: self.session.clone(),
            ceremony: self.ceremony.clone(),
            invitation: self.invitation.clone(),
            rate_limit: self.rate_limit.clone(),
            oauth: self.oauth.clone(),
            recovery_request: self.recovery_request.clone(),
        })
    }
}

/// An origin-shaped URL: absolute http(s), host present, no path content,
/// no query, no fragment, and no trailing slash in the string form.
fn validate_origin(raw: &str, name: &str) -> Result<(), ConfigError> {
    let url = parse_url(raw, name)?;
    if url.path() != "/" && !url.path().is_empty() {
        return Err(ConfigError::Invalid(format!("{name} must not have a path")));
    }
    Ok(())
}

fn parse_url(raw: &str, name: &str) -> Result<url::Url, ConfigError> {
    let url: url::Url = raw
        .parse()
        .map_err(|_| ConfigError::Invalid(format!("{name} is not an absolute URL: {raw:?}")))?;
    let is_loopback = matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    );
    match url.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        scheme => {
            return Err(ConfigError::Invalid(format!(
                "{name} must use https (http is only allowed on loopback hosts), got {scheme}"
            )));
        }
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ConfigError::Invalid(format!(
            "{name} must not have a query or fragment"
        )));
    }
    if raw.ends_with('/') {
        return Err(ConfigError::Invalid(format!(
            "{name} must not end with '/'"
        )));
    }
    Ok(url)
}

/// Loaded configuration plus the directory it was read from.
#[derive(Debug, Clone)]
pub struct Config {
    pub app: AppConfig,
    /// Resolved auth.toml settings (profile selected, validated at startup).
    pub auth: ResolvedAuth,
    /// Project root used to resolve relative paths (parent of the configs dir).
    pub root: PathBuf,
    /// MCP tool settings (`configs/mcp.toml`).
    pub tools: McpToolsConfig,
}

impl Config {
    /// Resolve the configs directory: explicit argument, then env var, then default.
    pub fn resolve_dir(explicit: Option<PathBuf>) -> PathBuf {
        explicit
            .or_else(|| std::env::var_os(CONFIG_DIR_ENV).map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_DIR))
    }

    /// Load `app.toml` and `auth.toml` from the given configs directory.
    pub fn load(dir: &Path) -> Result<Self, ConfigError> {
        let path = dir.join(APP_CONFIG_FILE);
        let text = std::fs::read_to_string(&path).map_err(|source| ConfigError::Read {
            path: path.clone(),
            source,
        })?;
        let app = parse_app(&text).map_err(|e| match e {
            ConfigError::Parse { source, .. } => ConfigError::Parse {
                path: path.clone(),
                source,
            },
            other => other,
        })?;
        let auth_path = dir.join(AUTH_CONFIG_FILE);
        let auth_text =
            std::fs::read_to_string(&auth_path).map_err(|source| ConfigError::Read {
                path: auth_path.clone(),
                source,
            })?;
        let auth = parse_auth(&auth_text).map_err(|e| match e {
            ConfigError::Parse { source, .. } => ConfigError::Parse {
                path: auth_path.clone(),
                source,
            },
            other => other,
        })?;
        let auth = auth.auth.resolve(&app.mcp.path)?;
        let tools_path = dir.join(MCP_CONFIG_FILE);
        let tools_text =
            std::fs::read_to_string(&tools_path).map_err(|source| ConfigError::Read {
                path: tools_path.clone(),
                source,
            })?;
        let tools = parse_mcp_tools(&tools_text).map_err(|e| match e {
            ConfigError::Parse { source, .. } => ConfigError::Parse {
                path: tools_path.clone(),
                source,
            },
            other => other,
        })?;
        if tools.image.allow_insecure_loopback && auth.public_origin.starts_with("https://") {
            return Err(ConfigError::Invalid(
                "mcp.toml image.allow_insecure_loopback must not be enabled with an https profile"
                    .into(),
            ));
        }
        let abs_dir = std::path::absolute(dir).map_err(|source| ConfigError::Read {
            path: dir.to_path_buf(),
            source,
        })?;
        // Config directories follow the configs/<env>/ convention, so the
        // project root (base of relative paths like the DB or image_root) is
        // two levels up from the config directory itself.
        let root = abs_dir
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| abs_dir.clone());
        Ok(Self {
            app,
            auth,
            root,
            tools,
        })
    }

    /// Absolute path of the widget HTML (may not exist before a frontend build).
    pub fn widget_html_path(&self) -> PathBuf {
        self.resolve(&self.tools.widget.html_path)
    }

    /// Absolute path of the built frontend directory the backend serves.
    pub fn static_root(&self) -> PathBuf {
        self.resolve(&self.app.frontend.static_dir)
    }

    /// Absolute path of the SQLite database file.
    pub fn database_path(&self) -> PathBuf {
        self.resolve(&self.app.database.path)
    }

    /// Absolute path of the image storage root.
    pub fn image_root(&self) -> PathBuf {
        self.resolve(&self.app.maintenance.image_root)
    }

    fn resolve(&self, p: &Path) -> PathBuf {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        }
    }
}

/// Parse and validate the contents of `app.toml`.
pub fn parse_app(text: &str) -> Result<AppConfig, ConfigError> {
    let app: AppConfig = toml::from_str(text).map_err(|source| ConfigError::Parse {
        path: PathBuf::from(APP_CONFIG_FILE),
        source,
    })?;
    validate(&app)?;
    Ok(app)
}

/// Parse `auth.toml` (profile resolution and validation happen in
/// [`AuthSettings::resolve`]).
pub fn parse_auth(text: &str) -> Result<AuthFile, ConfigError> {
    toml::from_str(text).map_err(|source| ConfigError::Parse {
        path: PathBuf::from(AUTH_CONFIG_FILE),
        source,
    })
}

fn validate(app: &AppConfig) -> Result<(), ConfigError> {
    if app.server.hosts.is_empty() || app.server.hosts.iter().any(|h| h.trim().is_empty()) {
        return Err(ConfigError::Invalid(
            "server.hosts must list at least one non-empty bind address".into(),
        ));
    }
    if !app.mcp.path.starts_with('/') || app.mcp.path.len() < 2 {
        return Err(ConfigError::Invalid(
            "mcp.path must start with '/' and not be the root".into(),
        ));
    }
    if app.mcp.allowed_hosts.is_empty() {
        return Err(ConfigError::Invalid(
            "mcp.allowed_hosts must not be empty".into(),
        ));
    }
    if app.mcp.max_request_body_bytes == 0 {
        return Err(ConfigError::Invalid(
            "mcp.max_request_body_bytes must be positive".into(),
        ));
    }
    if app.database.max_connections == 0 {
        return Err(ConfigError::Invalid(
            "database.max_connections must be positive".into(),
        ));
    }
    if app.frontend.dev_port == app.server.port {
        return Err(ConfigError::Invalid(
            "frontend.dev_port must differ from server.port".into(),
        ));
    }
    if app.maintenance.cleanup_interval_secs == 0 {
        return Err(ConfigError::Invalid(
            "maintenance.cleanup_interval_secs must be positive".into(),
        ));
    }
    if app.data_io.max_payload_bytes == 0
        || app.data_io.max_receipts == 0
        || app.data_io.max_items_total == 0
    {
        return Err(ConfigError::Invalid(
            "data_io values must be positive".into(),
        ));
    }
    Ok(())
}

/// Canonical valid auth.toml used by the in-crate unit tests (cimd, mcp auth
/// and the config tests share one string).
#[cfg(test)]
pub(crate) const AUTH_VALID_TOML: &str = r#"
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
invite_ttl_hours = 168
recovery_ttl_hours = 1
recovery_ttl_max_hours = 24
register_ttl_hours = 168
share_ttl_hours = 168

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
"#;

/// Canonical valid mcp.toml used by the in-crate config tests (mirrors
/// configs/mcp.toml, which parse_mcp_tools validation must accept).
#[cfg(test)]
pub(crate) const MCP_VALID_TOML: &str = r#"
[limits]
max_items = 200
max_name_chars = 200
max_ledger_name_chars = 100
max_note_chars = 1000
search_default_limit = 20
search_max_limit = 50
max_query_chars = 200
stats_max_rows = 200
catalog_max_stores = 50
widget_refs_max = 20
drafts_default_limit = 20
drafts_max_limit = 50
max_label_title_chars = 20
max_label_batch = 50
batch_max_drafts = 10
batch_max_approve = 20

[image]
fetch_allowed_hosts = ["files.oaiusercontent.com", "*.oaiusercontent.com"]
fetch_timeout_secs = 20
max_download_bytes = 20971520
max_pixels = 50000000
resize_max_edge = 2048
webp_quality = 80.0
access_token_ttl_secs = 900
allow_insecure_loopback = false
batch_fetch_concurrency = 3
decode_concurrency = 2
batch_decode_concurrency = 1
batch_fetch_deadline_secs = 40

[widget]
html_path = "frontend/dist/widget.html"
"#;

/// Parse + resolve the canonical test auth.toml.
#[cfg(test)]
pub(crate) fn test_resolved_auth() -> ResolvedAuth {
    parse_auth(AUTH_VALID_TOML)
        .expect("auth parses")
        .auth
        .resolve("/mcp")
        .expect("resolve")
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID: &str = r#"
[server]
hosts = ["127.0.0.1"]
port = 0
shutdown_timeout_secs = 5

[mcp]
path = "/mcp"
allowed_hosts = ["localhost"]
max_request_body_bytes = 1024

[database]
path = "var/db/test.sqlite"
max_connections = 1
busy_timeout_ms = 100

[log]
filter = "info"

[frontend]
dev_port = 5173

[maintenance]
cleanup_interval_secs = 3600
image_root = "var/images"

[data_io]
max_payload_bytes = 67108864
max_receipts = 5000
max_items_total = 50000
"#;

    #[test]
    fn parses_valid_config() {
        let app = parse_app(VALID).expect("valid");
        assert_eq!(app.server.port, 0);
        assert_eq!(app.mcp.path, "/mcp");
        assert_eq!(app.database.max_connections, 1);
    }

    #[test]
    fn rejects_unknown_field() {
        let text = VALID.replace("port = 0", "port = 0\nunknown = 1");
        assert!(matches!(parse_app(&text), Err(ConfigError::Parse { .. })));
    }

    #[test]
    fn rejects_missing_section() {
        let text = VALID.replace("[log]\nfilter = \"info\"\n", "");
        assert!(matches!(parse_app(&text), Err(ConfigError::Parse { .. })));
    }

    #[test]
    fn rejects_invalid_mcp_path() {
        let text = VALID.replace("path = \"/mcp\"", "path = \"mcp\"");
        assert!(matches!(parse_app(&text), Err(ConfigError::Invalid(_))));
    }

    #[test]
    fn rejects_empty_allowed_hosts() {
        let text = VALID.replace("allowed_hosts = [\"localhost\"]", "allowed_hosts = []");
        assert!(matches!(parse_app(&text), Err(ConfigError::Invalid(_))));
    }

    #[test]
    fn resolves_relative_db_path_against_root() {
        let dir = tempfile::tempdir().unwrap();
        // configs/<env>/ convention: the project root is two levels above the
        // config directory.
        let cfg_dir = dir.path().join("configs/dev");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(cfg_dir.join(APP_CONFIG_FILE), VALID).unwrap();
        std::fs::write(cfg_dir.join(AUTH_CONFIG_FILE), AUTH_VALID_TOML).unwrap();
        std::fs::write(cfg_dir.join(MCP_CONFIG_FILE), MCP_VALID_TOML).unwrap();
        let cfg = Config::load(&cfg_dir).unwrap();
        assert_eq!(cfg.database_path(), dir.path().join("var/db/test.sqlite"));
    }

    #[test]
    fn missing_file_is_read_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            Config::load(dir.path()),
            Err(ConfigError::Read { .. })
        ));
    }

    // -----------------------------------------------------------------------
    // auth.toml (TASK-10 Phase A)

    fn resolve_auth(text: &str) -> Result<ResolvedAuth, ConfigError> {
        parse_auth(text)?.auth.resolve("/mcp")
    }

    // [covers:auth-config.parses-and-selects-profile]
    #[test]
    fn auth_parses_and_selects_profile() {
        let resolved = resolve_auth(AUTH_VALID_TOML).expect("valid");
        assert_eq!(resolved.profile, "dev");
        assert_eq!(resolved.rp_id, "localhost");
        assert_eq!(resolved.rp_origin, "http://localhost:40281");
        assert_eq!(resolved.public_origin, "http://localhost:40281");
        assert_eq!(resolved.resource, "http://localhost:40281/mcp");
        assert_eq!(resolved.session.idle_days, 14);
        assert_eq!(resolved.session.step_up_secs, 600);
        assert_eq!(resolved.invitation.recovery_ttl_hours, 1);
        assert_eq!(resolved.rate_limit.webauthn_per_minute, 20);
    }

    // [covers:auth-config.rejects-unknown-field]
    #[test]
    fn auth_rejects_unknown_field() {
        let text = AUTH_VALID_TOML.replace("profile = \"dev\"", "profile = \"dev\"\nunknown = 1");
        assert!(matches!(parse_auth(&text), Err(ConfigError::Parse { .. })));
    }

    // [covers:auth-config.rp-id-must-match-origin-host]
    #[test]
    fn auth_rp_id_must_match_origin_host() {
        let text = AUTH_VALID_TOML.replace("rp_id = \"localhost\"", "rp_id = \"example.com\"");
        assert!(matches!(resolve_auth(&text), Err(ConfigError::Invalid(_))));
    }

    // [covers:auth-config.resource-must-derive-from-public-origin]
    #[test]
    fn auth_resource_must_derive_from_public_origin() {
        for bad in [
            "\"http://localhost:40281/mcp/\"",
            "\"http://localhost:40281/other\"",
            "\"https://localhost:40281/mcp\"",
        ] {
            let text = AUTH_VALID_TOML.replace(
                "resource = \"http://localhost:40281/mcp\"",
                format!("resource = {bad}").as_str(),
            );
            assert!(
                matches!(resolve_auth(&text), Err(ConfigError::Invalid(_))),
                "resource {bad} should be rejected"
            );
        }
    }

    // [covers:auth-config.issuer-equals-public-origin]
    #[test]
    fn auth_issuer_equals_public_origin() {
        let mismatch = AUTH_VALID_TOML.replace(
            "issuer = \"http://localhost:40281\"",
            "issuer = \"http://localhost:9999\"",
        );
        assert!(matches!(
            resolve_auth(&mismatch),
            Err(ConfigError::Invalid(_))
        ));
        let trailing = AUTH_VALID_TOML.replace(
            "public_origin = \"http://localhost:40281\"\nissuer = \"http://localhost:40281\"\nresource = \"http://localhost:40281/mcp\"",
            "public_origin = \"http://localhost:40281/\"\nissuer = \"http://localhost:40281/\"\nresource = \"http://localhost:40281//mcp\"",
        );
        assert!(matches!(
            resolve_auth(&trailing),
            Err(ConfigError::Invalid(_))
        ));
        let with_path = AUTH_VALID_TOML.replace(
            "rp_origin = \"http://localhost:40281\"",
            "rp_origin = \"http://localhost:40281/app\"",
        );
        assert!(matches!(
            resolve_auth(&with_path),
            Err(ConfigError::Invalid(_))
        ));
    }

    // [covers:auth-config.missing-profile-section-fails]
    #[test]
    fn auth_missing_profile_section_fails() {
        let text = AUTH_VALID_TOML.replace("profile = \"dev\"", "profile = \"prod\"");
        assert!(matches!(resolve_auth(&text), Err(ConfigError::Invalid(_))));
    }

    // [covers:auth-config.dev-loopback-flag-rejected-on-https]
    #[test]
    fn auth_dev_loopback_flag_rejected_on_https() {
        let text = AUTH_VALID_TOML.replace(
            "allow_insecure_loopback = false",
            "allow_insecure_loopback = true",
        );
        // the dev profile is http on loopback, so the flag is accepted here
        assert!(resolve_auth(&text).is_ok());
        // but an https profile refuses it
        let https = text
            .replace("http://localhost:40281", "https://book.example.com")
            .replace("rp_id = \"localhost\"", "rp_id = \"book.example.com\"");
        assert!(matches!(resolve_auth(&https), Err(ConfigError::Invalid(_))));
    }
}
