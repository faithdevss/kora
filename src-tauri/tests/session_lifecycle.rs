//! End-to-end tests for the process layer, driven by a stub agent.
//!
//! The stub speaks the same stream-json protocol as the real `claude` CLI (the
//! shapes are copied from the Phase 2 spike transcripts), so these exercise the
//! real spawn → pump → parse → emit → kill path without any API cost or network.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

extern crate libc;

use tokio::sync::mpsc;
use std::time::Duration;

use kora_lib::adapters::{AgentEvent, PermissionDecision};
use kora_lib::proc::manager::{SessionEvent, SessionManager};

/// `KORA_CLAUDE_BIN` is process-global — it is the seam that lets a test point
/// the adapter at a stub — so these tests must not overlap. Each holds this
/// guard for its whole body. The cost is that two stubs cannot run
/// concurrently; if that ever matters, the override belongs on the manager
/// rather than in the environment.
fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Writes an executable stub agent and returns its path.
///
/// It echoes protocol responses for whatever it reads on stdin, mimicking the
/// CLI's persistent-process behaviour: one process, many turns, exits on EOF.
fn stub_agent(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("stub-agent.sh");
    let mut f = std::fs::File::create(&path).unwrap();
    write!(f, "#!/bin/sh\n{body}\n").unwrap();
    drop(f);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn workspace(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kora-test-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn recorder() -> (
    Arc<dyn kora_lib::proc::manager::EventSink>,
    mpsc::UnboundedReceiver<SessionEvent>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        Arc::new(move |e: SessionEvent| {
            let _ = tx.send(e);
        }),
        rx,
    )
}

/// Collects events until `pred` matches, or fails the test on timeout.
async fn wait_for(
    rx: &mut mpsc::UnboundedReceiver<SessionEvent>,
    seen: &mut Vec<SessionEvent>,
    pred: impl Fn(&AgentEvent) -> bool,
) -> AgentEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(ev)) => {
                let matched = pred(&ev.event);
                seen.push(ev.clone());
                if matched {
                    return ev.event;
                }
            }
            Ok(None) => panic!("event channel closed; saw: {seen:#?}"),
            Err(_) => panic!("timed out; saw: {seen:#?}"),
        }
    }
}

/// Reads a line per turn and replies with a full stream-json turn.
const ECHO_TURNS: &str = r#"
echo '{"type":"system","subtype":"init","session_id":"stub-1","model":"stub-model","mcp_servers":[{"name":"m1"}],"slash_commands":["cost"]}'
while IFS= read -r line; do
  case "$line" in
    *control_request*) echo '{"type":"control_response","response":{"subtype":"success","request_id":"kora-init"}}' ;;
    *)
      echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}'
      echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}'
      echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}'
      echo '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"seven_day","utilization":0.42,"resetsAt":123}}'
      echo '{"type":"result","subtype":"success","is_error":false,"result":"hello world","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":7},"modelUsage":{"stub-model":{"contextWindow":200000}}}'
      ;;
  esac
done
"#;

