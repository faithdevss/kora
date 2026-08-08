# Adding a second real agent

Kora wraps agent CLIs behind one trait. Adding Codex, Gemini, Aider or anything
else is **three edits and a test file** — no changes to the process manager, the
Tauri command surface, or any TypeScript.

This document is the answer to phase-6 acceptance criterion 5. If adding an
agent ever needs more than what is listed here, that is a bug in the abstraction
rather than a step to add to this list.

## The three edits

### 1. Implement `AgentAdapter`

Create `src-tauri/src/adapters/<agent>.rs` and implement
[`AgentAdapter`](../src-tauri/src/adapters/mod.rs). The trait is the whole
contract; its doc comments say what each method is for. The parts that matter:

| Method | What it decides |
|---|---|
| `spawn_spec` | argv, cwd and env for one session. **argv array, never a shell string.** |
| `parse_line` | one line of the agent's stdout → zero or more `AgentEvent`s |
| `encode_prompt_with` | a user turn, with attachments, in the agent's own protocol |
| `handshake` | anything to send before the first prompt |
| `capabilities` | what the UI may offer — `Vision` gates image attachment |
| `account_env` / `auth_status_argv` / `parse_auth_status` / `login_argv` | multi-account support, if the CLI can scope its auth to a directory |
| `list_models_request` | the model list, queried live rather than hardcoded |
| `encode_interrupt` / `encode_permission_reply` | stop, and permission answers |
| `workspace_markers` | config files the CLI reads on its own, for the banner |

An agent that cannot do one of these returns `None`; the UI adapts rather than
pretending. `parse_line` takes `&self` on a long-lived shared instance, so an
agent that must accumulate across lines can hold its own state.

### 2. Register it

Add one line to `registry()` in `src-tauri/src/adapters/mod.rs`.

### 3. Add its catalogue entry

Add the agent to `AGENTS` in `src/state/mockFixtures.ts`: id, display name,
vendor, accent colour, and a placeholder model list. The placeholder is only
used before a process is running — a live CLI reports its real models at
handshake and those win.

## What you do **not** touch

- `proc/manager.rs` — spawns whatever `SpawnSpec` you return, pumps stdout
  line-by-line, owns process lifetime, process groups and teardown.
- `commands.rs` — the Tauri surface is agent-agnostic.
- Any TypeScript beyond the catalogue entry. The frontend consumes
  `AgentEvent`, not agent-specific shapes.
- Accounts, usage, session persistence, search, settings — all of it is keyed
  by `agent_id` and works the moment the adapter exists.

## Testing it

`src-tauri/tests/session_lifecycle.rs` drives a **stub agent**: a shell script
that speaks the protocol on stdout. Copy one of the existing stubs, point
`KORA_<AGENT>_BIN` at it, and the whole spawn → parse → emit → kill path is
covered with no API cost and no network. Unit-test `parse_line` directly against
recorded output lines — that is where most adapter bugs live.

## Practical advice from doing it once

- **Spike before implementing.** Both real spikes so far
  (`plan/phase-2-agent-exec.md`, `plan/phase-3-accounts-usage.md`) overturned an
  assumption the plan was built on. Run the CLI by hand, capture real output,
  and write the findings down before the adapter.
- **Passthrough beats reimplementation.** If the CLI has a command, forward it
  and parse the answer. Kora owns its own UI commands and nothing else.
- **Report nothing you were not told.** Every number Kora shows is one the agent
  reported; unknowns render as "—" rather than a plausible guess.
