# Phase 2 — Real Agent Execution

Read `plan/00-master-plan.md` first for tech stack and the `AgentAdapter` contract summary. This file is self-contained for execution.

## Goal

Replace Phase 1's mock `resp` generator with a real, running Claude Code CLI process wired into the transcript, via a PTY subprocess managed from Rust. Define the general `AgentAdapter` interface now (even though only Claude Code is implemented for real) so Codex/Gemini/Cursor/Aider can be added later as pure adapter implementations without touching UI code.

## Scope

**In scope:**
- **Spike (do this first, before finalizing the adapter trait): output-mode decision.** Claude Code has two fundamentally different integration surfaces, and the choice forks the whole architecture — it is not an implementation detail:
  - *Interactive PTY mode:* `claude` interactive is a full-screen TUI (Ink-based) that redraws via ANSI cursor movement, not a line-by-line stream. Segmenting that into transcript lines is brittle. Native slash commands (`/compact`, `/clear`, `/model`) work as the user knows them.
  - *Structured mode:* `claude -p --output-format stream-json --input-format stream-json` emits clean JSON events with real token/usage metadata (exactly what Phases 3–4 need), and `--resume <session-id>` provides session continuity. But slash-command passthrough and TUI-native behaviors differ from interactive mode.
  Prototype both against the installed CLI, pick one (or a hybrid), and **record the decision + rationale in this file** before building the parser, since Phase 3 (token counts) and Phase 4 (context/`/compact` parsing) both depend on which fork wins.
