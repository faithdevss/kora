//! Spawns, tracks, and tears down one child process per Kora session.
//!
//! Agent-agnostic: everything specific to a particular CLI lives behind
//! [`crate::adapters::AgentAdapter`]. The manager owns process lifetime and the
//! stdout pump; the adapter owns interpretation of what comes back.
//!
//! # Lifetime design
//!
//! Each session has three tasks and one supervisor:
//!
//! - a **supervisor** that owns the [`Child`] and awaits `wait()`. Exit is
//!   detected from the child itself, never from stdout EOF — `claude` hands its
//!   stdout pipe to tools and MCP servers it spawns, so the pipe can outlive the
//!   agent and EOF would never arrive.
//! - a **stdout pump** that parses lines into events.
//! - a **stderr pump** that surfaces diagnostics.
//!
//! No lock on the sessions map is ever held across an await on the child or
//! its pipes — stdin has its own per-session lock — so a wedged agent cannot
//! stall unrelated sessions or the quit path.
//!
//! Children are put in their own process group, so killing a session takes its
//! tool subprocesses and MCP servers with it rather than orphaning them.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use crate::adapters::{adapter_for, AgentEvent, PermissionDecision, SpawnMode};

/// Tauri event name carrying every [`AgentEvent`] to the frontend.
pub const EVENT_NAME: &str = "agent://event";

/// How long a closed stdin is given to end the process before it is signalled.
const GRACEFUL_EXIT: std::time::Duration = std::time::Duration::from_millis(500);

/// One [`AgentEvent`] tagged with the session it belongs to.
#[derive(Debug, Clone, Serialize)]
pub struct SessionEvent {
    pub session_id: String,
    #[serde(flatten)]
    pub event: AgentEvent,
}

/// Anything the frontend can be told went wrong.
#[derive(Debug)]
pub enum SpawnError {
    /// The agent has no real implementation yet.
    NotConnected(String),
    /// The CLI is not installed / not on `$PATH`.
    NotInstalled { program: String, agent: String },
    /// Anything else, already human-readable.
    Other(String),
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConnected(agent) => write!(
                f,
                "{agent} is not connected yet — Kora can select it in the UI, but it has no adapter in this build."
            ),
            Self::NotInstalled { program, agent } => write!(
                f,
                "Could not start {agent}: `{program}` was not found on your PATH. Install it and reopen this session — Kora will not install it for you."
            ),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for SpawnError {}

/// A live agent process, as the manager tracks it.
///
/// The [`Child`] itself lives in the supervisor task, not here — this holds only
/// what other callers need, so nothing has to await the process under the lock.
struct Session {
    agent_id: String,
    /// The agent's own conversation id, used to resume after a crash.
    agent_uuid: String,
    cwd: String,
    model: Option<String>,
    /// Behind its own lock: a write to an agent that has stopped reading can
    /// block for as long as the pipe stays full, and that must never hold the
    /// sessions map (a 1MB prompt exceeds the ~64KB pipe buffer easily).
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// Process-group id, so a kill reaches tool subprocesses too.
    pgid: i32,
    /// Set *before* the session is removed, so a deliberate close is never
    /// reported as a crash.
    intentional_exit: Arc<AtomicBool>,
    /// Cleared when this spawn ends. Pumps check it before emitting, so a line
    /// from a replaced process cannot land in the session that reused the id.
    alive: Arc<AtomicBool>,
    /// Tells the supervisor to signal the child.
    force_kill: Option<oneshot::Sender<()>>,
    /// Resolves once the process has actually gone.
    exited: Option<oneshot::Receiver<()>>,
}

/// Sink for events, so the manager can be tested without a Tauri app handle.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: SessionEvent);
}

impl<F> EventSink for F
where
    F: Fn(SessionEvent) + Send + Sync + 'static,
{
    fn emit(&self, event: SessionEvent) {
        self(event)
    }
}

#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    sink: Arc<dyn EventSink>,
}

