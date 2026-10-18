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

  > **DECISION (recorded 2026-08-06, spiked against `claude` 2.1.223) — structured mode wins outright.** See "Spike Results" at the bottom of this file for the evidence. Every doubt the fork description raises about structured mode turned out to be false: slash commands pass through, the process persists across turns, and output streams token-by-token. Interactive PTY mode was not prototyped further once the structured path cleared every requirement, because it is strictly worse on all of them and adds an ANSI-parsing burden.
  >
  > **Consequences that override statements elsewhere in this file:**
  > - **No PTY.** Structured mode is plain stdin/stdout pipes, so `portable-pty` is not a dependency and there are no ANSI escapes to strip. `src-tauri/src/pty/` is therefore built as `src-tauri/src/proc/` — same role, honest name.
  > - **The parser consumes JSON events**, not text segmentation.
  > - **Permission approval is surfaced in Kora's UI** rather than auto-accepted, using the CLI's `set_permission_mode` control request. This adds a `perm` transcript line type — the one addition to Phase 1's line-type set. Note the CLI offers no per-call gate; see finding 7 below for exactly what it does and does not support.
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
- `docs/features.claude.md` §3 — "Agent Adapter Architecture," confirms adapters should support full tool-use execution, bash tool execution, file edits for the Claude Code adapter specifically.
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

---

## Spike Results — output-mode decision

Run against `claude` 2.1.223 (macOS, `~/.local/bin/claude`) on 2026-08-06. Raw transcripts were captured to a scratch dir; the findings below are what drove the decision.

### What was tested

| # | Question | Result |
|---|---|---|
| 1 | Does `-p --output-format stream-json` emit usable events? | Yes. `system/init`, `assistant`, `user` (tool results), `system/*` status events, `rate_limit_event`, `result`. |
| 2 | Can one process serve many turns? | Yes. `--input-format stream-json` keeps the process alive; three turns ran over one process with one `session_id`, and turn 2 recalled turn 1's content. Process exits 0 when stdin closes. |
| 3 | Do slash commands pass through? | **Yes** — the doubt in the fork description was wrong. `/cost` and `/compact` both executed the real CLI behavior and returned real output. `/cost` reported `num_turns: 0` and no cost delta, confirming the CLI handles them locally without an API round-trip. |
| 4 | Is output actually streaming, or batched per turn? | Streaming. `--include-partial-messages` produces `stream_event` / `content_block_delta` frames (31 deltas in one short turn), plus `content_block_start` naming each block's type and, for tools, the tool name. |
| 5 | Is real usage metadata available? | Yes, and richer than Phase 3 needs: `result.usage` (input/output/cache-creation/cache-read), `result.total_cost_usd`, and `result.modelUsage[model].contextWindow` — the real context window, which Phase 4 needs. |
| 6 | What happens when a tool needs permission? | With no handshake: the tool is **denied**, surfacing `system/permission_denied` plus `result.permission_denials[]`. There is no interactive approval path by default. |
| 7 | Can Kora influence permissions at all? | **Partly — and less than first assumed.** The CLI does implement the control protocol on stdin: `control_request/initialize` returns a `control_response` carrying the full slash-command list with descriptions, and `set_permission_mode` takes effect immediately (echoed as a `system/status` event). **But the CLI never *asks*.** Re-tested afterwards under `--permission-mode default` and `--permission-mode manual`, with and without the initialize handshake: in every case a blocked tool produced `system/permission_denied` and the turn continued. The `can_use_tool` strings in the binary belong to its bundled SDK acting as a *client* to a subprocess, not to the CLI acting as one. So there is no pre-execution gate to hook. |

### Why structured mode, concretely

- It is the only mode that satisfies acceptance criterion 1 (live streaming) **and** criterion 8 (real CLI slash-command behavior) at the same time. The fork description assumed these traded off against each other; they do not.
- Phases 3 and 4 get their data for free and exactly, rather than by scraping a redrawing TUI: real token counts, real cost, real context window, real compaction boundaries (`system/compact_boundary` fires on `/compact`).
- Session continuity is first-class: `--session-id <uuid>` lets Kora *choose* the id at spawn, so crash recovery uses `--resume <that id>` with no id-capture race. Interactive mode would require scraping the id out of TUI output.
- Interactive mode's only advantage was native slash commands, and structured mode has those too.

### Resulting architecture

```
claude -p --input-format stream-json --output-format stream-json \
       --verbose --include-partial-messages --replay-user-messages \
       --session-id <uuid-kora-generated> [--resume <uuid> on respawn] \
       --model <model-id>
```

- **Handshake:** on spawn Kora sends `control_request/initialize`, which both advertises `can_use_tool` support and returns the agent's real slash-command list (used to populate `/help` and the palette per agent, replacing Phase 1's static `CMD_DESC` for connected agents).
- **Permissions:** the session runs in the CLI's default (deny) mode, so no tool runs unapproved — but the flow is **attempt → deny → approve → retry**, not a pre-execution gate, because the CLI refuses and reports rather than waiting for an answer. A `system/permission_denied` renders a `perm` line; approving sends `set_permission_mode` (`acceptEdits` for file edits, `bypassPermissions` for anything broader) plus a retry turn. The approve button states the real scope, since every grant is session-wide — Kora cannot offer a one-call approval the CLI does not support. Revisit if a future CLI exposes `--permission-prompt-tool` or emits `can_use_tool` to its own stdout.
- **Interrupt:** `control_request/interrupt` backs a stop action mid-generation.
- **Crash recovery:** the spawn uuid is stored on the session, so respawn is `--resume <uuid>` in the same cwd, with a fresh spawn as the clearly-labeled fallback.

### Corrections to earlier plan documents

1. **`00-master-plan.md` → "Weekly quota is not a real number" is wrong** and is amended there. `rate_limit_event` carries `{rateLimitType: "seven_day", utilization, resetsAt, status}` on every turn, and `/cost` prints real session and weekly percentages. The WEEK meter shows real utilization with its real reset time.
2. **`portable-pty` is not used.** Structured mode needs no terminal emulation. This also removes the ANSI-stripping requirement that the in-scope list attached to the interactive fork.
