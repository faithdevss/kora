//! The Tauri command surface.
//!
//! This is the entire privileged boundary between the webview and the machine,
//! so every argument arriving here is treated as untrusted (master plan,
//! Security #2). Each command validates its own inputs before touching the
//! process layer; none of them interpolate anything into a shell.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::adapters::{adapter_for, PermissionDecision};
use crate::proc::manager::SessionManager;

/// Longest session id we will accept from the frontend.
const MAX_SESSION_ID: usize = 64;
/// Longest single prompt, as a crude guard against a runaway webview.
const MAX_PROMPT_BYTES: usize = 1_000_000;

/// Session ids are minted by the frontend (`s1`, `s2`, …). Accept only that
/// shape so an id can never be smuggled into a path or an argv entry.
fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_SESSION_ID {
        return Err("invalid session id".into());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid session id".into());
    }
    Ok(())
}

/// Resolve and check the working directory the agent will run in.
fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
    if cwd.is_empty() {
        return Err("workspace path is empty".into());
    }
    let path = Path::new(cwd);
    // Canonicalize so `..` segments cannot point the agent somewhere the caller
    // did not name, and so a non-existent path fails here rather than at spawn.
    let resolved = path
        .canonicalize()
        .map_err(|_| format!("workspace does not exist: {cwd}"))?;
    if !resolved.is_dir() {
        return Err(format!("workspace is not a directory: {cwd}"));
    }
    Ok(resolved)
}

/// What the wrapped CLI will pick up from the workspace on its own.
///
/// The files to look for come from the adapter, so a second agent declares its
/// own (`AGENTS.md`, `.codex/config.toml`, …) without touching this file.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkspaceConfig {
    /// Human-readable labels for the markers that were found, ready to print.
    pub labels: Vec<String>,
}

impl WorkspaceConfig {
    fn detect(agent_id: &str, dir: &Path) -> Self {
        let Some(adapter) = adapter_for(agent_id) else {
            return Self::default();
        };
        Self {
            labels: adapter
                .workspace_markers()
                .iter()
                .filter(|m| dir.join(m.file).is_file())
                .map(|m| m.label.to_string())
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SpawnResult {
    /// The agent's conversation id, needed to resume after a crash.
    pub agent_uuid: String,
    /// Config files the agent inherits from the workspace, for the banner.
    pub workspace: WorkspaceConfig,
    /// Resolved absolute workspace path.
    pub cwd: String,
}

/// Start an agent for a session. Replaces any process already attached to it.
#[tauri::command]
pub async fn agent_spawn(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    agent_id: String,
    cwd: String,
    model: Option<String>,
) -> Result<SpawnResult, String> {
    validate_session_id(&session_id)?;
    let dir = validate_cwd(&cwd)?;
    let cwd = dir.to_string_lossy().to_string();

    let agent_uuid = manager
        .spawn(&session_id, &agent_id, &cwd, model, None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(SpawnResult {
        agent_uuid,
        workspace: WorkspaceConfig::detect(&agent_id, &dir),
        cwd,
    })
}

/// Restart a crashed session, restoring its conversation via the agent's own
/// resume mechanism. Falls back to a fresh conversation if resume fails.
#[tauri::command]
pub async fn agent_respawn(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    agent_id: String,
    cwd: String,
    model: Option<String>,
    resume_uuid: Option<String>,
) -> Result<SpawnResult, String> {
    validate_session_id(&session_id)?;
    let dir = validate_cwd(&cwd)?;
    let cwd = dir.to_string_lossy().to_string();

    let mut resumed = resume_uuid.clone();
    if let Some(u) = &resumed {
        // Reject anything that is not a plain uuid before it becomes an argv entry.
        if uuid::Uuid::parse_str(u).is_err() {
            resumed = None;
        }
    }

    let agent_uuid = match manager
        .spawn(&session_id, &agent_id, &cwd, model.clone(), resumed.clone())
        .await
    {
        Ok(uuid) => uuid,
        // Resume can fail if the agent has forgotten the conversation; a fresh
        // session is better than a dead pane, and the UI says which it got.
        Err(e) if resumed.is_some() => {
            manager
                .spawn(&session_id, &agent_id, &cwd, model, None)
                .await
                .map_err(|_| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };

    Ok(SpawnResult {
        agent_uuid,
        workspace: WorkspaceConfig::detect(&agent_id, &dir),
        cwd,
    })
}

/// Send a user turn to a running agent.
#[tauri::command]
pub async fn agent_write(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("prompt is too large to send".into());
    }
    manager.send_prompt(&session_id, &prompt).await
}

/// Answer a permission request raised by the agent.
#[tauri::command]
pub async fn agent_permission(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    tool: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<bool, String> {
    validate_session_id(&session_id)?;
    manager
        .answer_permission(&session_id, &tool, &request_id, decision)
        .await
}

/// Ask the agent to stop generating.
#[tauri::command]
pub async fn agent_interrupt(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<bool, String> {
    validate_session_id(&session_id)?;
    manager.interrupt(&session_id).await
}

/// End a session's process. Idempotent.
#[tauri::command]
pub async fn agent_kill(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    manager.kill(&session_id).await;
    Ok(())
}

/// Whether an agent id has a real implementation in this build.
#[tauri::command]
pub fn agent_is_connected(agent_id: String) -> bool {
    adapter_for(&agent_id).is_some()
}

/// The directory Kora was opened in, used as the default workspace.
#[tauri::command]
pub fn workspace_dir() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_restricted_to_a_safe_alphabet() {
        for ok in ["s1", "s-2", "s_3", "abc123"] {
            assert!(validate_session_id(ok).is_ok(), "{ok} should be accepted");
        }
        for bad in [
            "",
            "s 1",
            "../../etc/passwd",
            "s1;rm -rf /",
            "s1\n",
            "s1$(whoami)",
            &"x".repeat(65),
        ] {
            assert!(validate_session_id(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn cwd_must_exist_and_be_a_directory() {
        assert!(validate_cwd("").is_err());
        assert!(validate_cwd("/definitely/not/here/at/all").is_err());

        let tmp = std::env::temp_dir();
        assert!(validate_cwd(&tmp.to_string_lossy()).is_ok());

        let file = tmp.join("kora-cwd-test.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_cwd(&file.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn cwd_is_canonicalized_so_dot_dot_cannot_redirect_the_agent() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let sneaky = format!("{}/./../{}", tmp.display(), tmp.file_name().unwrap().to_string_lossy());
        let resolved = validate_cwd(&sneaky).unwrap();
        assert_eq!(resolved, tmp);
    }

    #[test]
    fn workspace_config_reports_only_the_markers_that_exist() {
        let dir = std::env::temp_dir().join(format!("kora-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(WorkspaceConfig::detect("claude", &dir).labels.is_empty());

        std::fs::write(dir.join("CLAUDE.md"), b"# memory").unwrap();
        assert_eq!(
            WorkspaceConfig::detect("claude", &dir).labels,
            vec!["project CLAUDE.md"]
        );

        std::fs::write(dir.join(".mcp.json"), b"{}").unwrap();
        assert_eq!(
            WorkspaceConfig::detect("claude", &dir).labels,
            vec!["project CLAUDE.md", ".mcp.json"]
        );

        // An agent with no adapter has no markers to look for.
        assert!(WorkspaceConfig::detect("codex", &dir).labels.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_agents_with_a_real_adapter_report_connected() {
        assert!(agent_is_connected("claude".into()));
        for stub in ["codex", "gemini", "cursor", "aider", "generic", ""] {
            assert!(!agent_is_connected(stub.into()), "{stub} must not claim to be connected");
        }
    }
}
