# Phase 6 — Polish, Settings & Extensibility

Read `plan/00-master-plan.md` first. This file is self-contained for execution.

## Goal

Close out the remaining docs features that don't block core usability: full keyboard-shortcut coverage, a real Settings panel, notifications, a performance pass against the docs' stated targets, and finalized extension points for future providers/integrations.

## Scope

**In scope:**
- **Command palette:** `Ctrl+Shift+P` global overlay searching commands, models, agents, sessions, and settings in one list (distinct from the `/`-prefixed in-input palette from Phase 1 — this is a global, always-available overlay).
- **Full keyboard-first shortcut set:** `Ctrl+K` search, `Ctrl+L` clear, `Ctrl+R` history, `Ctrl+Shift+C`/`Ctrl+Shift+V` copy/paste, plus whatever additional bindings feel natural for tab switching/split-view toggling — make bindings centrally defined (one keymap module) so Settings can later remap them.
- **Settings panel:** theme (start with just the one dark theme from the design, structured so more can be added later), font, status bar visibility/config, default model/account/agent, auto-compact toggle (wired to Phase 4's compaction logic), notification toggles. Persist to local config file.
- **Notifications:** non-intrusive OS-level or in-app toast notifications for: nearing context limit (ties into Phase 4), authentication expired, update available, request failed, usage limit reached (ties into Phase 3). Use Tauri's notification plugin for OS-level ones where appropriate.
- **Performance pass:** measure actual cold-start time against the docs' <100ms target (note: Tauri startup is unlikely to hit sub-100ms in practice the way a pure Rust TUI would — treat this as "as fast as practically achievable for the chosen stack" and document the measured baseline rather than blocking on an unrealistic literal number), profile RAM usage under multiple sessions/panes, verify async/non-blocking rendering holds up while a real agent streams large code blocks (from Phase 2), add lazy-loading where startup cost is dominated by rarely-used UI (e.g. don't eagerly load the full markdown/syntax-highlight bundle from Phase 5 until first needed).
- **Extensibility finalization:** document the `AgentAdapter` trait (from Phase 2) as the stable extension point for adding Codex/Gemini/Cursor/Aider/custom agents as real integrations post-v1; stub out (interface only, no implementation) hooks for future MCP server management and Git integration mentioned in docs §30, without building their UIs.
- **Update mechanism stub:** `/version`, `/update` commands at least report current version and check-for-update state (real auto-update wiring can be minimal/manual for v1 — e.g. link to a releases page rather than building a full updater).

**Out of scope (v1 non-goals per master plan):** Windows/Linux builds, plugin marketplace, real MCP UI, IDE integrations, local LLM support, prompt library.

## Security

- **Finalize CSP lockdown** in `tauri.conf.json`: no remote script/style sources permitted, consistent with local font bundling from Phase 1 — audit that no phase introduced a runtime fetch to an external CDN.
- **Notification text must be generic**, not contain raw prompt/response content — OS notifications can surface on a locked screen. E.g. "Context nearing limit in `api-gateway` session," not a quoted excerpt of the conversation.
- Settings persistence must not become a second place credentials leak into — confirm the settings config file contains no account keys/tokens (those stay keychain-only per the master plan).
- Do a pass over every Tauri command registered across all phases and confirm each is an explicit allowlist entry with Rust-side arg validation — this phase is the natural point to audit the cumulative IPC surface, not just add new commands to it.

## Key Files/Modules to Create/Modify

```
src-tauri/
  src/
    settings/
      config.rs           # persisted settings model
    notifications/
      dispatch.rs
src/
  components/
    SettingsPanel.tsx
    GlobalCommandPalette.tsx
    NotificationToast.tsx
  state/
    keymap.ts               # centralized shortcut bindings
    settingsStore.ts
```

## Reference

- `docs/features.gpt.md` §20–§21 (Command Palette, Keyboard First), §24 (Notifications), §27 (Performance), §29 (Settings), §30 (Extensibility).
- `docs/features.claude.md` §7 (Local Caching Layer, Async Streaming Render Engine). Note: §7's "Zero Bloat Policy" (no webviews, pure-TUI stack) was overridden by the master plan's Tauri decision — don't treat it as a binding target here; the perf pass documents real measured numbers instead.
- Phase 2's `AgentAdapter` trait doc comments — this phase should not need to modify that trait, only document/finalize it as the public extension surface.

## Acceptance Criteria

