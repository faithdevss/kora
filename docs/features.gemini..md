# Feature Specification: AI-Agent Terminal (Terminal AI Client)

A lightweight, high-performance, developer-focused terminal emulator and CLI interface specifically engineered for running, managing, and switching between modern AI coding agents (Claude, Codex, OpenHands, Aider, custom LLM wrappers, etc.) with multi-account session management and real-time usage telemetry.

---

## 1. Core Architecture & Philosophy

* **Agent-First Design:** Optimized specifically for interactive AI coding workflows rather than standard shell scripting.
* **Extreme Performance & Low Overhead:** Built with modern, fast terminal UI primitives (e.g., Rust/Ratatui, Go/Bubbletea, or C++ with native terminal bindings) to ensure instant startup (<50ms) and minimal memory footprint.
* **Extensible Agent Protocol:** Standardized adapter layer to hook into various LLM providers, CLI agents, or local open-source agents.

---

## 2. Multi-Account & Multi-Provider Engine

* **Unified Credentials Store:** Secure OS keychain integration (Mac Keychain, Windows Credential Manager, Secret Service API) for storing API keys, OAuth tokens, and session cookies across multiple services.
* **Fast Account Switching (`/accounts` or `/users`):**
  * Instant listing of configured accounts per provider/agent.
  * Rapid active account switching via slash command or interactive quick-pick overlay.
  * Workspace/Project auto-detection (e.g., automatically use personal account in `~/personal` and enterprise account in `~/work`).
* **Multi-Model Router (`/models`):**
  * Live listing of models supported by the current active provider/agent (e.g., `claude-3-5-sonnet`, `gpt-4o`, `deepseek-coder`).
  * Dynamic switching on the fly without breaking the active conversation state.

---

## 3. Dynamic Agent Framework (`/agents`)

* **Agent Adapter Architecture:** Seamlessly switch between different agent architectures on the fly:
  * **Claude Code / Anthropic Agent:** Full tool-use execution, bash tool execution, file edits.
  * **Aider / OpenHands / Custom Wrappers:** Custom local or remote agent backends.
  * **Direct LLM Fallback:** Pure chat/code completion mode for quick queries.
* **Dynamic Command Inheritance:**
  * Active commands (`/commit`, `/diff`, `/clear`, `/test`, etc.) automatically adapt to match the capabilities of the currently selected agent.

---

## 4. Real-Time Telemetry & Token Optimization

### Dynamic Status Bar (Persistent HUD)
Always visible at the bottom or top of the terminal workspace, updating live on every response:
* **Session Usage:** Current prompt tokens, completion tokens, and dollar cost for the current active session.
* **Weekly / Monthly Usage:** Aggregated token consumption and estimated spending against user-defined quota alerts.
* **Context Window Gauge:** Visual bar indicating percentage of the current model's context window consumed (e.g., `Context: [██████░░░░] 62% (124k / 200k)`).
* **Token Burn Rate:** Instant token count per generation.

### Built-in Token Saver & Optimization System
* **Proactive Context Pruning Alerts:** Automatic prompt warning when context window reaches high threshold (e.g., >70%), suggesting:
  * Over-token threshold warning: *"Context reaching 75%. Run `/clear` or `/summarize` to optimize performance and reduce cost."*
* **Smart File Context Ingestion:**
  * Auto-ignore patterns (`.gitignore`, `.agentignore`) to avoid accidentally reading huge vendor files or binary blobs.
  * Truncated code snippet preview before sending long outputs to the model.
* **Telemetry Commands:**
  * `/usage`: Detailed dashboard of usage across models, agents, and active accounts.
  * `/statistics`: Historical token metrics, cost trends, and generation speed (tokens/sec).

---

## 5. Modern Terminal Capabilities (Focused & Clean)

* **Rich Media & Image Pasting:**
  * Direct image paste from system clipboard (`Ctrl+V` / `Cmd+V`) via inline Kitty/iTerm2 graphics protocol or ASCII preview fallback.
  * Drag-and-drop file path insertion into the prompt buffer.
* **Clipboard & Native Selection:**
  * Clean, border-aware code block copying with single-click/shortcut execution (`Cmd+C` / standard text selection).
  * Auto-strip shell prompts (`$` or `>`) when copying command blocks from agent responses.
* **In-Session Incremental Search:**
  * Standard search buffer (`Ctrl+F` / `Cmd+F`) to instantly search back-history, generated code snippets, and error logs.
* **Minimalist UI/UX:**
  * Clean syntax highlighting for 100+ programming languages.
  * Diff viewer with colorized visual additions/deletions for agent-proposed file edits.
  * Clean modal overlays for command palettes (`Ctrl+P`).

---

## 6. Comprehensive Slash Command Reference

| Command Category | Command | Description |
| :--- | :--- | :--- |
| **Account & Identity** | `/accounts`, `/users` | Switch between multiple account profiles or configure new API keys |
| | `/accounts add <provider>` | Quick-add a new identity/account |
| **Model & Agent** | `/agents` | Switch active agent backend (e.g., Claude Code, Aider, Custom) |
| | `/models` | Switch the underlying AI model for the active agent |
| **Telemetry & Cost** | `/usage` | Display full breakdown of token usage, session cost, and quota limits |
| | `/statistics` | View generation speed (t/s), daily/weekly cost trends, and peak usage |
| **Context Management** | `/clear` | Purge prompt context while retaining local file history |
| | `/compact` / `/summarize` | Compress active context into a minimal summary to save tokens |
| | `/context` | Display active context tree and attached files/prompts |
| **Workspace & Tooling** | `/diff` | Review active pending code modifications suggested by the agent |
| | `/history` | Search and reload previous sessions or chat logs |
| | `/help` | Show active agent capabilities and dynamically supported commands |

---

## 7. Performance & Optimization Strategy

1. **Zero Bloat Policy:** Excludes unnecessary GUI web views or heavy Electron wrappers.
2. **Local Caching Layer:** Caches model tokenizers locally to compute context windows in real-time with zero network latency.
3. **Async Streaming Render Engine:** Non-blocking IO ensures typing, shortcuts, and scrolling remain 60+ FPS responsive even while the agent streams large codeblocks.
