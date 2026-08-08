//! Agent adapters.
//!
//! An adapter is the *only* place that knows how one particular coding-agent CLI
//! is launched and how its output maps onto Kora's transcript. Everything else —
//! the process manager, the Tauri commands, the whole frontend — is written
//! against [`AgentAdapter`] and never against a specific agent.
//!
//! # Adding a second real agent
//!
//! Implement [`AgentAdapter`] in a new file in this module, register it in
//! [`registry`], and you are done. In particular you should NOT need to touch:
//!
//! - `proc::manager` — it spawns whatever [`SpawnSpec`] you return, pumps the
//!   child's stdout line-by-line, and hands each line back to your
//!   [`AgentAdapter::parse_line`].
//! - `commands.rs` — the Tauri surface is agent-agnostic.
//! - Any TypeScript — the frontend consumes [`AgentEvent`], not agent-specific
//!   shapes.
//!
//! The contract is deliberately line-oriented: the manager owns process
//! lifetime, the adapter owns interpretation. Adapter instances are long-lived
//! and shared across sessions (see [`registry`]), so an agent that must
//! accumulate across lines — reassembling a split frame, correlating a call id —
//! can hold that state in its own struct behind its own synchronisation, keyed
//! by session. `parse_line` takes `&self` for exactly this reason.

pub mod claude;

use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};

/// How to launch one session of an agent.
///
/// Built by [`AgentAdapter::spawn_spec`] and executed by the process manager.
/// `args` is an argv array — never a shell string — so a crafted path or model
/// name cannot inject shell syntax (master plan, Security #4).
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    /// Executable name or absolute path. Resolved on `$PATH` by the OS.
    pub program: String,
    pub args: Vec<String>,
    /// Working directory the agent runs in.
    pub cwd: String,
    /// Extra environment for the child, on top of the inherited environment.
    pub env: Vec<(String, String)>,
}

/// Why a session is being (re)spawned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnMode {
    /// A brand new conversation.
    Fresh,
    /// Recover a conversation after a crash, keeping prior context.
    Resume,
}

/// A capability an agent may or may not support, so the UI can adapt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Emits partial output as it is produced, rather than one blob per turn.
    Streaming,
    /// Reports real token usage per turn.
    Usage,
    /// Reports real cost per turn.
    Cost,
    /// Can be asked to approve/deny individual tool calls.
    PermissionPrompts,
    /// Can be interrupted mid-generation.
    Interrupt,
    /// Can restore a prior conversation by id.
    Resume,
}

/// One thing that happened in a session, as the frontend sees it.
///
/// This is the entire vocabulary between Rust and TypeScript. Adapters map
/// their agent's native output onto these; the frontend maps these onto
/// Phase 1's transcript line types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Session is up, or has told us more about itself.
    ///
    /// May arrive more than once — first from the handshake, then again when the
    /// agent reports per-turn details. Fields it does not know are `None` so a
    /// later, better-informed event never clobbers an earlier one.
    Ready {
        /// The agent's own session id, used for resume.
        agent_session_id: Option<String>,
        model: Option<String>,
        /// Number of MCP servers the agent picked up from the workspace.
        mcp_servers: Option<usize>,
        /// Slash commands the agent itself provides.
        commands: Vec<AgentCommand>,
    },
    /// A chunk of assistant prose. Emitted repeatedly while streaming.
    Delta { text: String },
    /// The assistant's message for this turn is complete.
    MessageDone,
    /// The agent used a tool. `detail` is a one-line human summary.
    Tool { name: String, detail: String },
    /// The agent wants permission to use a tool.
    Permission {
        request_id: String,
        tool: String,
        detail: String,
        /// What approving would actually grant.
        scope: PermissionScope,
    },
    /// A turn finished. Usage numbers are real when the agent reports them.
    TurnEnd {
        text: String,
        usage: Option<Usage>,
        /// Whether the agent reported this turn as an error.
        is_error: bool,
    },
    /// The models this agent will accept, reported by the live CLI.
    Models { models: Vec<ModelInfo> },
    /// Rolling rate-limit / quota utilization, when the agent exposes it.
    RateLimit {
        /// e.g. "seven_day".
        window: String,
        /// 0.0–1.0.
        utilization: f64,
        /// Unix seconds.
        resets_at: Option<i64>,
    },
    /// Context was compacted by the agent itself.
    Compacted,
    /// Informational agent output that is not assistant prose.
    Notice { text: String },
    /// Something went wrong but the session is still alive.
    Error { message: String },
    /// The process exited. `recoverable` means a resume is worth offering.
    Exited { code: Option<i32>, recoverable: bool },
}

/// A slash command an agent provides natively.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
}

/// Real token usage for one turn.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Cumulative cost for the session so far, in USD, if reported. Confirmed
    /// cumulative rather than per-turn by the Phase 2 spike's multi-turn run,
    /// which is why the store replaces this value rather than adding to it.
    pub total_cost_usd: Option<f64>,
    /// The model's real context window, if reported.
    pub context_window: Option<u64>,
}

impl Usage {
    /// Tokens occupying the context window after this turn.
    pub fn context_used(&self) -> u64 {
        self.input_tokens + self.cache_read_tokens + self.cache_creation_tokens + self.output_tokens
    }
}

/// How to answer a [`AgentEvent::Permission`] request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// What granting a permission actually covers.
///
/// Agents differ: some gate each call, some can only widen permissions for a
/// whole session. The UI labels the approve action from this, so it never
/// promises a narrower grant than the agent can deliver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionScope {
    /// This one call only.
    Once,
    /// Every file edit for the rest of the session.
    SessionEdits,
    /// Every tool for the rest of the session.
    SessionAll,
}

