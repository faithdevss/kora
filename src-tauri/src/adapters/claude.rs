//! Claude Code adapter.
//!
//! Drives `claude` in structured mode — see `plan/phase-2-agent-exec.md`
//! ("Spike Results") for why this beat wrapping the interactive TUI in a PTY.
//!
//! ```text
//! claude -p --input-format stream-json --output-format stream-json \
//!        --verbose --include-partial-messages --session-id <uuid> [--resume <uuid>]
//! ```
//!
//! One process serves the whole session: each user turn is a JSON line on
//! stdin, and the CLI answers with a stream of JSON events on stdout.
//!
//! ## Permissions
//!
//! The session runs in the CLI's default (deny) permission mode, so no tool
//! runs unapproved. When the CLI refuses a tool it emits
//! `system/permission_denied`, which becomes an [`AgentEvent::Permission`] and
//! surfaces as an approval prompt in the pane.
//!
//! Note the limitation this works around: `claude -p` never *asks* — verified
//! against 2.1.223 under both `--permission-mode default` and `manual`, with and
//! without a `control_request/initialize` handshake, it denies and reports
//! rather than blocking for an answer. So approval is necessarily
//! attempt → deny → approve → retry, not a pre-execution gate. What Kora
//! controls is the mode, via `control_request/set_permission_mode`, which does
//! take effect immediately (confirmed by the `system/status` echo).

use serde_json::{json, Value};

use super::{
    AgentAdapter, AgentCommand, AgentEvent, Capability, PermissionDecision, PermissionScope,
    SpawnMode, SpawnSpec, Usage, WorkspaceMarker,
};

const CAPABILITIES: &[Capability] = &[
    Capability::Streaming,
    Capability::Usage,
    Capability::Cost,
    Capability::PermissionPrompts,
    Capability::Interrupt,
    Capability::Resume,
];

/// Files `claude` reads from the workspace on its own.
const MARKERS: &[WorkspaceMarker] = &[
    WorkspaceMarker {
        file: "CLAUDE.md",
        label: "project CLAUDE.md",
    },
    WorkspaceMarker {
        file: ".mcp.json",
        label: ".mcp.json",
    },
];

/// Tools covered by `acceptEdits`. Anything else needs the broader mode.
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit", "ApplyPatch"];

#[derive(Debug, Default, Clone)]
pub struct ClaudeAdapter;

impl ClaudeAdapter {
    /// The narrowest permission mode that would actually unblock `tool`.
    ///
    /// `claude -p` has no per-call grant, so every approval widens the session.
    /// Being precise about *how much* is what keeps the UI honest.
    fn mode_for(tool: &str) -> (&'static str, PermissionScope) {
        if EDIT_TOOLS.contains(&tool) {
            ("acceptEdits", PermissionScope::SessionEdits)
        } else {
            ("bypassPermissions", PermissionScope::SessionAll)
        }
    }

    /// One-line human summary of a tool call, e.g. `Edit · src/auth/session.ts`.
    fn tool_detail(name: &str, input: &Value) -> String {
        let arg = input
            .get("file_path")
            .or_else(|| input.get("path"))
            .or_else(|| input.get("command"))
            .or_else(|| input.get("pattern"))
            .or_else(|| input.get("url"))
            .and_then(Value::as_str)
            .unwrap_or_default();

        if arg.is_empty() {
            name.to_string()
        } else {
            // Bash commands can be long and multi-line; keep the transcript tidy.
            let arg = arg.lines().next().unwrap_or(arg);
            let arg = if arg.chars().count() > 80 {
                let truncated: String = arg.chars().take(79).collect();
                format!("{truncated}…")
            } else {
                arg.to_string()
            };
            format!("{name} · {arg}")
        }
    }

    fn usage_from_result(v: &Value) -> Usage {
        let u = v.get("usage");
        let get = |k: &str| -> u64 {
            u.and_then(|u| u.get(k)).and_then(Value::as_u64).unwrap_or(0)
        };
        // modelUsage is keyed by model id; any entry carries the real window.
        let context_window = v
            .get("modelUsage")
            .and_then(Value::as_object)
            .and_then(|m| m.values().next())
            .and_then(|m| m.get("contextWindow"))
            .and_then(Value::as_u64);

        Usage {
            input_tokens: get("input_tokens"),
            output_tokens: get("output_tokens"),
            cache_read_tokens: get("cache_read_input_tokens"),
            cache_creation_tokens: get("cache_creation_input_tokens"),
            total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            context_window,
        }
    }