#[tokio::test]
async fn a_full_turn_streams_through_to_events() {
    let _guard = env_lock().lock().await;
    let ws = workspace("turn");
    let stub = stub_agent(&ws, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    let uuid = mgr
        .spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .expect("spawn");
    assert!(uuid::Uuid::parse_str(&uuid).is_ok(), "kora mints a real uuid");

    let mut seen = Vec::new();
    // Ready arrives from the stub's init line, before any prompt.
    match wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await {
        AgentEvent::Ready {
            model, mcp_servers, ..
        } => {
            assert_eq!(model.as_deref(), Some("stub-model"));
            assert_eq!(mcp_servers, Some(1));
        }
        _ => unreachable!(),
    }

    mgr.send_prompt("s1", "hi there").await.expect("write");
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;

    let kinds: Vec<&AgentEvent> = seen.iter().map(|e| &e.event).collect();
    assert!(kinds.iter().any(|e| matches!(e, AgentEvent::Delta { text } if text == "hello ")));
    assert!(kinds.iter().any(|e| matches!(e, AgentEvent::Tool { name, .. } if name == "Read")));
    assert!(kinds
        .iter()
        .any(|e| matches!(e, AgentEvent::RateLimit { utilization, .. } if (*utilization - 0.42).abs() < 1e-9)));
    assert!(seen.iter().all(|e| e.session_id == "s1"), "events carry their session");

    mgr.kill("s1").await;
    assert!(!mgr.is_running("s1").await);
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn one_process_serves_many_turns() {
    let _guard = env_lock().lock().await;
    let ws = workspace("multi");
    let stub = stub_agent(&ws, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    for _ in 0..3 {
        mgr.send_prompt("s1", "again").await.unwrap();
        wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;
    }
    // Exactly one `system/init` (the Ready that carries a session id), so the
    // process was never restarted between turns. The handshake reply also
    // produces a Ready, but without a session id.
    let inits = seen
        .iter()
        .filter(|e| {
            matches!(&e.event, AgentEvent::Ready { agent_session_id, .. } if agent_session_id.is_some())
        })
        .count();
    assert_eq!(inits, 1);

    mgr.kill("s1").await;
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn an_unexpected_exit_is_reported_as_recoverable() {
    let _guard = env_lock().lock().await;
    let ws = workspace("crash");
    // Emits init, then dies on the first prompt.
    let stub = stub_agent(
        &ws,
        r#"
echo '{"type":"system","subtype":"init","session_id":"stub-1"}'
while IFS= read -r line; do
  case "$line" in
    *control_request*) : ;;
    *) exit 9 ;;
  esac
done
"#,
    );
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;
    mgr.send_prompt("s1", "die").await.unwrap();

    match wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Exited { .. })).await {
        AgentEvent::Exited { code, recoverable } => {
            assert_eq!(code, Some(9));
            assert!(recoverable, "a crash should offer a resume");
        }
        _ => unreachable!(),
    }
    // The dead session is dropped, so nothing is left claiming to run.
    assert!(!mgr.is_running("s1").await);
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn a_deliberate_kill_is_not_reported_as_a_crash() {
    let _guard = env_lock().lock().await;
    let ws = workspace("kill");
    let stub = stub_agent(&ws, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    mgr.kill("s1").await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    while let Ok(ev) = rx.try_recv() {
        assert!(
            !matches!(ev.event, AgentEvent::Exited { .. }),
            "closing a tab must not look like a crash"
        );
    }
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn kill_all_stops_every_session() {
    let _guard = env_lock().lock().await;
    let ws = workspace("killall");
    let stub = stub_agent(&ws, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, _rx) = recorder();
    let mgr = SessionManager::new(sink);
    for id in ["s1", "s2", "s3"] {
        mgr.spawn(id, "claude", ws.to_str().unwrap(), None, None)
            .await
            .unwrap();
    }
    assert!(mgr.is_running("s2").await);

    mgr.kill_all().await;
    for id in ["s1", "s2", "s3"] {
        assert!(!mgr.is_running(id).await, "{id} should be gone");
    }
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn respawning_replaces_the_previous_process_rather_than_leaking_it() {
    let _guard = env_lock().lock().await;
    let ws = workspace("respawn");
    let stub = stub_agent(&ws, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    let first = mgr
        .spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    // Resume keeps the agent conversation id; a fresh spawn mints a new one.
    let resumed = mgr
        .spawn("s1", "claude", ws.to_str().unwrap(), None, Some(first.clone()))
        .await
        .unwrap();
    assert_eq!(resumed, first);
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    let fresh = mgr
        .spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();
    assert_ne!(fresh, first);

    mgr.kill("s1").await;
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn permission_replies_go_to_the_agent_and_denials_stay_local() {
    let _guard = env_lock().lock().await;
    let ws = workspace("perm");
    let stub = stub_agent(
        &ws,
        r#"
echo '{"type":"system","subtype":"init","session_id":"stub-1"}'
while IFS= read -r line; do
  case "$line" in
    *set_permission_mode*) echo '{"type":"system","subtype":"status","permissionMode":"acceptEdits"}' ;;
    *control_request*) : ;;
    *) echo '{"type":"system","subtype":"permission_denied","tool_name":"Edit","tool_use_id":"toolu_9","message":"needs write to a.ts"}' ;;
  esac
done
"#,
    );
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;
    mgr.send_prompt("s1", "edit a.ts").await.unwrap();

    match wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Permission { .. })).await {
        AgentEvent::Permission {
            request_id, tool, ..
        } => {
            assert_eq!(request_id, "toolu_9");
            assert_eq!(tool, "Edit");
        }
        _ => unreachable!(),
    }

    // Denying sends nothing to the agent; approving does.
    assert!(!mgr
        .answer_permission("s1", "Edit", "toolu_9", PermissionDecision::Deny)
        .await
        .unwrap());
    assert!(mgr
        .answer_permission("s1", "Edit", "toolu_9", PermissionDecision::Allow)
        .await
        .unwrap());

    mgr.kill("s1").await;
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn a_missing_binary_reports_a_clear_error_and_starts_nothing() {
    let _guard = env_lock().lock().await;
    let ws = workspace("missing");
    std::env::set_var("KORA_CLAUDE_BIN", ws.join("does-not-exist"));

    let (sink, _rx) = recorder();
    let mgr = SessionManager::new(sink);
    let err = mgr
        .spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap_err()
        .to_string();

    assert!(err.contains("not found on your PATH"), "got: {err}");
    assert!(!mgr.is_running("s1").await);
    let _ = std::fs::remove_dir_all(&ws);
}

/// Verifies the real argv against the installed `claude` binary.
///
/// Handshake only — it sends `control_request/initialize` and closes stdin
/// without ever submitting a turn, so it makes no API call and costs nothing.
/// What it proves is that the flag combination in `ClaudeAdapter::spawn_spec`
/// is accepted by the real CLI and that the control channel answers, which the
/// stub agent cannot tell us.
///
/// Ignored by default because it needs `claude` installed and authenticated:
/// `cargo test -- --ignored real_cli_accepts_our_argv`
#[tokio::test]
#[ignore]
async fn real_cli_accepts_our_argv() {
    let _guard = env_lock().lock().await;
    std::env::remove_var("KORA_CLAUDE_BIN");
    let ws = workspace("realcli");

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    let uuid = mgr
        .spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .expect("real claude should spawn");

    let mut seen = Vec::new();
    match wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await {
        AgentEvent::Ready { commands, .. } => {
            // Readiness comes from the handshake reply, which carries the real
            // command list. The conversation id is the one Kora minted and
            // passed via --session-id, returned by spawn() above.
            assert!(!commands.is_empty(), "real CLI should list its slash commands");
            assert!(
                commands.iter().any(|c| c.name == "/compact"),
                "expected the real CLI command list, got: {:?}",
                commands.iter().take(5).collect::<Vec<_>>()
            );
            eprintln!("real CLI ready: {} commands, uuid={uuid}", commands.len());
        }
        _ => unreachable!(),
    }

    mgr.kill("s1").await;
    assert!(!mgr.is_running("s1").await);
    let _ = std::fs::remove_dir_all(&ws);
}

/// One real turn against the installed `claude`, end to end through the manager.
///
/// This is acceptance criterion 1: a real prompt produces a real streamed
/// response, with real usage numbers. Uses haiku and a one-word answer to keep
/// it cheap. Ignored by default — it makes a real API call.
///
/// `cargo test -- --ignored real_cli_completes_a_turn --nocapture`
#[tokio::test]
#[ignore]
async fn real_cli_completes_a_turn() {
    let _guard = env_lock().lock().await;
    std::env::remove_var("KORA_CLAUDE_BIN");
    let ws = workspace("realturn");

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    // "haiku" is a model *id* from the app's own fixture list, which is exactly
    // what the store passes as --model. (The display names — "claude-haiku-4"
    // and friends — are not values the CLI accepts, so sending those would fail
    // only at the first real turn.)
    mgr.spawn(
        "s1",
        "claude",
        ws.to_str().unwrap(),
        Some("haiku".to_string()),
        None,
    )
    .await
    .expect("spawn");

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    mgr.send_prompt("s1", "Reply with exactly one word: PONG")
        .await
        .expect("write");

    match wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::TurnEnd { .. })).await {
        AgentEvent::TurnEnd {
            text,
            usage,
            is_error,
        } => {
            assert!(!is_error, "turn reported an error: {text}");
            let u = usage.expect("real CLI reports usage");
            assert!(u.output_tokens > 0, "no output tokens reported");
            assert!(u.context_window.unwrap_or(0) > 0, "no context window reported");
            eprintln!(
                "real turn: {text:?} | in={} out={} cache_read={} window={:?} cost={:?}",
                u.input_tokens, u.output_tokens, u.cache_read_tokens, u.context_window, u.total_cost_usd
            );
        }
        _ => unreachable!(),
    }

    // The model alias the app sends must be the one the CLI actually used.
    let reported = seen.iter().find_map(|e| match &e.event {
        AgentEvent::Ready { model, .. } => model.clone(),
        _ => None,
    });
    assert!(
        reported.as_deref().unwrap_or_default().contains("haiku"),
        "expected the requested model to be honoured, got {reported:?}"
    );

    // The response must have streamed, not arrived in one lump.
    let deltas = seen
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::Delta { .. }))
        .count();
    assert!(deltas > 0, "expected streamed deltas, saw: {seen:#?}");
    eprintln!("streamed in {deltas} deltas");

    mgr.kill("s1").await;
    let _ = std::fs::remove_dir_all(&ws);
}