/// Who an account belongs to, as the agent itself reports it.
///
/// Deliberately contains nothing secret: Kora never holds a credential, so this
/// is the whole of what it knows about an account (Phase 3 spike decision).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountIdentity {
    pub logged_in: bool,
    /// e.g. `"claude.ai"` for a subscription login, `"apiKey"` for a key.
    pub auth_method: String,
    pub email: Option<String>,
    pub org_name: Option<String>,
    /// e.g. `"pro"`, `"max"`. Absent for API-key auth.
    pub subscription: Option<String>,
}

impl AccountIdentity {
    /// Whether per-token pricing would misrepresent what this account pays.
    ///
    /// Subscription users are billed a flat fee, so a dollar figure derived from
    /// token counts is an API-equivalent estimate, never actual spend.
    pub fn is_subscription(&self) -> bool {
        self.subscription.is_some() || self.auth_method == "claude.ai"
    }
}

/// A model the agent will actually accept, as reported by the live CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    /// The value to pass to `--model` / `/model`.
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// The concrete model an alias resolves to, when the agent says.
    pub resolved: Option<String>,
}

/// A file whose presence in the workspace is worth telling the user about,
/// because the wrapped CLI picks it up on its own.
#[derive(Debug, Clone, Copy)]
pub struct WorkspaceMarker {
    /// Filename, relative to the workspace root.
    pub file: &'static str,
    /// How to describe it, e.g. `"project CLAUDE.md"`.
    pub label: &'static str,
}

/// Everything Kora needs to drive one kind of agent CLI.
///
/// One instance serves every session for that agent, so any state must be
/// internally synchronised and keyed by session.
pub trait AgentAdapter: Send + Sync {
    /// Stable id, matching the frontend's agent id (e.g. `"claude"`).
    fn id(&self) -> &'static str;

    /// Human-readable name, for error messages.
    fn name(&self) -> &'static str;

    /// The executable this adapter needs on `$PATH`.
    ///
    /// Returns an owned string so an implementation can honour an override
    /// (a non-standard install location, or a stub binary under test).
    fn program(&self) -> String;

    /// What this agent can do, so the UI can hide what it cannot.
    fn capabilities(&self) -> &'static [Capability];

    /// Build the launch spec for a session.
    ///
    /// `session_uuid` is generated by Kora, not the agent, so that resume works
    /// without having to scrape an id out of the agent's output first.
    fn spawn_spec(
        &self,
        cwd: &str,
        session_uuid: &str,
        model: Option<&str>,
        mode: SpawnMode,
    ) -> SpawnSpec;

    /// Text to send on stdin to start a turn with `prompt`.
    fn encode_prompt(&self, prompt: &str) -> String;

    /// Text to send on stdin right after spawn, before any prompt.
    ///
    /// Used for protocol handshakes. Return an empty vec if the agent needs none.
    fn handshake(&self) -> Vec<String>;

    /// Lines to send on stdin to answer a permission request.
    ///
    /// A list rather than one line because some agents need several steps —
    /// Claude Code, for instance, must be granted the permission and then asked
    /// to retry, since it refuses and reports rather than waiting for an answer.
    /// Returning an empty list means the answer is purely local (a denial).
    fn encode_permission_reply(
        &self,
        tool: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Vec<String>;

    /// Workspace files this agent reads on its own, for the session banner.
    fn workspace_markers(&self) -> &'static [WorkspaceMarker];

    /* ---- accounts ---- */

    /// Environment that scopes a spawn to one account's credentials.
    ///
    /// Kora passes a directory it owns; the agent stores its own credential
    /// there. Nothing secret passes through Kora, which is why this returns a
    /// path rather than a token (master plan, Security #6).
    fn account_env(&self, profile_dir: &str) -> Vec<(String, String)>;

    /// argv that prints this agent's auth status, if it can.
    fn auth_status_argv(&self) -> Option<Vec<String>>;

    /// Interpret the output of [`Self::auth_status_argv`].
    fn parse_auth_status(&self, stdout: &str) -> Option<AccountIdentity>;

    /// argv that starts an interactive login. Kora runs it in a terminal.
    fn login_argv(&self) -> Option<Vec<String>>;

    /// A stdin line asking the agent for its model list, if it supports that.
    fn list_models_request(&self) -> Option<String>;

    /// Text to send on stdin to interrupt generation, if supported.
    fn encode_interrupt(&self) -> Option<String>;

    /// Interpret one line of the agent's stdout.
    ///
    /// Returns any number of events, including none — most protocol chatter maps
    /// to nothing the user should see. Must never panic on malformed input: a
    /// line that cannot be understood should produce no events, not an error.
    fn parse_line(&self, line: &str) -> Vec<AgentEvent>;
}

/// The adapters Kora knows about.
///
/// Only agents with a real implementation appear here. Everything else in the
/// frontend's agent list is a UI-only stub and is reported as not connected.
///
/// Instances are long-lived and shared, so an adapter may hold per-session parse
/// state internally (behind its own synchronisation) rather than being rebuilt
/// on every line.
pub fn registry() -> &'static [Arc<dyn AgentAdapter>] {
    static REGISTRY: OnceLock<Vec<Arc<dyn AgentAdapter>>> = OnceLock::new();
    REGISTRY.get_or_init(|| vec![Arc::new(claude::ClaudeAdapter)])
}

/// Look up an adapter by frontend agent id.
pub fn adapter_for(agent_id: &str) -> Option<Arc<dyn AgentAdapter>> {
    registry().iter().find(|a| a.id() == agent_id).cloned()
}

/// Names of the agents that actually run in this build, for user-facing copy.
pub fn connected_agent_names() -> Vec<&'static str> {
    registry().iter().map(|a| a.name()).collect()
}