impl SessionManager {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            sink,
        }
    }

    fn emit(&self, session_id: &str, event: AgentEvent) {
        self.sink.emit(SessionEvent {
            session_id: session_id.to_string(),
            event,
        });
    }

    /// Whether a session currently has a live process.
    pub async fn is_running(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    /// Start (or restart) the agent for `session_id`.
    ///
    /// `resume_uuid` carries the agent conversation id when recovering from a
    /// crash; passing `None` starts a fresh conversation. `profile_dir` scopes
    /// the spawn to one account's credentials.
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn(
        &self,
        session_id: &str,
        agent_id: &str,
        cwd: &str,
        model: Option<String>,
        resume_uuid: Option<String>,
        // Profile directory scoping this spawn to one account's credentials.
        profile_dir: Option<String>,
    ) -> Result<String, SpawnError> {
        let adapter =
            adapter_for(agent_id).ok_or_else(|| SpawnError::NotConnected(agent_id.to_string()))?;

        // Replace any existing process for this session rather than leaking it.
        self.kill(session_id).await;

        let (uuid, mode) = match resume_uuid {
            Some(u) => (u, SpawnMode::Resume),
            None => (uuid::Uuid::new_v4().to_string(), SpawnMode::Fresh),
        };

        let mut spec = adapter.spawn_spec(cwd, &uuid, model.as_deref(), mode);
        // The account's credentials live in its own profile directory, which the
        // agent owns — Kora passes a path, never a secret.
        if let Some(dir) = &profile_dir {
            spec.env.extend(adapter.account_env(dir));
        }

        // argv array, never a shell string (master plan, Security #4).
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        // Own process group, so killing the session also takes down the tool
        // subprocesses and MCP servers the agent spawned.
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => SpawnError::NotInstalled {
                program: spec.program.clone(),
                agent: adapter.name().to_string(),
            },
            _ => SpawnError::Other(format!("Could not start {}: {e}", adapter.name())),
        })?;

        // With setsid the child leads its own group, so pgid == pid.
        let pgid = child.id().unwrap_or(0) as i32;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SpawnError::Other("agent produced no stdout pipe".into()))?;
        let stderr = child.stderr.take();
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| SpawnError::Other("agent accepted no stdin pipe".into()))?;

        let intentional_exit = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let (force_tx, force_rx) = oneshot::channel();
        let (exited_tx, exited_rx) = oneshot::channel();

        // Handshake before anything else, so the control channel is live.
        for line in adapter.handshake() {
            let _ = stdin.write_all(format!("{line}\n").as_bytes()).await;
        }
        let _ = stdin.flush().await;

        // Register before starting any task: a child that dies immediately must
        // still find its session here, or its exit would go unreported and the
        // pane would sit at "ready" forever.
        self.sessions.lock().await.insert(
            session_id.to_string(),
            Session {
                agent_id: agent_id.to_string(),
                agent_uuid: uuid.clone(),
                cwd: cwd.to_string(),
                model,
                stdin: Arc::new(Mutex::new(Some(stdin))),
                pgid,
                intentional_exit: intentional_exit.clone(),
                alive: alive.clone(),
                force_kill: Some(force_tx),
                exited: Some(exited_rx),
            },
        );

        self.supervise(
            session_id,
            child,
            intentional_exit.clone(),
            alive.clone(),
            force_rx,
            exited_tx,
        );
        self.pump_stdout(session_id, agent_id, stdout, alive.clone());
        if let Some(stderr) = stderr {
            self.pump_stderr(session_id, stderr, intentional_exit, alive);
        }

        Ok(uuid)
    }

    /// Owns the child, reports its exit, and performs forced kills.
    fn supervise(
        &self,
        session_id: &str,
        mut child: Child,
        intentional_exit: Arc<AtomicBool>,
        alive: Arc<AtomicBool>,
        mut force_kill: oneshot::Receiver<()>,
        exited: oneshot::Sender<()>,
    ) {
        let this = self.clone();
        let session_id = session_id.to_string();

        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = &mut force_kill => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };

            alive.store(false, Ordering::SeqCst);
            let _ = exited.send(());

            // Read the flag under the same lock as the removal: a kill racing a
            // natural exit sets it under that lock too, so the two orderings
            // cannot interleave into a spurious crash report.
            let deliberate = {
                let mut sessions = this.sessions.lock().await;
                let deliberate = intentional_exit.load(Ordering::SeqCst);
                sessions.remove(&session_id);
                deliberate
            };
            if deliberate {
                return;
            }

            this.emit(
                &session_id,
                AgentEvent::Exited {
                    code: status.ok().and_then(|s| s.code()),
                    // The agent keeps its own conversation log, so a resume is
                    // always worth offering.
                    recoverable: true,
                },
            );
        });
    }

    /// Reads agent stdout line-by-line and forwards parsed events.
    fn pump_stdout(
        &self,
        session_id: &str,
        agent_id: &str,
        stdout: tokio::process::ChildStdout,
        alive: Arc<AtomicBool>,
    ) {
        let this = self.clone();
        let session_id = session_id.to_string();
        let agent_id = agent_id.to_string();

        tokio::spawn(async move {
            let Some(adapter) = adapter_for(&agent_id) else {
                return;
            };
            let mut lines = BufReader::new(stdout).lines();

            // A single agent line can be very large (a full tool result), which
            // is fine — `lines()` grows its buffer as needed.
            while let Ok(Some(line)) = lines.next_line().await {
                if !alive.load(Ordering::SeqCst) {
                    return;
                }
                for event in adapter.parse_line(&line) {
                    this.emit(&session_id, event);
                }
            }
            // EOF here means nothing on its own; the supervisor owns exit.
        });
    }

    /// Surfaces stderr diagnostics.
    fn pump_stderr(
        &self,
        session_id: &str,
        stderr: tokio::process::ChildStderr,
        intentional_exit: Arc<AtomicBool>,
        alive: Arc<AtomicBool>,
    ) {
        let this = self.clone();
        let session_id = session_id.to_string();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if !alive.load(Ordering::SeqCst) {
                    return;
                }
                if line.is_empty() || intentional_exit.load(Ordering::SeqCst) {
                    continue;
                }
                this.emit(&session_id, AgentEvent::Error { message: line });
            }
        });
    }

    /// Sends one already-encoded line to the agent's stdin.
    ///
    /// The sessions map is released before the write, so a wedged agent blocks
    /// only its own session.
    async fn write_line(&self, session_id: &str, line: &str) -> Result<(), String> {
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .map(|s| s.stdin.clone())
                .ok_or_else(|| "no running agent for this session".to_string())?
        };

        let mut guard = handle.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "agent stdin is closed".to_string())?;

        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| format!("could not write to agent: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("could not flush to agent: {e}"))
    }

    /// Sends a user turn.
    pub async fn send_prompt(&self, session_id: &str, prompt: &str) -> Result<(), String> {
        let agent_id = self.agent_id_of(session_id).await?;
        let adapter = adapter_for(&agent_id).ok_or("unknown agent")?;
        self.write_line(session_id, &adapter.encode_prompt(prompt))
            .await
    }

    /// Answers a permission request.
    ///
    /// The adapter decides what that takes — one line, several, or none at all
    /// for a denial. Returns whether anything was sent.
    pub async fn answer_permission(
        &self,
        session_id: &str,
        tool: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<bool, String> {
        let agent_id = self.agent_id_of(session_id).await?;
        let adapter = adapter_for(&agent_id).ok_or("unknown agent")?;
        let lines = adapter.encode_permission_reply(tool, request_id, decision);
        let sent = !lines.is_empty();
        for line in lines {
            self.write_line(session_id, &line).await?;
        }
        Ok(sent)
    }

    /// Interrupts generation, if the agent supports it.
    pub async fn interrupt(&self, session_id: &str) -> Result<bool, String> {
        let agent_id = self.agent_id_of(session_id).await?;
        let adapter = adapter_for(&agent_id).ok_or("unknown agent")?;
        match adapter.encode_interrupt() {
            Some(line) => {
                self.write_line(session_id, &line).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn agent_id_of(&self, session_id: &str) -> Result<String, String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| s.agent_id.clone())
            .ok_or_else(|| "no running agent for this session".to_string())
    }

    /// What a crashed session needs in order to be respawned with its context.
    pub async fn resume_info(
        &self,
        session_id: &str,
    ) -> Option<(String, String, Option<String>, String)> {
        self.sessions.lock().await.get(session_id).map(|s| {
            (
                s.agent_id.clone(),
                s.cwd.clone(),
                s.model.clone(),
                s.agent_uuid.clone(),
            )
        })
    }

    /// Ends a session's process and its whole process group.
    /// Safe to call when nothing is running.
    pub async fn kill(&self, session_id: &str) {
        // Flag first, then take the session: the supervisor reads the flag only
        // after the process is gone, so this ordering makes a deliberate close
        // impossible to mistake for a crash.
        let taken = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(session_id) {
                Some(s) => {
                    s.intentional_exit.store(true, Ordering::SeqCst);
                    s.alive.store(false, Ordering::SeqCst);
                    sessions.remove(session_id)
                }
                None => None,
            }
        };
        let Some(mut session) = taken else { return };

        // Closing stdin is the graceful path — the CLI exits 0 on EOF. But a
        // blocked write holds that lock, and waiting for it here would make
        // closing a tab hang for as long as the agent ignores its input, so an
        // in-flight write means we skip straight to signalling the group.
        let closed = match session.stdin.try_lock() {
            Ok(mut guard) => {
                guard.take();
                true
            }
            Err(_) => false,
        };

        let exited = session.exited.take();
        let force = session.force_kill.take();

        let gone = match (closed, exited) {
            (true, Some(rx)) => tokio::time::timeout(GRACEFUL_EXIT, rx).await.is_ok(),
            (true, None) => true,
            (false, _) => false,
        };

        if !gone {
            if let Some(tx) = force {
                let _ = tx.send(());
            }
        }
        // Sweep the group either way: even a clean agent exit can leave tool
        // subprocesses and MCP servers running, and the group is ours.
        kill_process_group(session.pgid);
    }

    /// Ends every session's process. Called on app exit.
    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for id in ids {
            self.kill(&id).await;
        }
    }
}

