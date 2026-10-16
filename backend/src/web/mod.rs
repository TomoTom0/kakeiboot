//! web adapter (spec_mcp-tools.md 12): the auxiliary-data REST API and the
//! static frontend serving. Handlers share the `domain::*` functions with
//! the MCP tools; session / CSRF / role checks live here, scope checks in
//! the MCP adapter.

pub mod api;
pub mod media;
pub mod static_files;
