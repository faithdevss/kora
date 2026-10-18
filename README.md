# Kora

**One terminal, every agent.** Kora is a fast, lightweight desktop app for running AI coding-agent CLIs through one keyboard-first interface: session tabs, split panes, multiple accounts, and live token, context and usage telemetry in an always-visible status bar.

Kora wraps the agent CLI you already have rather than reimplementing it. The agent does the work, owns its own credentials and config, and runs its own tools. Kora shows what it is doing and lets you steer it.

> **Status: early (v0.1).** Claude Code is the only agent with a working adapter today. Codex, Gemini CLI, Cursor Agent and Aider appear in the agent switcher but are not connected yet. See [Adding an agent](#adding-an-agent). Kora currently targets **macOS**.

## Features

- **Agent adapters.** Kora drives each CLI in structured (JSON stream) mode over stdin/stdout, with no terminal emulation. Each agent sits behind one Rust trait, so its commands, models and capabilities adapt per agent.
- **Sessions.** Tabs, split view, and save, rename, pin, archive, export and import. Sessions persist in a local SQLite database, and a crashed agent can be respawned with its context resumed.
- **Multiple accounts.** Each account is a separate agent profile directory (`CLAUDE_CONFIG_DIR`). The CLI handles its own `auth login`. Kora never stores credentials: it keeps only non-secret identity (email, org, plan) that it reads back from `claude auth status`.
- **Telemetry.**
  - Live context-window gauge.
  - Session input and output tokens.
  - Weekly usage meter.
  - `/usage`, `/statistics` and `/cost` panels.
  - Cost is labeled honestly: it is real for API-key accounts and marked as an estimate for subscription plans.
- **Context optimization.** Kora warns at 70% and 90% context and offers one-click `/compact`, `/clear` or a new tab. Compaction itself is always done by the agent.
- **Rich content.**
  - Markdown rendering, sanitized with DOMPurify.
  - Syntax highlighting.
  - Diff viewer.
  - Code blocks you can copy, save, or open in your editor.
  - Image and file attachments by paste or drag-and-drop.
- **Search.** Scrollback search, cross-session full-text search, and a global command palette.
- **Permissions.** Agents run in their default (deny) permission mode. Refused tool calls show up as approval prompts in the pane.
- **Settings and keymap.** Theme, font, density and notifications. Every shortcut lives in one table (`src/state/keymap.ts`).

## Requirements

- macOS 10.15+
- [Node.js](https://nodejs.org/) 18+ and npm
- [Rust](https://rustup.rs/) 1.77+ and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and on your `PATH` as `claude`, and signed in

## Getting started

```bash
git clone https://github.com/faithdevss/kora.git
cd kora
npm install

# Run the desktop app in dev mode (starts Vite on :1420 and the Tauri shell)
npm run tauri dev

# Build a release .app bundle into src-tauri/target/release/bundle/
npm run tauri build
```

`npm run dev` runs only the web frontend in a browser. That is useful for UI work, but the browser has no Tauri backend, so no real agent will run.

### Environment variables

| Variable | Purpose |
|---|---|
| `KORA_CLAUDE_BIN` | Path to the `claude` executable, if it is not on `PATH` (also used by tests to drive a stub agent). |
| `KORA_DATA_DIR` | Override the data directory (default: `~/Library/Application Support/dev.faithdevs.kora`). |
| `KORA_TIMING=1` | Print how long the window took to appear. |

## Usage

Type a prompt and press Enter to send it to the agent. Lines that start with `/` are commands:

| Command | What it does |
|---|---|
| `/help` | List every command |
| `/agents` | Switch coding agent |
| `/accounts`, `/users` | Switch, add or sign in to accounts |
| `/models`, `/model` | Switch model (the list comes live from the agent) |
| `/usage`, `/statistics`, `/cost` | Usage and cost panels |
| `/session` | Save, list and restore sessions |
| `/search` | Search the scrollback |
| `/tab`, `/split` | New session, toggle split view |
| `/stop`, `/respawn` | Interrupt the agent, restart a dead one |
| `/settings`, `/theme` | Open settings |
| `/version`, `/update` | Version info, check for a newer release |

Kora forwards any other command the agent supports (such as `/compact`, `/clear`, `/review` or `/init`) to the agent.

### Keyboard shortcuts

`Mod` is ⌘ on macOS and Ctrl elsewhere.

| Shortcut | Action |
|---|---|
| `Mod+K` | Search this session |
| `Mod+Shift+P` | Command palette |
| `Mod+L` | Clear the context |
| `Mod+R` | Command history |
| `Mod+T` / `Mod+W` | New / close session |
| `Mod+Alt+→` / `Mod+Alt+←` | Next / previous session |
| `Mod+D` | Toggle split view |
| `Mod+.` | Stop generating |
| `Mod+,` | Settings |
| `Mod+/` | Help |
| `Mod+Shift+C` / `Mod+Shift+V` | Copy last response / paste into prompt |

## Architecture

```
┌──────────────────────── Tauri window ────────────────────────┐
│  React + TypeScript (src/)                                    │
│  components/  ── panes, tabs, status bar, palette, transcript │
│  state/       ── session store, command router, agent bridge  │
└──────────────── invoke() / events ▲──────────────────────────┘
                                    │
┌──────────────── Rust (src-tauri/src/) ───────────────────────┐
│  commands.rs  ── allowlisted Tauri command surface            │
│  proc/        ── process manager: spawn, pump stdout, kill    │
│  adapters/    ── AgentAdapter trait + claude.rs               │
│  accounts/    ── profile-dir accounts (no secrets)            │
│  store/       ── SQLite: sessions, usage, pricing             │
│  files/       ── attachment ingest, open-in-editor            │
│  settings/    ── preferences JSON                             │
└──────────────── argv spawn ▼ (stdin/stdout JSON lines) ──────┘
                        claude -p --input-format stream-json …
```

Security posture:

- The webview has no filesystem, shell or network capability (`src-tauri/capabilities/default.json`), and the CSP is strict.
- Agents are spawned with an argv array, never a shell string.
- Kora sends no telemetry.

## Adding an agent

Adding a second agent should take one new Rust file, one registry line and a test file. It should need no changes to the process manager, the Tauri commands or any TypeScript. [`docs/adding-an-agent.md`](docs/adding-an-agent.md) walks through it. Adapters for Codex, Gemini CLI, Aider and others are the most valuable contributions right now.

## Development

```bash
npm run typecheck          # TypeScript
npm test                   # Vitest (frontend)
cd src-tauri && cargo test # Rust unit + integration tests
```

Repository layout:

- `src/` is the React frontend. `src-tauri/` is the Rust backend.
- `docs/` holds feature specs, the agent guide, and the original interactive design prototype (`docs/design/`).
- `plan/` holds the phased build plan, including the spike results behind key design decisions (for example, why Kora uses structured stream-json instead of a PTY).

## Contributing

Issues and pull requests are welcome. Before you open a PR:

1. Make sure `npm run typecheck`, `npm test` and `cargo test` all pass.
2. Keep changes focused, and add tests for new behavior.
3. Don't add anything that makes Kora hold a credential. Accounts belong to the agent CLI.

## License

[MIT](LICENSE)

Kora is an independent project. It is not affiliated with or endorsed by Anthropic, OpenAI, Google, or any other agent vendor.