/// Signals an entire process group. No-op for an unknown group.
fn kill_process_group(pgid: i32) {
    #[cfg(unix)]
    if pgid > 0 {
        // SAFETY: killpg with a group we created via setsid; an invalid group
        // simply returns ESRCH.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn recorder() -> (Arc<dyn EventSink>, mpsc::UnboundedReceiver<SessionEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(move |e: SessionEvent| {
                let _ = tx.send(e);
            }),
            rx,
        )
    }

    #[tokio::test]
    async fn unknown_agent_reports_not_connected_without_spawning() {
        let (sink, _rx) = recorder();
        let mgr = SessionManager::new(sink);
        let err = mgr
            .spawn("s1", "codex", "/tmp", None, None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, SpawnError::NotConnected(_)));
        assert!(err.to_string().contains("no adapter in this build"));
        assert!(!mgr.is_running("s1").await);
    }

    #[tokio::test]
    async fn writing_to_a_session_with_no_process_is_an_error_not_a_panic() {
        let (sink, _rx) = recorder();
        let mgr = SessionManager::new(sink);
        assert!(mgr.send_prompt("s1", "hello").await.is_err());
        assert!(mgr.interrupt("s1").await.is_err());
        assert!(mgr
            .answer_permission("s1", "Edit", "t1", PermissionDecision::Allow)
            .await
            .is_err());
        assert!(mgr.resume_info("s1").await.is_none());
    }

    #[tokio::test]
    async fn killing_an_unknown_session_is_a_no_op() {
        let (sink, _rx) = recorder();
        let mgr = SessionManager::new(sink);
        mgr.kill("nope").await;
        mgr.kill_all().await;
    }

    #[test]
    fn killing_an_unknown_process_group_is_harmless() {
        kill_process_group(0);
        kill_process_group(-1);
    }

    #[test]
    fn spawn_errors_explain_themselves() {
        let msg = SpawnError::NotInstalled {
            program: "claude".into(),
            agent: "Claude Code".into(),
        }
        .to_string();
        assert!(msg.contains("not found on your PATH"));
        assert!(msg.contains("will not install it"));
        assert_eq!(SpawnError::Other("boom".into()).to_string(), "boom");
    }
}
