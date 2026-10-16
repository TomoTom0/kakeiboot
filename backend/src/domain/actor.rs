//! The acting principal of a domain operation (spec_mcp-tools.md 12): MCP
//! tool calls and web API calls pass the same `Actor`, and the audit trail
//! records its kind (`web` / `mcp` / `mcp_anonymous` / `system`).

/// How the operation reached the domain layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorKind {
    /// Web UI with a validated session (no OAuth client).
    Web,
    /// MCP tool call through an OAuth grant.
    Mcp { client_id: String, grant_id: i64 },
}

impl ActorKind {
    /// The `audit_events.actor_kind` value (spec_data-model.md 8).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Mcp { .. } => "mcp",
        }
    }

    /// The OAuth client id, when the actor is an MCP grant.
    pub fn client_id(&self) -> Option<&str> {
        match self {
            Self::Web => None,
            Self::Mcp { client_id, .. } => Some(client_id),
        }
    }
}

/// Who performs a domain operation (spec_mcp-tools.md 12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub user_id: i64,
    pub kind: ActorKind,
}

impl Actor {
    /// A web-session user.
    pub fn web(user_id: i64) -> Self {
        Self {
            user_id,
            kind: ActorKind::Web,
        }
    }

    /// An MCP grant (client assertion verified, token issued).
    pub fn mcp(user_id: i64, client_id: &str, grant_id: i64) -> Self {
        Self {
            user_id,
            kind: ActorKind::Mcp {
                client_id: client_id.to_string(),
                grant_id,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_map_to_audit_values() {
        assert_eq!(Actor::web(1).kind.as_str(), "web");
        let mcp = Actor::mcp(2, "https://chatgpt.com/a", 7);
        assert_eq!(mcp.kind.as_str(), "mcp");
        assert_eq!(
            ActorKind::client_id(&mcp.kind),
            Some("https://chatgpt.com/a")
        );
        assert_eq!(ActorKind::client_id(&Actor::web(1).kind), None);
    }
}