1. Every shortcut listed in `docs/features.gpt.md` §21 works from anywhere in the app (not just when the command input is focused where applicable).
2. Settings changes (theme/font/default agent/etc.) persist across app restarts.
3. A context-limit notification actually fires under real usage (from Phase 4's tracker) without needing to hit `/usage` manually to notice.
4. Measured cold-start time and idle RAM usage are documented in this file (or a follow-up note) as the actual v1 baseline, replacing the docs' aspirational targets with real numbers.
5. A written note (in this file or `plan/00-master-plan.md`) confirms what a future contributor needs to do to add a second real agent (e.g. Codex) — should be "implement `AgentAdapter` for Codex in `src-tauri/src/adapters/codex.rs`, register it, add its account/model metadata" and nothing else.

---

## Implementation notes

### Measured baseline (acceptance criterion 4)

Measured on the release build (`npm run tauri build -- --no-bundle`), macOS
15 / Apple Silicon, with `KORA_TIMING=1` — the instrumentation is in
`main.rs`/`lib.rs` and prints process-start → `RunEvent::Ready`, so anyone can
re-measure rather than take these on trust.

| | measured |
|---|---|
| Cold start (first launch, page cache cold) | **649 ms** |
| Warm start (median of 4) | **~223 ms** (218–242 ms) |
| Idle RAM, main process | **~104 MB** |
| Idle RAM, WebKit helpers (GPU + Networking + WebContent) | **~101 MB** |
| Idle RAM, total | **~205 MB** |
| Startup JS (gzipped) | **73.6 KB** (was 135.7 KB before the split below) |
| Markdown chunk, loaded on first agent response | 66.5 KB gzipped |
| Binary | 5.1 MB |

**The docs' "<100 ms" target is not met and cannot be by this stack.** Roughly
200 ms of a warm start is WebKit process creation and webview initialization,
before any Kora code runs — the master plan chose Tauri for the design fidelity
the mockup needs, and a sub-100 ms window belongs to a pure-TUI process. These
are the real v1 numbers; treating the aspirational one as a target would mean
either lying about it or rewriting the stack.

RAM is dominated the same way: ~205 MB idle is the cost of one WebKit web
content process, not of Kora's state. Per-session cost above that is one
`claude` child process, which belongs to the agent and would exist for a plain
CLI too.

**What the perf pass changed:** the markdown/highlight bundle (marked +
DOMPurify + highlight.js, two-thirds of the JavaScript) is now a separate chunk
loaded when an agent first says something, not at startup — see
`state/markdownLazy.ts`. Startup JS fell 46%. Streaming stays responsive
because deltas render as plain text and only become markdown when the turn
settles (Phase 5), so a large code block is never re-parsed per token.

### Notifications are in-app, not OS-level

The plan allowed either. In-app toasts ship, and no notification plugin was
added, for two reasons: an OS notification can surface on a locked screen or in
a screen share of another app, and adding the plugin widens the permission
surface this phase is meant to be auditing. The *content* rule is written as if
they were OS-level anyway — every notification names the session and the
condition, never a line of the conversation, and there is a test that puts a
fake password in a prompt and asserts no toast repeats it. Moving to the
notification plugin later is a delivery change, not a content one.

### Auto-compact

Off by default. When on, crossing 90% sends the agent its own `/compact`
instead of raising a notification — Kora still never summarizes anything
itself (Phase 4, acceptance criterion 5).

### IPC audit (Security, bullet 4)

All 37 registered commands were walked. Every one is an explicit
`invoke_handler` entry, and each validates what it accepts:

- **Session ids** — `validate_session_id` on all 12 commands that take one;
  alphanumeric/`-`/`_` only, so an id can never become a path or an argv entry.
- **Paths** — canonicalized before use, directories refused, and for exports
  only `~` is expanded (`file_ingest`, `file_open_in_editor`, `file_save`,
  `sessions_export_file`, `sessions_import_file`).
- **Sizes** — prompts, attachments, base64 payloads, saved blocks, and session
  imports all bounded.
- **Free text** — this audit found the gap: names, search queries, media types
  and model ids had no length bound. `validate_len` (4 KB) was added across
  `accounts_add`, `accounts_rename`, `sessions_rename`, `sessions_search`,
  `sessions_import`, `usage_record`, and the file commands.
- **Settings** — `Settings::sanitized()` clamps the font size, rejects an
  unknown density, and drops a font family that is not name-shaped, because
  that value reaches a CSS custom property.

CSP is unchanged and already local-only: `default-src 'self'`, no remote script
or style source, fonts bundled since Phase 1. Nothing added in Phases 2–6
fetches from a CDN — the only network access in Kora is the agent's own, in the
agent's own process.

Settings persistence carries no credentials, and the test
`the_settings_file_is_not_a_second_place_for_secrets` fails if a token-shaped
field is ever added to the struct.

### Extensibility

`docs/adding-an-agent.md` is the answer to acceptance criterion 5: implement
`AgentAdapter`, register it, add a catalogue entry — and explicitly, do not
touch the process manager, the command surface, or any other TypeScript.

`integrations/mcp.rs` and `integrations/git.rs` are declared and unimplemented
on purpose, with the design constraint written down (MCP stays a view over what
the agent reports; git stays read-only, because writes belong to the agent where
the user can approve them as tool calls).

### Not done

- **Remapping shortcuts.** The keymap is centralized as the plan asked and the
  settings panel lists it, but editing bindings is not built — the table is the
  groundwork, not the feature.
- **A second theme.** The setting and the `/theme` command exist and one theme
  ships; `/theme` says so rather than implying a choice.
- **A real updater.** `/version` and `/update` report the build and point at
  releases. `self_update: false` is in the payload so the UI cannot imply
  otherwise.
