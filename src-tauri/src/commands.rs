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

use crate::accounts::store::AccountStore;
use crate::accounts::Account;
use crate::adapters::{adapter_for, AccountIdentity, PermissionDecision};
use crate::proc::manager::SessionManager;
use crate::store::{sessions, usage, Db};

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
    /// The account this session is running under, if any is configured.
    pub account: Option<Account>,
}

/// Start an agent for a session. Replaces any process already attached to it.
#[tauri::command]
pub async fn agent_spawn(
    manager: State<'_, Arc<SessionManager>>,
    accounts: State<'_, Arc<AccountStore>>,
    session_id: String,
    agent_id: String,
    cwd: String,
    model: Option<String>,
) -> Result<SpawnResult, String> {
    validate_session_id(&session_id)?;
    let dir = validate_cwd(&cwd)?;
    let cwd = dir.to_string_lossy().to_string();
    let account = accounts.active(&agent_id).await;
    let profile_dir = account.as_ref().map(|a| a.dir.clone());

    let agent_uuid = manager
        .spawn(&session_id, &agent_id, &cwd, model, None, profile_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(SpawnResult {
        agent_uuid,
        workspace: WorkspaceConfig::detect(&agent_id, &dir),
        cwd,
        account,
    })
}

/// Restart a crashed session, restoring its conversation via the agent's own
/// resume mechanism. Falls back to a fresh conversation if resume fails.
#[tauri::command]
pub async fn agent_respawn(
    manager: State<'_, Arc<SessionManager>>,
    accounts: State<'_, Arc<AccountStore>>,
    session_id: String,
    agent_id: String,
    cwd: String,
    model: Option<String>,
    resume_uuid: Option<String>,
) -> Result<SpawnResult, String> {
    validate_session_id(&session_id)?;
    let dir = validate_cwd(&cwd)?;
    let cwd = dir.to_string_lossy().to_string();
    let profile_dir = accounts.active(&agent_id).await.map(|a| a.dir);

    let mut resumed = resume_uuid.clone();
    if let Some(u) = &resumed {
        // Reject anything that is not a plain uuid before it becomes an argv entry.
        if uuid::Uuid::parse_str(u).is_err() {
            resumed = None;
        }
    }

    let agent_uuid = match manager
        .spawn(&session_id, &agent_id, &cwd, model.clone(), resumed.clone(), profile_dir.clone())
        .await
    {
        Ok(uuid) => uuid,
        // Resume can fail if the agent has forgotten the conversation; a fresh
        // session is better than a dead pane, and the UI says which it got.
        Err(e) if resumed.is_some() => {
            manager
                .spawn(&session_id, &agent_id, &cwd, model, None, profile_dir)
                .await
                .map_err(|_| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };

    Ok(SpawnResult {
        agent_uuid,
        workspace: WorkspaceConfig::detect(&agent_id, &dir),
        cwd,
        account: accounts.active(&agent_id).await,
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

/* ---------------- accounts ---------------- */

/// Accounts configured for an agent.
#[tauri::command]
pub async fn accounts_list(
    accounts: State<'_, Arc<AccountStore>>,
    agent_id: String,
) -> Result<Vec<Account>, String> {
    Ok(accounts.list(&agent_id).await)
}

/// The account new sessions for an agent will use.
#[tauri::command]
pub async fn accounts_active(
    accounts: State<'_, Arc<AccountStore>>,
    agent_id: String,
) -> Result<Option<Account>, String> {
    Ok(accounts.active(&agent_id).await)
}

/// Create an account and its (empty, unauthenticated) profile directory.
#[tauri::command]
pub async fn accounts_add(
    accounts: State<'_, Arc<AccountStore>>,
    agent_id: String,
    name: String,
) -> Result<Account, String> {
    accounts.add(&agent_id, &name).await
}

#[tauri::command]
pub async fn accounts_rename(
    accounts: State<'_, Arc<AccountStore>>,
    account_id: String,
    name: String,
) -> Result<(), String> {
    accounts.rename(&account_id, &name).await
}

/// Forget an account, deleting its profile directory and the agent's
/// credentials inside it.
#[tauri::command]
pub async fn accounts_remove(
    accounts: State<'_, Arc<AccountStore>>,
    account_id: String,
) -> Result<(), String> {
    accounts.remove(&account_id).await
}

/// Choose which account new sessions use.
#[tauri::command]
pub async fn accounts_switch(
    accounts: State<'_, Arc<AccountStore>>,
    agent_id: String,
    account_id: String,
) -> Result<(), String> {
    accounts.set_active(&agent_id, &account_id).await
}

/// Ask the agent who is signed in to an account, and record the answer.
#[tauri::command]
pub async fn accounts_refresh(
    accounts: State<'_, Arc<AccountStore>>,
    account_id: String,
) -> Result<Option<AccountIdentity>, String> {
    accounts.refresh_identity(&account_id).await
}

/// The command the user should run to sign this account in.
///
/// Login is interactive (it opens a browser), so Kora reports the command and
/// its environment rather than trying to drive it — and the credential it
/// produces belongs to the agent, never to Kora.
#[tauri::command]
pub async fn accounts_login_command(
    accounts: State<'_, Arc<AccountStore>>,
    account_id: String,
) -> Result<String, String> {
    let (program, argv, env) = accounts.login_command(&account_id).await?;
    let env = env
        .into_iter()
        .map(|(k, v)| format!("{k}={v} "))
        .collect::<String>();
    Ok(format!("{env}{program} {}", argv.join(" ")))
}

/* ---------------- sessions ---------------- */

#[tauri::command]
pub async fn sessions_list(
    db: State<'_, Db>,
    include_archived: bool,
) -> Result<Vec<sessions::SessionMeta>, String> {
    sessions::list(&db, include_archived).await
}

#[tauri::command]
pub async fn sessions_save(
    db: State<'_, Db>,
    meta: sessions::SessionMeta,
    lines: Vec<serde_json::Value>,
) -> Result<(), String> {
    validate_session_id(&meta.id)?;
    let id = meta.id.clone();
    sessions::upsert(&db, meta).await?;
    sessions::save_lines(&db, &id, &lines).await
}

#[tauri::command]
pub async fn sessions_lines(
    db: State<'_, Db>,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    validate_session_id(&session_id)?;
    sessions::lines(&db, &session_id).await
}

#[tauri::command]
pub async fn sessions_delete(db: State<'_, Db>, session_id: String) -> Result<(), String> {
    validate_session_id(&session_id)?;
    sessions::delete(&db, &session_id).await
}

#[tauri::command]
pub async fn sessions_rename(
    db: State<'_, Db>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    sessions::rename(&db, &session_id, &name).await
}

#[tauri::command]
pub async fn sessions_set_flags(
    db: State<'_, Db>,
    session_id: String,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    sessions::set_flags(&db, &session_id, pinned, archived).await
}

/// Export a session as JSON text, for the caller to write wherever it likes.
#[tauri::command]
pub async fn sessions_export(db: State<'_, Db>, session_id: String) -> Result<String, String> {
    validate_session_id(&session_id)?;
    let export = sessions::export(&db, &session_id).await?;
    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

/// Writes a session export to `path`, and returns where it landed.
///
/// The frontend has no filesystem access of its own, so the write happens here.
/// `path` is taken literally apart from a leading `~`; an empty path means
/// Kora's own exports directory.
#[tauri::command]
pub async fn sessions_export_file(
    db: State<'_, Db>,
    session_id: String,
    path: Option<String>,
) -> Result<String, String> {
    validate_session_id(&session_id)?;
    let export = sessions::export(&db, &session_id).await?;
    let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;

    let target = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => expand_tilde(p),
        None => crate::store::data_dir()
            .join("exports")
            .join(format!("{}.kora.json", safe_file_stem(&export.meta.name))),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, json).map_err(|e| format!("could not write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

/// Imports a session from a file written by [`sessions_export_file`].
#[tauri::command]
pub async fn sessions_import_file(
    db: State<'_, Db>,
    path: String,
) -> Result<sessions::SessionMeta, String> {
    let target = expand_tilde(path.trim());
    let json = std::fs::read_to_string(&target)
        .map_err(|e| format!("could not read {}: {e}", target.display()))?;
    let parsed: sessions::SessionExport =
        serde_json::from_str(&json).map_err(|e| format!("not a Kora session export: {e}"))?;
    sessions::import(&db, parsed).await
}

/// `~/x` → `$HOME/x`. Anything else is used as given.
fn expand_tilde(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "~".into())).join(rest),
        None => PathBuf::from(path),
    }
}

/// A session name reduced to something safe to use as a filename.
fn safe_file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let stem = stem.trim_matches('-').to_string();
    if stem.is_empty() {
        "session".into()
    } else {
        stem
    }
}

#[tauri::command]
pub async fn sessions_import(
    db: State<'_, Db>,
    json: String,
) -> Result<sessions::SessionMeta, String> {
    let parsed: sessions::SessionExport =
        serde_json::from_str(&json).map_err(|e| format!("not a Kora session export: {e}"))?;
    sessions::import(&db, parsed).await
}

/* ---------------- usage ---------------- */

/// Rolling seven-day totals for an account, from Kora's own record.
#[tauri::command]
pub async fn usage_week(
    db: State<'_, Db>,
    account_id: Option<String>,
) -> Result<usage::Totals, String> {
    usage::week(&db, account_id.as_deref()).await
}

/// Record one turn's real usage.
#[tauri::command]
pub async fn usage_record(
    db: State<'_, Db>,
    agent_id: String,
    account_id: Option<String>,
    model: Option<String>,
    turn: crate::adapters::Usage,
) -> Result<bool, String> {
    usage::record(&db, &agent_id, account_id.as_deref(), model.as_deref(), &turn).await
}
