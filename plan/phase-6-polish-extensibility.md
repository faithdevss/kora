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
- `docs/features.claude.md` / `docs/features.gemini..md` §7 (Local Caching Layer, Async Streaming Render Engine). Note: §7's "Zero Bloat Policy" (no webviews, pure-TUI stack) was overridden by the master plan's Tauri decision — don't treat it as a binding target here; the perf pass documents real measured numbers instead.
- Phase 2's `AgentAdapter` trait doc comments — this phase should not need to modify that trait, only document/finalize it as the public extension surface.

## Acceptance Criteria

1. Every shortcut listed in `docs/features.gpt.md` §21 works from anywhere in the app (not just when the command input is focused where applicable).
2. Settings changes (theme/font/default agent/etc.) persist across app restarts.
3. A context-limit notification actually fires under real usage (from Phase 4's tracker) without needing to hit `/usage` manually to notice.
4. Measured cold-start time and idle RAM usage are documented in this file (or a follow-up note) as the actual v1 baseline, replacing the docs' aspirational targets with real numbers.
5. A written note (in this file or `plan/00-master-plan.md`) confirms what a future contributor needs to do to add a second real agent (e.g. Codex) — should be "implement `AgentAdapter` for Codex in `src-tauri/src/adapters/codex.rs`, register it, add its account/model metadata" and nothing else.
