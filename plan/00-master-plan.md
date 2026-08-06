# Kora — Master Plan

> Source docs: `docs/features.gpt.md` (primary, 30 features), `docs/features.claude.md` / `docs/features.gemini..md` (identical to each other, narrower — secondary confirmation), `docs/design/Kora Terminal.dc.html` (interactive design prototype, fake data) + `docs/design/.thumbnail` (reference screenshot).

Read this file first in every phase session. Then read only the one `phase-N-*.md` you're executing — do not need the others.

---

## Product Summary

Kora is "one terminal, every agent": a fast, lightweight desktop app that runs multiple AI coding agent CLIs (Claude Code, Codex, Gemini CLI, Cursor Agent, Aider, custom agents) through one unified interface. It supports multi-account switching per provider, live token/cost telemetry in an always-visible status bar, automatic context-window monitoring with optimization suggestions (`/compact`, `/clear`), session tabs with split-pane view, a `/`-driven command palette, and rich content support (images, files, markdown, code blocks, diffs). Every agent plugs in through a common adapter interface so commands, models, and capabilities adapt dynamically per active agent.

---

## Tech Stack

- **Shell:** Tauri 2.x (Rust backend + system webview frontend). Chosen over Electron for startup time / RAM footprint (docs target <100ms startup), over raw TUI because the design mockup uses rounded corners, glow effects, and split web-style layout that isn't ANSI-representable, and over a plain web app because we need real OS keychain access and local subprocess/PTY spawning.
- **Frontend:** TypeScript + React + Vite. React chosen because the design prototype (`Kora Terminal.dc.html`) is already written against a `React.createElement`-based runtime (`support.js`, a prototyping-tool runtime — **not** shippable, do not reuse it directly, but its component shape maps cleanly to real React).
- **Styling:** Plain CSS (CSS Modules or vanilla `.css` files), not a utility framework like Tailwind. The mockup specifies exact hex values and pixel sizes per element — reproduce those tokens directly (see Design Tokens below) rather than remapping into a utility system.
- **Backend/process layer:** Rust. ~~PTY subprocess spawning via `portable-pty`~~ — **amended after the Phase 2 spike:** agents are driven in structured mode (`--input-format/--output-format stream-json`) over plain stdin/stdout pipes, so no terminal emulation and no `portable-pty` dependency. Tauri commands + events bridge Rust ↔ React.
- **Credential storage:** OS keychain via Tauri's `keyring` / stronghold plugin (macOS Keychain first; Phase 3).
- **Font:** JetBrains Mono (Google Fonts, as referenced in the mockup) — bundle it locally instead of a runtime Google Fonts fetch, since docs call for no-network-by-default / low startup latency.

---

## Design Tokens (from `docs/design/Kora Terminal.dc.html`)

Pull these verbatim into a single `theme.css` (or `tokens.ts`) in Phase 1 — every later phase reuses them, never re-derive hex values from scratch.

**Base palette**
| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#0d0e11` | app background |
| `--panel` | `#14161b` | overlays, palette, panels |
| `--panel-alt` | `#0f1116` | cards, list items |
| `--border` | `#23262e` | card/panel borders |
| `--border-dim` | `#1c1f26` | header/divider borders |
| `--text` | `#d7dbe2` | body text |
| `--text-bright` | `#f2f4f8` | headings, active labels |
| `--dim` | `#727a88` | secondary text |
| `--dim2` | `#565d6b` | tertiary/meta text |
| `--green` | `#5bb98c` | success, input tokens, healthy |
| `--red` | `#e5695f` | error, danger |
| `--amber` | `#e0a34a` | warning, suggestion chip |
| `--blue` | `#5a9df6` | output tokens, weekly meter |

**Per-agent accent colors**
| Agent | Accent |
|---|---|
| Claude Code | `#d97757` |
| Codex | `#19c37d` |
| Gemini CLI | `#4587f5` |
| Cursor Agent | `#9b8cff` |
| Aider | `#e8a33d` |
| Custom Agent | `#8a94a6` |