// ---------------------------------------------------------------------------
// Process-lifetime hazards. These cover paths a well-behaved stub never reaches.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_agent_that_dies_instantly_still_reports_its_exit() {
    // Regression: the pumps used to start before the session was registered, so
    // a child that died first found no session and its exit went unreported —
    // leaving the pane stuck at "ready" with no respawn offer.
    let _guard = env_lock().lock().await;
    let ws = workspace("instantdeath");
    let stub = stub_agent(&ws, "exit 3");
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    match wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Exited { .. })).await {
        AgentEvent::Exited { code, recoverable } => {
            assert_eq!(code, Some(3));
            assert!(recoverable);
        }
        _ => unreachable!(),
    }
    assert!(!mgr.is_running("s1").await);
    let _ = std::fs::remove_dir_all(&ws);
}

/// Closes its own stdout, then lives on — like `claude` handing the pipe to a
/// long-running tool subprocess.
const CLOSES_STDOUT: &str = r#"
echo '{"type":"system","subtype":"init","session_id":"stub-1"}'
exec 1>&-
sleep 60
"#;

#[tokio::test]
async fn a_live_agent_that_closed_stdout_is_not_mistaken_for_a_dead_one() {
    // Regression: exit used to be inferred from stdout EOF, which this process
    // reaches while still very much alive.
    let _guard = env_lock().lock().await;
    let ws = workspace("stdoutclosed");
    let stub = stub_agent(&ws, CLOSES_STDOUT);
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    while let Ok(ev) = rx.try_recv() {
        assert!(
            !matches!(ev.event, AgentEvent::Exited { .. }),
            "a closed stdout is not an exit"
        );
    }
    assert!(mgr.is_running("s1").await);

    // And it must still be killable, promptly.
    let started = std::time::Instant::now();
    mgr.kill("s1").await;
    assert!(started.elapsed() < Duration::from_secs(3), "kill should not hang");
    assert!(!mgr.is_running("s1").await);
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn a_wedged_agent_does_not_block_other_sessions() {
    // Regression: the exit path used to hold the sessions lock across
    // `child.wait()`, so one wedged agent stalled every other command.
    let _guard = env_lock().lock().await;
    let ws = workspace("wedged");
    let wedged = stub_agent(&ws, CLOSES_STDOUT);
    std::env::set_var("KORA_CLAUDE_BIN", &wedged);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    // A healthy session alongside it must behave completely normally.
    let ws2 = workspace("wedged-healthy");
    let healthy = stub_agent(&ws2, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &healthy);
    mgr.spawn("s2", "claude", ws2.to_str().unwrap(), None, None)
        .await
        .unwrap();

    mgr.send_prompt("s2", "still working?").await.unwrap();
    let mut seen2 = Vec::new();
    wait_for(&mut rx, &mut seen2, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;

    // And shutting everything down must not hang on the wedged one.
    let started = std::time::Instant::now();
    mgr.kill_all().await;
    assert!(started.elapsed() < Duration::from_secs(5), "kill_all should not hang");
    assert!(!mgr.is_running("s1").await);
    assert!(!mgr.is_running("s2").await);

    let _ = std::fs::remove_dir_all(&ws);
    let _ = std::fs::remove_dir_all(&ws2);
}

#[cfg(unix)]
#[tokio::test]
async fn killing_a_session_takes_its_child_processes_with_it() {
    // The agent spawns tool subprocesses and MCP servers; those must not
    // outlive the session.
    let _guard = env_lock().lock().await;
    let ws = workspace("grandchild");
    let marker = ws.join("child.pid");
    let stub = stub_agent(
        &ws,
        &format!(
            r#"
sleep 60 &
echo $! > {}
echo '{{"type":"system","subtype":"init","session_id":"stub-1"}}'
sleep 60
"#,
            marker.display()
        ),
    );
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();

    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    let child_pid: i32 = std::fs::read_to_string(&marker)
        .expect("stub should record its child pid")
        .trim()
        .parse()
        .unwrap();
    // SAFETY: signal 0 only probes for existence.
    assert_eq!(unsafe { libc::kill(child_pid, 0) }, 0, "child should be alive");

    mgr.kill("s1").await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(
        unsafe { libc::kill(child_pid, 0) },
        -1,
        "the agent's child process should have been killed with the group"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn a_wedged_stdin_does_not_block_other_sessions() {
    // Regression: writes used to happen under the sessions map lock, so an
    // agent that stopped reading stdin could stall every other session and the
    // quit path. The stub never reads, so its pipe fills and the write blocks.
    let _guard = env_lock().lock().await;
    let ws = workspace("wedged-stdin");
    let deaf = stub_agent(
        &ws,
        r#"
echo '{"type":"system","subtype":"init","session_id":"stub-1"}'
sleep 60
"#,
    );
    std::env::set_var("KORA_CLAUDE_BIN", &deaf);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    // Big enough to exceed the pipe buffer, so the write cannot complete.
    let huge = "x".repeat(512 * 1024);
    let writer = {
        let mgr = mgr.clone();
        tokio::spawn(async move { mgr.send_prompt("s1", &huge).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A healthy session must still spawn, run a turn, and shut down promptly.
    let ws2 = workspace("wedged-stdin-healthy");
    let healthy = stub_agent(&ws2, ECHO_TURNS);
    std::env::set_var("KORA_CLAUDE_BIN", &healthy);

    let started = std::time::Instant::now();
    mgr.spawn("s2", "claude", ws2.to_str().unwrap(), None, None)
        .await
        .expect("a blocked write must not stall an unrelated spawn");
    mgr.send_prompt("s2", "still working?").await.unwrap();
    let mut seen2 = Vec::new();
    wait_for(&mut rx, &mut seen2, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;
    assert!(started.elapsed() < Duration::from_secs(5));

    mgr.kill_all().await;
    writer.abort();
    let _ = std::fs::remove_dir_all(&ws);
    let _ = std::fs::remove_dir_all(&ws2);
}

#[tokio::test]
async fn output_from_a_replaced_process_cannot_land_in_the_new_session() {
    // Session ids are reused across respawns, so a pump that outlived its
    // process must go quiet rather than write into its successor's transcript.
    let _guard = env_lock().lock().await;
    let ws = workspace("stale-pump");
    // Keeps stdout open via a grandchild that talks after the parent is gone.
    let stub = stub_agent(
        &ws,
        r#"
echo '{"type":"system","subtype":"init","session_id":"stub-1"}'
( sleep 1; echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"STALE"}}}' ) &
sleep 60
"#,
    );
    std::env::set_var("KORA_CLAUDE_BIN", &stub);

    let (sink, mut rx) = recorder();
    let mgr = SessionManager::new(sink);
    mgr.spawn("s1", "claude", ws.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let mut seen = Vec::new();
    wait_for(&mut rx, &mut seen, |e| matches!(e, AgentEvent::Ready { .. })).await;

    mgr.kill("s1").await;
    tokio::time::sleep(Duration::from_millis(1500)).await;

    while let Ok(ev) = rx.try_recv() {
        if let AgentEvent::Delta { text } = &ev.event {
            assert_ne!(text, "STALE", "a dead spawn's output must not be emitted");
        }
    }
    let _ = std::fs::remove_dir_all(&ws);
}
