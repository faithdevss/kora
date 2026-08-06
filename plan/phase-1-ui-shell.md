# Phase 1 — UI Shell & Design Port

Read `plan/00-master-plan.md` first for tech stack, design tokens, and cross-phase conventions. This file is self-contained for execution — no other phase file is needed yet.

## Goal

Stand up the Tauri + React app and port `docs/design/Kora Terminal.dc.html` into real, working components, pixel-close to `docs/design/.thumbnail`, running entirely on **mock data** (no real agent processes, no real accounts). This phase proves out the full visual/interaction design before any backend complexity is added.

## Scope

**In scope:**
- Tauri project scaffold (`src-tauri/` + `src/` per the layout in the master plan) targeting macOS.
- Title bar: traffic-light dots (decorative, macOS native chrome can replace these — decide during build whether to use Tauri's native title bar or the custom one from the mockup; prefer native macOS title bar + keep the mockup's search/split/settings icon row), workspace path, search icon, split-view icon, settings icon (icon-only, no-op is fine for now beyond search/split).
- Tab bar: session tabs with agent-color dot, name, close button, "+" new tab button, horizontal scroll for overflow. **New-tab default: inherits the currently-focused tab's agent + account** (deliberate deviation from the mockup's `newTab()`, which hardcodes every new tab to Claude Code — that's a prototype shortcut, not the intended behavior). User can still override via `/agents`/`/accounts` on the new tab.
- Status bar: agent name, account name, model name, CONTEXT gauge (label + bar + %), SESSION in/out token counts, WEEK usage bar + text, suggestion chip (amber, click-to-run).
- Main pane(s): split-view capable (1 or 2 panes side by side), each with its own scrollable transcript and its own input row when focused; blurred/unfocused pane shows "session running in background — click to focus" bar instead of an input.
- Transcript line renderers for all 12 line types from the mockup: `banner`, `cmd`, `resp` (with optional code block + tool line), `out`, `dim`, `ok`, `err` (with "did you mean" hint), `think` (spinner), `warn` (with quick-action chips), `list` (agents/accounts/models picker), `help` (common + per-agent command grid), `panel` (usage/statistics/cost card layout).
- Command input: `/`-prefixed palette autocomplete dropdown (up to 6 matches, click or Tab to accept), placeholder text, attach button, attachment chips row (remove-able), `⏎ send` hint, ↑/↓ command history navigation, Escape to clear/close.
- Search overlay: floating panel, query input, match count, close button (UI only — wire to real scrollback search in Phase 5, but do local text-match highlighting against mock transcript now since the prototype already does this).
- Mock data layer: port the mockup's `AGENTS`, `ACCT`, `RESP`, `CMD_DESC`, `COMMON` fixtures into TypeScript, driving the same interactions (`/agents`, `/accounts`, `/models`, `/usage`, `/statistics`, `/cost`, `/clear`, `/compact`, `/help`, `/diff`, `/tools`, `/memory`, `/review`, `/init`, `/split`, `/tab`, `/search`) exactly as `runCommand()` does in the prototype script.
- Keyboard: Enter to submit, Escape to clear/close overlays, Tab-complete for `/` commands, ↑/↓ history, paste-image-as-attachment stub (creates a placeholder attachment chip, no real image handling yet — that's Phase 5).
- Density setting stub (`comfortable`/`compact`) affecting font-size/line-height/padding, matching mockup's `density` prop — hardcode to `comfortable` with the toggle wired but not yet exposed in a settings UI (Settings UI itself is Phase 6).

**Out of scope (explicitly deferred):**
- Any real subprocess/PTY spawning (Phase 2).
- Real credential storage / keychain (Phase 3).
- Real token/cost computation — keep the mockup's simulated `estTok`/random-response logic (Phase 3 replaces it).
- Real context-threshold logic beyond porting the existing mock `checkContext()` behavior (Phase 4 makes it real).
- Actual image/file upload, drag-drop handling (Phase 5).
- Global keyboard shortcuts beyond the input-focused ones above (`Ctrl+K/L/R`, `Ctrl+Shift+P`, `Ctrl+Shift+C/V`) — Phase 6.
- Settings panel, notifications, theming beyond the single dark theme in the mockup — Phase 6.

## Security

All 12 transcript line renderers (`resp`, `out`, `err`, etc.) render agent/mock text as plain text/React children, never `dangerouslySetInnerHTML` — set this pattern now since Phase 5's real markdown renderer builds on these same components. Even against mock data, don't establish a raw-HTML-injection habit here. See master plan's "Security (Cross-Cutting)" section.

## Key Files/Modules to Create

```
src-tauri/
  tauri.conf.json
  src/main.rs                 # minimal — just boots the webview, no commands yet
src/
  main.tsx, App.tsx
  theme.css                   # design tokens from master plan, verbatim
  types/
    agent.ts                  # Agent, Model, Account, Session, TranscriptLine types
  state/
    mockFixtures.ts            # ported AGENTS / ACCT / RESP / CMD_DESC / COMMON
    sessionStore.ts             # session/tab/pane state (mirrors prototype's Component state)
    commandRouter.ts            # runCommand() port — dispatches slash commands
  components/
    TitleBar.tsx
    TabBar.tsx
    StatusBar.tsx
    Pane.tsx / SplitView.tsx
    CommandInput.tsx / CommandPalette.tsx
    SearchOverlay.tsx
    transcript/
      BannerLine.tsx, CmdLine.tsx, RespLine.tsx, OutLine.tsx, DimLine.tsx,
      OkLine.tsx, ErrLine.tsx, ThinkLine.tsx, WarnLine.tsx, ListLine.tsx,
      HelpLine.tsx, PanelLine.tsx
```

## Reference

- Layout/behavior: `docs/design/Kora Terminal.dc.html` (read the `<script type="text/x-dc">` block directly — it is the full interaction spec: `AGENTS`, `ACCT`, `CMD_DESC`, `COMMON`, `RESP`, and every method on `Component`).
- Visual reference screenshot: `docs/design/.thumbnail` (WebP — view it to confirm spacing/color match).
- Do **not** import or ship `docs/design/support.js` — it's the prototyping tool's runtime (a custom `DCLogic`/React shim), not a real dependency. Re-derive the same visual output using real React + the types above.

## Acceptance Criteria

1. `cargo tauri dev` boots a window matching `docs/design/.thumbnail` within reasonable visual fidelity (colors, spacing, fonts).
2. Typing `/help`, `/agents`, `/accounts`, `/models`, `/usage`, `/statistics`, `/cost`, `/clear`, `/compact`, `/diff`, `/tools`, `/memory`, `/review`, `/init` each produce the same panel/list/response shape as the prototype.
3. Sending a free-text prompt shows a `think` spinner line, then replaces it with a random mock `resp` line (matching prototype's `runPrompt` timing/behavior).
4. Context usage crossing ~72% triggers the amber `warn` banner with working `/compact` and `/clear` quick-action chips (mock thresholds only — no real token math yet).
5. `/split` opens a second pane; both panes render independently; clicking a blurred pane focuses it and its input reappears.
6. `/agents <name>`, `/accounts <name>`, `/models <name>` (and clicking list items) correctly switch the active agent/account/model, updating the status bar and accent color/glow throughout the UI.
7. Tab-complete and ↑/↓ history work in the command input; unknown `/xyz` commands show an error line with a Levenshtein-based "did you mean" suggestion, matching the prototype's `suggestCmd`.
8. No Rust-side process spawning, network calls, or keychain access exists yet — verify by code review of `src-tauri/src/`.