**Typography/layout:** `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`; title bar 30px; tab bar 36px; status bar 33px; base font 13–13.5px (12px in "compact" density mode); border-radius 6–10px depending on element; context/week meter bars are 6px-tall rounded pills.

---

## Deduplicated Feature Inventory

Merged from all 3 docs + observed mockup behavior. Each group maps to the phase that delivers it.

1. **Agents & Providers** — multi-agent adapter architecture, `/agents` switch, dynamic per-agent command/model/capability inheritance, capability detection (vision/tools/files/web search/code exec/MCP/streaming/reasoning/function calling) → **Phase 2**
2. **Accounts** — multi-account per provider, `/accounts` `/users`, encrypted keychain storage, per-account usage/plan tracking, workspace-based auto-detection → **Phase 3**
3. **Models** — `/models` per-agent model list, favorites/recents/search, instant switch → **Phase 3**
4. **Sessions/Tabs** — new/save/rename/delete/list/pin/archive/export/import, split view, background session indicator → **Phase 1** (UI + tab state), persistence in **Phase 3**
5. **Status bar telemetry** — agent/account/model, context % gauge, session in/out tokens, weekly usage meter, suggestion chip → **Phase 1** (UI, mock data), **Phase 3** (real data)
6. **Usage/Statistics/Cost panels** (`/usage`, `/statistics`, `/cost`) — card-based breakdowns → **Phase 1** (UI, mock), **Phase 3** (real)
7. **Context monitoring & optimization** — % bar, 70%/90% threshold warnings, `/compact`, `/clear`, `/summarize`, auto-suggestions (cache reuse, prompt shortening, task splitting, cheaper-model switch) → **Phase 4**
8. **Search** — command palette (`Ctrl+Shift+P`), scrollback search (`Ctrl+F`/`⌘F`), conversation/code/filename/command search, regex + fuzzy → **Phase 1** (palette UI + scrollback search UI), **Phase 5** (full-text/fuzzy backend + conversation history search)
9. **Clipboard & rich media** — copy/paste, multi-line paste, image paste/drag-drop, multiple images, code block copy/save/diff/open-in-editor → **Phase 5**
10. **File support** — attach source/markdown/pdf/images/json/yaml/logs, drag & drop with auto-detect/preview → **Phase 5**
11. **Rich markdown rendering** — tables, syntax highlighting, lists, blockquotes, collapsible sections, diff coloring (already prototyped in mockup's `colorBlock`) → **Phase 1** (basic), **Phase 5** (full)
12. **Keyboard-first** — global shortcuts (`Ctrl+K` search, `Ctrl+L` clear, `Ctrl+R` history, copy/paste, Tab-complete, ↑/↓ history) → **Phase 1** (core input shortcuts already in mockup), **Phase 6** (full shortcut set + customization)
13. **Notifications** — context-limit, auth-expired, update-available, request-failed, usage-limit → **Phase 6** (context-limit condition detection comes from Phase 4's tracker, but all notification UX ships in Phase 6)
14. **Settings** — theme, font, status bar config, default model/account/agent, auto-compact, notifications → **Phase 6**
15. **Security** — encrypted credentials, local storage, no default telemetry, account isolation → **Phase 3** (credential handling), ongoing thereafter
16. **Performance** — startup <100ms, async/non-blocking rendering, lazy loading → validated continuously, dedicated pass in **Phase 6**
17. **Extensibility** — plugin-ready adapter architecture, future MCP/Git/IDE integration hooks → adapter interface designed in **Phase 2**, extension points finalized in **Phase 6**

---

## Cross-Phase Conventions

- **Adapter interface first:** Even though Phase 1 uses mock data, its data shapes (`Agent`, `Account`, `Model`, `Session`, `TranscriptLine`) must match what the real Phase 2/3 backend will emit — model these types once in `src/types/` in Phase 1 and treat them as a contract. Do not let Phase 1 UI code assume mock-only shortcuts (e.g. don't hardcode the 5-item `RESP` array into rendering logic — keep it swappable behind a data-source interface).
- **Line/message types** from the mockup to preserve exactly: `banner`, `cmd`, `resp`, `out`, `dim`, `ok`, `err`, `think`, `warn`, `list`, `help`, `panel`. Each has a distinct renderer in `buildLine()` in the prototype — port these 1:1 as React components (`<BannerLine>`, `<CmdLine>`, etc.) in Phase 1.
- **Agent adapter trait** (defined in Phase 2, referenced by Phase 3+): `spawn()`, `write(input)`, `on_output(stream)`, `kill()`, `detect_ready()`, plus static metadata (`id`, `name`, `vendor`, `accent`, `models[]`, `extra_commands[]`) matching the mockup's `AGENTS` fixture shape.
- **Command routing:** universal commands (`/help /agents /users /accounts /models /usage /statistics /clear /compact /search /split /tab`) plus per-agent `extra` commands, exactly as in mockup's `COMMON` + `agent.extra` pattern — keep this dynamic-union approach, don't hardcode per-agent command lists into the UI.
- **Repo layout convention** (set up in Phase 1, do not restructure later):
  ```
  src/                # React frontend
    components/
    state/
    types/
    theme.css
  src-tauri/          # Rust backend
    src/
      adapters/
      pty/
      commands.rs
  plan/               # this folder
  docs/               # existing specs/design (untouched)
  ```

## Scope Adjustments (Applied Post-Review)

These override the initial feature inventory above where they conflict:

- **Passthrough over reimplementation:** Claude Code CLI already implements `/compact`, `/clear`, `/cost`, `/review`, `/init`, `/memory` natively. Kora's Claude adapter should forward these commands to the real CLI and render its output, not reimplement the logic itself. This shrinks Phase 4's scope significantly — see `phase-4-context-optimization.md`.
- **~~Weekly quota is not a real number.~~ AMENDED after the Phase 2 spike (2026-08-06):** this was wrong. Claude Code's structured mode emits a `rate_limit_event` on every turn carrying `{rateLimitType: "seven_day", utilization, resetsAt, status}`, and `/cost` prints real session and weekly percentages. The WEEK meter therefore shows **real** utilization with its real reset time, sourced from the CLI. Kora-side rolling counts remain only as the fallback for agents that expose no equivalent. See `phase-2-agent-exec.md` → "Spike Results".
- **Cursor Agent stays UI-stub only, permanently** (not just "not yet connected"). Its CLI agent surface is too immature for a real PTY-wrapped adapter. Keep it selectable in `/agents` for future-proofing the adapter list, but do not plan real integration work for it in any phase.
- **Added: process crash/recovery.** If a wrapped agent process dies mid-session (crash, network drop), Kora must detect this and offer a respawn action in the pane rather than leaving a dead/silent pane. Added to `phase-2-agent-exec.md`.
- **Added: existing project config detection.** On session start, detect `CLAUDE.md` / `.mcp.json` (or equivalent per-agent config) in the workspace and surface it in the session banner, since Claude Code already respects these files — Kora should acknowledge them, not ignore them. Added to `phase-2-agent-exec.md`.
- **Folder drag-drop ingestion narrowed to single-file for v1.** Whole-directory drop with `.gitignore`-aware filtering is deferred past v1; Phase 5 ships single-file drag-drop only. See `phase-5-rich-content-search.md`.
- **Added: output-mode spike in Phase 2.** Interactive PTY (full-screen Ink TUI, ANSI redraws — brittle to parse) vs `claude -p --input-format/--output-format stream-json` (clean JSON events + real usage metadata + `--resume`) is an architecture fork affecting Phases 2–4, not an implementation detail. Phase 2 opens with a spike that prototypes both and records the decision. See `phase-2-agent-exec.md`.
- **Crash respawn restores the conversation.** Process recovery (Phase 2) respawns via Claude Code's own `--continue`/`--resume`, not a fresh blank session; fresh spawn is the clearly-labeled fallback.
- **Session transcript persistence lands in Phase 3** (SQLite alongside usage tracking) — it is the substrate for `/session save/list/export/import` (feature inventory #4) and Phase 5's conversation-history search.
- **Dollar cost is labeled honestly per auth type** (Phase 3): real for API-key accounts; "estimated API-equivalent" or hidden for subscription (Pro/Max) accounts.

## Security (Cross-Cutting, Applies to Every Phase)

Kora's core function is rendering content it does not control — agent responses, file contents, pasted text, diffs — inside a Tauri webview that has a privileged IPC bridge to the Rust backend. Treat these as binding constraints in every phase, not just the phase that first touches them:

1. **Never render untrusted content as raw HTML.** All agent output, file contents, diffs, and pasted text are rendered as text/structured React elements, never via `dangerouslySetInnerHTML` or equivalent. If a markdown library is used (Phase 5), its HTML output must be run through a strict sanitizer (DOMPurify or equivalent) that strips `<script>`, event-handler attributes, and `javascript:` URLs — regardless of how "trusted" the source seems, since agent output and repo file content are both attacker-reachable in a coding-agent context. This is the single highest-severity risk in the plan: a webview JS bug here isn't just a rendering bug, it's a path to the Rust command bridge.
2. **Every Tauri command is an explicit, narrow allowlist entry.** `agent_spawn`, `agent_write`, `accounts_*`, `context_*`, file-ingest, editor-open, and any command added in later phases must be named explicitly in Tauri's capability config (default-deny), with all arguments validated in Rust — never trust path/string args from JS as pre-sanitized.
3. **Credentials live only in the OS keychain.** Never persist raw API keys/tokens in the usage/session SQLite store, settings file, or any log output (Phase 3 introduces the persistence layer — this constraint applies to it and everything built on top of it later).
4. **Process spawning uses argv arrays, never shell string interpolation.** Applies to the agent PTY spawn (Phase 2) and "open in editor" (Phase 5) — a crafted filename or path must not be able to inject shell syntax.
5. **No remote content at runtime.** Fonts, scripts, and styles are bundled locally (already required for the JetBrains Mono font); `tauri.conf.json`'s CSP should not permit remote script/style sources. Finalized in Phase 6 but should not regress in earlier phases.
6. **Prefer native credential-scoping mechanisms over env vars** when spawning per-account processes (Phase 3), since env vars are inherited by child processes and can leak via crash reports/debug tooling — use the CLI's own profile/config-dir mechanism if one exists.

## Non-Goals for v1 (explicitly deferred past Phase 6)

- Windows/Linux builds (macOS only for all 6 phases)
- Plugin marketplace / third-party plugin loading
- MCP server management UI (adapter hook only, no UI)
- IDE integrations (VS Code/JetBrains)
- Local LLM support
- Prompt library feature

---

## Phase Index

| Phase | File | Focus |
|---|---|---|
| 1 | `phase-1-ui-shell.md` | Full visual UI ported from design mockup, mock data |
| 2 | `phase-2-agent-exec.md` | Real PTY-wrapped Claude Code execution + adapter interface |
| 3 | `phase-3-accounts-usage.md` | Keychain accounts, model switching, real usage/cost data |
| 4 | `phase-4-context-optimization.md` | Real context tracking, warnings, `/compact` `/clear` |
| 5 | `phase-5-rich-content-search.md` | Images, files, drag-drop, full markdown, search |
| 6 | `phase-6-polish-extensibility.md` | Shortcuts, settings, notifications, perf, extensibility |

Each phase file below is self-contained — load it plus this master plan only.