    fn parse_system(&self, v: &Value, out: &mut Vec<AgentEvent>) {
        match v.get("subtype").and_then(Value::as_str).unwrap_or_default() {
            "init" => {
                let commands = v
                    .get("slash_commands")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(|name| AgentCommand {
                                name: format!("/{}", name.trim_start_matches('/')),
                                description: String::new(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                out.push(AgentEvent::Ready {
                    agent_session_id: v
                        .get("session_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: v.get("model").and_then(Value::as_str).map(str::to_string),
                    mcp_servers: v.get("mcp_servers").and_then(Value::as_array).map(Vec::len),
                    commands,
                });
            }
            "permission_denied" => {
                let tool = v
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                // tool_use_id identifies the specific call, so an approval can
                // be matched back to what was asked for.
                let request_id = v
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let detail = v
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let (_, scope) = Self::mode_for(&tool);
                out.push(AgentEvent::Permission {
                    request_id,
                    tool,
                    detail,
                    scope,
                });
            }
            "compact_boundary" => out.push(AgentEvent::Compacted),
            "api_error" => {
                if let Some(msg) = v.get("message").and_then(Value::as_str) {
                    out.push(AgentEvent::Error {
                        message: msg.to_string(),
                    });
                }
            }
            // status / thinking_tokens / hook_* are protocol noise.
            _ => {}
        }
    }

    fn parse_stream_event(&self, v: &Value, out: &mut Vec<AgentEvent>) {
        let Some(ev) = v.get("event") else { return };
        match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
            "content_block_delta" => {
                let delta = ev.get("delta");
                let is_text = delta
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    .map(|t| t == "text_delta")
                    .unwrap_or(false);
                // Thinking and tool-input deltas are deliberately dropped: the
                // transcript shows finished tool calls, not their assembly.
                if is_text {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                        if !text.is_empty() {
                            out.push(AgentEvent::Delta {
                                text: text.to_string(),
                            });
                        }
                    }
                }
            }
            "message_stop" => out.push(AgentEvent::MessageDone),
            _ => {}
        }
    }
}

impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    /// `claude` on `$PATH`, unless `KORA_CLAUDE_BIN` names another executable —
    /// which covers non-standard installs and lets tests drive a stub agent.
    fn program(&self) -> String {
        std::env::var("KORA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
    }

    fn capabilities(&self) -> &'static [Capability] {
        CAPABILITIES
    }

    fn spawn_spec(
        &self,
        cwd: &str,
        session_uuid: &str,
        model: Option<&str>,
        mode: SpawnMode,
    ) -> SpawnSpec {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];

        match mode {
            // Kora picks the id, so recovery never has to scrape it back out.
            SpawnMode::Fresh => {
                args.push("--session-id".into());
                args.push(session_uuid.into());
            }
            SpawnMode::Resume => {
                args.push("--resume".into());
                args.push(session_uuid.into());
            }
        }

        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }

