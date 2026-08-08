//! MCP server management — **interface only, not implemented in v1**.
//!
//! Today Kora reports how many MCP servers the wrapped CLI picked up from the
//! workspace (`AgentEvent::Ready.mcp_servers`) and nothing more: the servers are
//! the agent's, configured in the agent's own `.mcp.json`, and Kora deliberately
//! does not reach into that file.
//!
//! If Kora ever manages them, this is the shape it should take — a view over
//! what the *agent* reports, plus explicit enable/disable, never a second
//! source of truth for MCP configuration.

use serde::{Deserialize, Serialize};

/// One MCP server, as an agent reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// Where the agent found it: `project`, `user`, `builtin`.
    pub scope: String,
    pub enabled: bool,
    /// Tools it exposes, when the agent says.
    pub tools: Vec<String>,
}

/// What an agent adapter would implement to expose its MCP servers.
///
/// Not wired to anything: no adapter implements it, and no Tauri command calls
/// it. Adding support means implementing this for one adapter and adding the
/// commands then — not changing this file's shape under a live feature.
pub trait McpProvider: Send + Sync {
    /// Servers this agent has configured, as it reports them.
    fn list_servers(&self) -> Vec<McpServer>;

    /// Ask the agent to enable or disable one for the current session.
    ///
    /// Returns the line to send on stdin, or `None` for agents that cannot be
    /// asked — the same passthrough principle the rest of Kora follows.
    fn set_server_enabled(&self, _name: &str, _enabled: bool) -> Option<String> {
        None
    }
}
