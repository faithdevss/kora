# Phase 3 — Accounts, Models, Usage Tracking

Read `plan/00-master-plan.md` first. This file is self-contained for execution.

## Goal

Replace mock accounts/usage from Phase 1 and the placeholder single-account assumption from Phase 2 with real, persisted, multi-account credential management (starting with Claude Code) and real token/cost accounting driven by actual process I/O instead of estimates.

## Scope

**In scope:**
- macOS Keychain integration (via Tauri keyring/stronghold plugin) for storing per-account credentials. For Claude Code specifically, this likely means managing distinct `CLAUDE_CONFIG_DIR`/auth-profile locations or API-key-based env injection per account — confirm during implementation what Claude Code's CLI actually supports for multi-profile auth (env var override, `--profile` flag, or separate config dirs) and design the account model around what's real, not the mockup's assumed shape.
- `/accounts` `/users` command: list real stored accounts for the active agent, add/remove/rename, switch active account (which reconfigures the next spawned process's auth context).
- Account switch mid-session: matches mockup behavior of updating status bar account name + triggering a fresh process spawn under the new credential context if needed (a running process may need to be killed/respawned on account switch — decide and document the behavior). Note: unlike Phase 2's crash recovery, `--continue`/`--resume` across an account switch may not restore the conversation (session history lives per config dir/account) — verify during implementation, and if resume doesn't carry over, warn the user before the switch that the conversation restarts.
- **New-tab default (per Phase 1): inherits the focused tab's agent + account**, not a hardcoded default — so opening a new tab while "work" account is focused spawns the new tab under "work" too, not always the first/default account. Only explicit `/accounts switch` changes it.
- Real token accounting: parse actual input/output token counts from Claude Code's output where it exposes them (check for `--output-format json`/stream-json usage metadata from Phase 2's parser work); fall back to char-based estimation only where the CLI doesn't expose real counts.
- Real cost calculation using current Claude API pricing (make pricing a small config table, not hardcoded inline, since prices change) replacing the mock `usage Data()`'s fixed `$3`/`$15` per-million placeholder rates. **Caveat: dollar cost is only real for API-key accounts.** For subscription auth (Pro/Max login), per-token pricing doesn't reflect what the user pays — label the figure "estimated API-equivalent cost" for subscription accounts (or hide it and show tokens only), never present it as actual spend. The account model should record auth type (api-key vs subscription) so the UI can branch on it.
- `/usage`, `/statistics`, `/cost` panels now render real numbers sourced from the above instead of Phase 1's fixture-driven `usageData()`/`statsData()`.
- **Session persistence (transcripts):** persist session transcripts, names, pin/archive state to local SQLite (same store as usage tracking below) so `/session save/list/rename/delete`, restore-on-restart, and export/import from the master plan's feature inventory #4 become real. This is also the substrate Phase 5's conversation-history search depends on — without it that search has nothing to query. Export/import can be simple JSON files; auto-save on every transcript append.
- Weekly usage meter: persist session token totals across app restarts (local storage/SQLite via Tauri) so the WEEK bar reflects real rolling usage, not a static mock number. **Caveat (per master plan scope adjustments): Claude Code CLI does not reliably expose remaining plan/quota data.** The WEEK meter therefore shows *Kora's own locally-tracked usage accumulation* (tokens/cost Kora has observed this account use, rolling 7 days), labeled "tracked usage" in the UI — not "quota remaining" or "% of plan limit." Do not imply it reflects an authoritative account-level limit unless a real API for that is confirmed to exist during implementation.
- Model switching (`/models`) becomes real for Claude Code (`opus`/`sonnet`/`haiku` or whatever the installed CLI actually exposes — query it rather than hardcoding the mockup's list). Prefer passing through Claude Code's native `/model` command (added to Phase 2's passthrough list) and observing its output to update Kora's status bar, rather than Kora managing model state independently of the CLI.

**Out of scope (explicitly deferred):**
- Real multi-account/model support for Codex/Gemini/etc. — still adapter-stubbed as "not connected" per Phase 2.
- Context-window percentage accuracy and optimization suggestions — Phase 4 (this phase only needs *token counts*, not the warning/suggestion UX).
- Any UI for editing/viewing settings beyond the existing `/accounts`/`/models` command flows — full Settings panel is Phase 6.

## Security

- Credentials go through the OS keychain only — never written to the usage-tracking SQLite store, settings file, or any log line (including debug logs). Verify no code path ever calls `println!`/`log::*` with a raw key value.
- If per-account switching needs to pass a credential to a spawned process, prefer Claude Code's own profile/config-dir mechanism (if it has one) over a raw env var; if env var injection is the only option, document that tradeoff explicitly rather than defaulting to it silently — see master plan's "Security (Cross-Cutting)" point 6.
- Masked key display in the UI (`sk-ant-••••7f2a` style, per the mockup's `ACCT` fixture) is required wherever a key is shown — never render the full key in any UI surface, error message, or tooltip.

## Key Files/Modules to Create/Modify

```
src-tauri/
  src/
    credentials/
      keychain.rs         # store/retrieve/delete via OS keychain
      profiles.rs           # per-agent account profile model + switching logic
    pricing/
      claude.rs             # pricing table, small + easy to update
    usage/
      tracker.rs             # real token/cost accumulation, persisted store
    sessions/
      store.rs               # session transcript persistence (SQLite), export/import
    commands.rs              # add: accounts_list/add/remove/switch, usage_get, sessions_*
src/
  state/
    accountStore.ts          # real accounts replacing mockFixtures ACCT
    usageStore.ts              # real usage data replacing mock usageData()/statsData()
  components/transcript/
    PanelLine.tsx               # update to consume real usage/statistics/cost shape
```

## Reference

- `docs/features.gpt.md` §2 (Multi Account Management), §5 (Usage Dashboard), §6 (Statistics), §12 (Cost Tracking).
- `docs/features.claude.md` / `docs/features.gemini..md` §2 (Unified Credentials Store, OS keychain integration), §4 (Real-Time Telemetry & Token Optimization — Session/Weekly/Monthly usage, `/usage`, `/statistics`).
- Design mockup's `ACCT` fixture shape (`plan: string, key: masked string, wUsed/wLim: number, unit: string`) is the target data shape for the real store — keep field names consistent so Phase 1's `PanelLine`/list renderers need minimal changes.

## Acceptance Criteria

1. Adding a second real Claude account (a second API key or login) and switching between them via `/accounts` actually changes which credentials the next spawned Claude Code process uses.
2. Credentials are never stored in plaintext on disk — verify via `security find-generic-password` (macOS Keychain) or equivalent, not a JSON/config file with a raw key.
3. `/usage` and `/statistics` panels show numbers that track real conversation activity (token counts change proportionally to actual prompt/response length, not fixed mock values).
4. Restarting the app preserves weekly usage totals (not reset to zero).
5. `/models` lists the models the currently installed/authenticated Claude Code CLI actually supports, not a hardcoded list.
6. WEEK meter UI copy reads "tracked usage" (or equivalent honest phrasing), never implies it's an authoritative account quota/limit unless a real quota API was confirmed and wired during implementation.
7. Closing and reopening the app restores saved sessions (names, transcripts, pin/archive state) via `/session list`; exporting a session produces a file that imports cleanly into a fresh install.
8. A subscription-auth (Pro/Max) account never shows an unqualified dollar "cost" figure — either labeled "estimated API-equivalent" or tokens-only.