        SpawnSpec {
            program: self.program(),
            args,
            cwd: cwd.into(),
            env: Vec::new(),
        }
    }

    fn encode_prompt(&self, prompt: &str) -> String {
        json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
        })
        .to_string()
    }

    fn handshake(&self) -> Vec<String> {
        // Returns the agent's real slash-command list and readies the control
        // channel for set_permission_mode / interrupt.
        vec![json!({
            "type": "control_request",
            "request_id": "kora-init",
            "request": { "subtype": "initialize", "hooks": {} }
        })
        .to_string()]
    }

    fn encode_permission_reply(
        &self,
        tool: &str,
        _request_id: &str,
        decision: PermissionDecision,
    ) -> Vec<String> {
        // `claude -p` has no per-call approval channel (see module docs): it
        // refuses, reports, and moves on. So approving means widening the
        // session's permission mode and then asking it to go again.
        if decision == PermissionDecision::Deny {
            return Vec::new();
        }
        let (mode, _) = Self::mode_for(tool);
        vec![
            json!({
                "type": "control_request",
                "request_id": format!("kora-mode-{}", uuid::Uuid::new_v4()),
                "request": { "subtype": "set_permission_mode", "mode": mode }
            })
            .to_string(),
            self.encode_prompt("Permission granted — please retry the step that was blocked."),
        ]
    }

    fn workspace_markers(&self) -> &'static [WorkspaceMarker] {
        MARKERS
    }

    fn encode_interrupt(&self) -> Option<String> {
        Some(
            json!({
                "type": "control_request",
                "request_id": format!("kora-int-{}", uuid::Uuid::new_v4()),
                "request": { "subtype": "interrupt" }
            })
            .to_string(),
        )
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        // Anything unparseable is dropped rather than surfaced: the CLI
        // occasionally prints non-JSON diagnostics, and those must not become
        // transcript noise or errors.
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };

        let mut out = Vec::new();
        match v.get("type").and_then(Value::as_str).unwrap_or_default() {
            "system" => self.parse_system(&v, &mut out),
            "stream_event" => self.parse_stream_event(&v, &mut out),
            "assistant" => {
                // Finished blocks. Text already arrived as deltas; only tool
                // calls need reporting here.
                if let Some(content) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string();
                            let detail = Self::tool_detail(
                                &name,
                                block.get("input").unwrap_or(&Value::Null),
                            );
                            out.push(AgentEvent::Tool { name, detail });
                        }
                    }
                }
            }
            "rate_limit_event" => {
                if let Some(info) = v.get("rate_limit_info") {
                    if let Some(utilization) = info.get("utilization").and_then(Value::as_f64) {
                        out.push(AgentEvent::RateLimit {
                            window: info
                                .get("rateLimitType")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string(),
                            utilization,
                            resets_at: info.get("resetsAt").and_then(Value::as_i64),
                        });
                    }
                }
            }
            "result" => {
                let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                let text = v
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                out.push(AgentEvent::TurnEnd {
                    text,
                    usage: Some(Self::usage_from_result(&v)),
                    is_error,
                });
            }
            // The handshake reply is the earliest sign the session is usable:
            // the real CLI only emits `system/init` once a turn begins, so
            // without this a fresh pane would sit at "starting" until the user
            // typed something. It also carries the agent's real command list.
            "control_response" => {
                let response = v.get("response");
                let is_init = response
                    .and_then(|r| r.get("request_id"))
                    .and_then(Value::as_str)
                    == Some("kora-init");
                if !is_init {
                    return out;
                }
                let commands = response
                    .and_then(|r| r.get("response"))
                    .and_then(|r| r.get("commands"))
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|c| {
                                let name = c.get("name").and_then(Value::as_str)?;
                                Some(AgentCommand {
                                    name: format!("/{}", name.trim_start_matches('/')),
                                    description: c
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                out.push(AgentEvent::Ready {
                    agent_session_id: None,
                    model: None,
                    mcp_servers: None,
                    commands,
                });
            }
            _ => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Vec<AgentEvent> {
        ClaudeAdapter.parse_line(line)
    }

    #[test]
    fn spawn_spec_is_an_argv_array_with_no_shell() {
        let spec = ClaudeAdapter.spawn_spec("/tmp/ws; rm -rf /", "abc-123", Some("haiku"), SpawnMode::Fresh);
        assert_eq!(spec.program, "claude");
        // The malicious cwd stays one opaque argument — never concatenated.
        assert_eq!(spec.cwd, "/tmp/ws; rm -rf /");
        assert!(spec.args.iter().all(|a| !a.contains("rm -rf")));
        assert!(spec.args.windows(2).any(|w| w == ["--session-id", "abc-123"]));
        assert!(spec.args.windows(2).any(|w| w == ["--model", "haiku"]));
    }

    #[test]
    fn resume_uses_resume_flag_not_session_id() {
        let spec = ClaudeAdapter.spawn_spec("/tmp", "abc-123", None, SpawnMode::Resume);
        assert!(spec.args.windows(2).any(|w| w == ["--resume", "abc-123"]));
        assert!(!spec.args.iter().any(|a| a == "--session-id"));
        assert!(!spec.args.iter().any(|a| a == "--model"));
    }

    #[test]
    fn prompt_is_json_encoded_so_quotes_cannot_break_the_frame() {
        let line = ClaudeAdapter.encode_prompt("say \"hi\"\nand newline");
        assert!(!line.contains('\n'), "prompt frame must stay on one line");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["message"]["content"][0]["text"], "say \"hi\"\nand newline");
    }

    #[test]
    fn init_reports_session_model_and_mcp_servers() {
        let events = parse(
            r#"{"type":"system","subtype":"init","session_id":"s-1","model":"claude-haiku-4-5",
                "mcp_servers":[{"name":"codegraph","status":"connected"}],
                "slash_commands":["cost","review"]}"#,
        );
        match &events[0] {
            AgentEvent::Ready {
                agent_session_id,
                model,
                mcp_servers,
                commands,
            } => {
                assert_eq!(agent_session_id.as_deref(), Some("s-1"));
                assert_eq!(model.as_deref(), Some("claude-haiku-4-5"));
                assert_eq!(*mcp_servers, Some(1));
                assert_eq!(commands[0].name, "/cost");
                assert_eq!(commands[1].name, "/review");
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn the_handshake_reply_signals_readiness_and_carries_the_command_list() {
        // The real CLI emits `system/init` only when a turn starts, so this is
        // the event a freshly spawned pane depends on.
        let events = parse(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"kora-init",
                "response":{"commands":[{"name":"cost","description":"show cost"},
                                        {"name":"/review","description":"review diff"}]}}}"#,
        );
        match &events[0] {
            AgentEvent::Ready {
                agent_session_id,
                mcp_servers,
                commands,
                ..
            } => {
                // Unknown here, so a later system/init must not be overwritten.
                assert!(agent_session_id.is_none());
                assert!(mcp_servers.is_none());
                assert_eq!(commands[0].name, "/cost");
                assert_eq!(commands[0].description, "show cost");
                assert_eq!(commands[1].name, "/review");
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn other_control_responses_are_ignored() {
        assert!(parse(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"kora-mode-1","response":{"mode":"acceptEdits"}}}"#
        )
        .is_empty());
    }

    #[test]
    fn text_deltas_stream_and_other_deltas_are_dropped() {
        let text = parse(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}"#,
        );
        assert_eq!(text, vec![AgentEvent::Delta { text: "hel".into() }]);

        for kind in ["thinking_delta", "input_json_delta", "signature_delta"] {
            let line = format!(
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"{kind}","text":"x"}}}}}}"#
            );
            assert!(parse(&line).is_empty(), "{kind} should not reach the transcript");
        }
    }

    #[test]
    fn message_stop_closes_the_streamed_message() {
        assert_eq!(
            parse(r#"{"type":"stream_event","event":{"type":"message_stop"}}"#),
            vec![AgentEvent::MessageDone]
        );
    }

    #[test]
    fn tool_calls_are_summarized_to_one_line() {
        let events = parse(
            r#"{"type":"assistant","message":{"content":[
                {"type":"thinking","thinking":"hmm"},
                {"type":"tool_use","name":"Edit","input":{"file_path":"src/a.ts","old_string":"x"}}]}}"#,
        );
        assert_eq!(
            events,
            vec![AgentEvent::Tool {
                name: "Edit".into(),
                detail: "Edit · src/a.ts".into()
            }]
        );
    }

    #[test]
    fn long_and_multiline_tool_args_are_truncated() {
        let events = parse(
            r#"{"type":"assistant","message":{"content":[
                {"type":"tool_use","name":"Bash","input":{"command":"echo one\necho two"}}]}}"#,
        );
        match &events[0] {
            AgentEvent::Tool { detail, .. } => assert_eq!(detail, "Bash · echo one"),
            other => panic!("expected Tool, got {other:?}"),
        }

        let long = "a".repeat(200);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Read","input":{{"file_path":"{long}"}}}}]}}}}"#
        );
        match &parse(&line)[0] {
            AgentEvent::Tool { detail, .. } => {
                assert!(detail.chars().count() <= 87, "got {} chars", detail.chars().count());
                assert!(detail.ends_with('…'));
            }
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    #[test]
    fn permission_denial_becomes_an_approval_request() {
        let events = parse(
            r#"{"type":"system","subtype":"permission_denied","tool_name":"Edit",
                "tool_use_id":"toolu_1","message":"Claude requested permissions to write to src/a.ts"}"#,
        );
        match &events[0] {
            AgentEvent::Permission {
                request_id,
                tool,
                detail,
                scope,
            } => {
                assert_eq!(*scope, PermissionScope::SessionEdits);
                assert_eq!(request_id, "toolu_1");
                assert_eq!(tool, "Edit");
                assert!(detail.contains("src/a.ts"));
            }
            other => panic!("expected Permission, got {other:?}"),
        }
    }

    #[test]
    fn result_carries_real_usage_cost_and_context_window() {
        let events = parse(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"PONG",
                "total_cost_usd":0.0201,
                "usage":{"input_tokens":10,"output_tokens":213,
                         "cache_read_input_tokens":11609,"cache_creation_input_tokens":8922},
                "modelUsage":{"claude-haiku-4-5":{"contextWindow":200000}}}"#,
        );
        match &events[0] {
            AgentEvent::TurnEnd {
                text,
                usage,
                is_error,
            } => {
                assert_eq!(text, "PONG");
                assert!(!is_error);
                let u = usage.unwrap();
                assert_eq!(u.input_tokens, 10);
                assert_eq!(u.output_tokens, 213);
                assert_eq!(u.cache_read_tokens, 11609);
                assert_eq!(u.cache_creation_tokens, 8922);
                assert_eq!(u.total_cost_usd, Some(0.0201));
                assert_eq!(u.context_window, Some(200000));
                assert_eq!(u.context_used(), 10 + 213 + 11609 + 8922);
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    #[test]
    fn rate_limit_event_exposes_real_weekly_utilization() {
        let events = parse(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning",
                "resetsAt":1786190400,"rateLimitType":"seven_day","utilization":0.89}}"#,
        );
        assert_eq!(
            events,
            vec![AgentEvent::RateLimit {
                window: "seven_day".into(),
                utilization: 0.89,
                resets_at: Some(1786190400)
            }]
        );
    }

    #[test]
    fn compact_boundary_reports_a_compaction() {
        assert_eq!(
            parse(r#"{"type":"system","subtype":"compact_boundary"}"#),
            vec![AgentEvent::Compacted]
        );
    }

    #[test]
    fn malformed_and_noisy_lines_never_produce_events_or_panic() {
        for line in [
            "",
            "   ",
            "not json at all",
            "{",
            r#"{"type":"system","subtype":"status","permissionMode":"acceptEdits"}"#,
            r#"{"type":"system","subtype":"thinking_tokens"}"#,
            r#"{"type":"stream_event"}"#,
            r#"{"type":"assistant"}"#,
            r#"{"type":"rate_limit_event"}"#,
            r#"{"no_type":true}"#,
            "[1,2,3]",
            "null",
        ] {
            assert!(parse(line).is_empty(), "unexpected events from: {line}");
        }
    }

    #[test]
    fn deny_sends_nothing_at_all() {
        assert!(ClaudeAdapter
            .encode_permission_reply("Edit", "toolu_1", PermissionDecision::Deny)
            .is_empty());
    }

    #[test]
    fn approving_widens_the_mode_and_asks_for_a_retry() {
        let reply = ClaudeAdapter.encode_permission_reply("Edit", "toolu_1", PermissionDecision::Allow);
        assert_eq!(reply.len(), 2, "grant then retry");

        let mode: Value = serde_json::from_str(&reply[0]).unwrap();
        assert_eq!(mode["request"]["subtype"], "set_permission_mode");
        assert_eq!(mode["request"]["mode"], "acceptEdits");

        let retry: Value = serde_json::from_str(&reply[1]).unwrap();
        assert_eq!(retry["type"], "user");
        assert!(retry["message"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("retry"));
    }

    #[test]
    fn a_non_edit_tool_needs_the_broader_mode_and_says_so() {
        // acceptEdits would not unblock Bash, so approving it must not silently
        // do nothing — it widens further, and the scope reported to the UI says
        // exactly that.
        let reply = ClaudeAdapter.encode_permission_reply("Bash", "toolu_1", PermissionDecision::Allow);
        let mode: Value = serde_json::from_str(&reply[0]).unwrap();
        assert_eq!(mode["request"]["mode"], "bypassPermissions");

        let events = parse(
            r#"{"type":"system","subtype":"permission_denied","tool_name":"Bash",
                "tool_use_id":"t1","message":"wants to run rm"}"#,
        );
        match &events[0] {
            AgentEvent::Permission { scope, .. } => assert_eq!(*scope, PermissionScope::SessionAll),
            other => panic!("expected Permission, got {other:?}"),
        }
    }

    #[test]
    fn workspace_markers_are_declared_by_the_adapter_not_hardcoded_elsewhere() {
        let files: Vec<&str> = ClaudeAdapter.workspace_markers().iter().map(|m| m.file).collect();
        assert_eq!(files, vec!["CLAUDE.md", ".mcp.json"]);
    }

    #[test]
    fn handshake_and_interrupt_are_well_formed_control_requests() {
        let hs = ClaudeAdapter.handshake();
        let v: Value = serde_json::from_str(&hs[0]).unwrap();
        assert_eq!(v["request"]["subtype"], "initialize");

        let int = ClaudeAdapter.encode_interrupt().unwrap();
        let v: Value = serde_json::from_str(&int).unwrap();
        assert_eq!(v["request"]["subtype"], "interrupt");
    }
}
