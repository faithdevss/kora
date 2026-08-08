//! Git integration — **interface only, not implemented in v1**.
//!
//! The agents Kora wraps already run git themselves, with the user's own
//! credentials and hooks, and Kora's job is to show what they did rather than
//! to become a second git client. So the shape below is deliberately read-only:
//! branch, dirty state, and the diff a transcript is talking about.
//!
//! Anything that writes (commit, push, checkout) stays with the agent, where
//! the user can see and approve it as a tool call.

use serde::{Deserialize, Serialize};

/// The workspace's git state, as a status line would show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoStatus {
    pub branch: String,
    /// Files with uncommitted changes.
    pub dirty: usize,
    pub ahead: usize,
    pub behind: usize,
}

/// What a future git integration would expose.
///
/// Read-only by design; see the module note. Nothing implements this yet, and
/// no Tauri command reaches it.
pub trait GitProvider: Send + Sync {
    /// Status of the repository containing `cwd`, or `None` if it is not one.
    fn status(&self, cwd: &str) -> Option<RepoStatus>;

    /// The working-tree diff, for rendering in the transcript's diff viewer.
    fn working_diff(&self, cwd: &str) -> Option<String>;
}