- Rust PTY process management using `portable-pty` (evaluate Tauri's official pty/shell plugin first if one exists and covers streaming I/O + resize + kill cleanly; fall back to `portable-pty` directly if not).
- Spawn the user's installed `claude` CLI binary (assume it's on `$PATH`; detect-and-error clearly if missing — no auto-install).
- Bridge: Rust reads PTY output continuously and emits Tauri events (e.g. `agent://output` with `{ session_id, chunk }`) to the frontend; frontend writes user input via a Tauri command (e.g. `agent_write(session_id, text)`).
- `AgentAdapter` trait (Rust) with at least: `id()`, `spawn(cwd) -> ProcessHandle`, `write(handle, input)`, `kill(handle)`, plus a way to detect "ready for input" vs "still generating" (needed to drive the `think` spinner state).
- Output parsing (shaped by the spike decision above): define a minimal parser that segments the stream into transcript-line-shaped chunks (map onto Phase 1's `resp`/`out`/`err`/`ok` line types as best-effort — exact fidelity to structured `tool:` lines etc. is best-effort in this phase, refined once real usage patterns are observed). If the spike lands on stream-json, the parser consumes JSON events; if it lands on interactive PTY, the parser **must strip/interpret ANSI escape sequences** (cursor movement, screen redraws, color codes) before any line-type segmentation — raw escape bytes must never reach the React transcript renderers.
- One real session end-to-end: open Kora, it spawns `claude` in the current workspace dir, user types a prompt, real Claude Code response streams into the transcript pane live (not batched).
- Session lifecycle: starting a new tab spawns a new `claude` process; closing a tab kills its process; app quit kills all child processes (no orphaned processes left running).
- Replace Phase 1's fake `checkContext()`/token math with a placeholder that still uses estimated token counts (real precise counts come in Phase 3/4) — but now counting actual characters sent/received from the real process instead of mock fixture data.
- **Command passthrough:** for slash commands the real Claude Code CLI already implements natively (`/compact`, `/clear`, `/cost`, `/review`, `/init`, `/memory`, `/model`), forward the raw command straight into the PTY input and render whatever the CLI prints back through the normal output parser — do not reimplement their logic in Kora. Only commands Claude Code does *not* have (`/agents`, `/accounts`, `/split`, `/tab`, Kora's own UI commands) are handled locally.
- **Process crash/recovery:** detect when the wrapped process dies unexpectedly (exit code, PTY closed unexpectedly) mid-session. Show a clear "agent process ended — respawn?" state in that pane (reuse the `err` line type) with a one-click respawn action. **Respawn must restore the conversation, not start fresh:** use Claude Code's own session continuity (`claude --continue`, or `claude --resume <session-id>` if the session id was captured at spawn) in the same working directory, so the recovered pane keeps its context. Fall back to a fresh spawn (with a clear "previous conversation could not be restored" note) only if resume fails. Do not silently leave a dead, unresponsive pane.
- **Existing project config detection:** on spawning a new session, check the workspace directory for `CLAUDE.md` and `.mcp.json` (Claude Code's own config files). If found, note their presence in the session's `banner` line (e.g. "Using project CLAUDE.md, 2 MCP servers configured") — purely informational, Kora doesn't need to parse or act on their contents, just acknowledge what the wrapped CLI is already picking up.

**Out of scope (explicitly deferred):**
- Codex, Gemini CLI, Aider real integrations — adapter trait must support them structurally, but only Claude Code gets a real implementation this phase. Other agents in `/agents` list stay UI-selectable but show a "not yet connected" state if selected (don't silently pretend to run them). **Cursor Agent is excluded from this list entirely** — per the master plan's scope adjustments, it stays a permanent UI-only stub, not a future real-integration candidate, because its CLI agent surface is too immature to wrap reliably.
- Multi-account switching for Claude Code (Phase 3) — this phase runs against whatever `claude` auth is already active in the user's environment.
- Precise token/cost accounting (Phase 3/4) — approximate is fine here.
- Split-pane running two *real* processes simultaneously is allowed if Phase 1's split-view already supports independent panes — just ensure each pane's process is tracked independently by session id.

## Security

- Spawn the `claude` process via Rust's `Command`/`portable-pty` argv array (`Command::new("claude").arg(...)`), never a shell-interpolated string — the workspace `cwd` and any user input passed as args must not be able to inject shell syntax.
- The Tauri commands introduced here (`agent_spawn`, `agent_write`, `agent_kill`) must be explicit allowlist entries in Tauri's capability config, with `session_id`/input args validated in Rust before use — see master plan's "Security (Cross-Cutting)" section, point 2.
- PTY output rendered into the transcript follows Phase 1's plain-text/no-raw-HTML rule — this is the first phase where the content being rendered is genuinely untrusted (real model output), so treat it as the first real enforcement point of that rule, not just a carried-over convention.

## Key Files/Modules to Create/Modify

```
src-tauri/
  src/
    adapters/
      mod.rs            # AgentAdapter trait definition
      claude.rs          # real Claude Code adapter impl
    pty/
      manager.rs         # spawn/track/kill PTY processes by session_id
      parser.rs           # stream -> transcript-line-shaped events
    commands.rs           # Tauri commands: agent_spawn, agent_write, agent_kill
    main.rs                # register commands + event emitter setup
src/
  state/
    sessionStore.ts        # extend: real session now backed by a live process id, not mock RESP
    agentBridge.ts          # frontend wrapper around Tauri invoke()/listen() for agent:// events
```

## Reference

- `docs/features.gpt.md` §3 (Model Management), §26 (Provider Adapter Architecture) — adapter must expose commands/models/auth/capabilities/pricing/context-limits per provider, even if only Claude's are populated for real right now.
- `docs/features.claude.md` / `docs/features.gemini..md` §3 — "Agent Adapter Architecture," confirms adapters should support full tool-use execution, bash tool execution, file edits for the Claude Code adapter specifically.
- Phase 1's `commandRouter.ts` and transcript line types — do not change their shape; only change where `resp` line data comes from (real stream vs. mock array).

## Acceptance Criteria

1. Launching Kora with Claude Code as the active agent and typing a real coding question produces a live, streaming real response from the actual `claude` CLI — not a mock/random one.
2. Closing a session tab or quitting the app leaves no orphaned `claude` child processes (`ps aux | grep claude` clean afterward).
3. If `claude` is not installed/on PATH, Kora shows a clear error line in the transcript (using the existing `err` line type from Phase 1) rather than crashing or hanging.
4. Switching `/agents` to Codex/Gemini/etc. (still UI-only) clearly indicates "not connected yet" rather than silently behaving like Claude.
5. The `AgentAdapter` trait is documented well enough (doc comments) that adding a second real adapter later requires touching only `src-tauri/src/adapters/`, not the PTY manager, Tauri commands, or any frontend code.
6. Killing the `claude` process externally (e.g. `kill -9` in a terminal) while a Kora session is open surfaces a respawn prompt in that pane within a few seconds, and clicking it produces a working session again — with the prior conversation restored via `--continue`/`--resume` (verify by asking a follow-up question that requires earlier context), falling back to a clearly-labeled fresh session only if resume fails.
7. Opening a workspace containing a `CLAUDE.md` or `.mcp.json` shows an informational note in the session banner; opening one without either shows no such note.
8. Running `/compact`, `/clear`, `/cost` in a real session visibly invokes the real Claude Code CLI behavior (observable via its actual output), not a Kora-side reimplementation.
