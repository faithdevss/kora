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

---

## Spike Results — account model, auth, and models

Run against `claude` 2.1.223 on 2026-08-07, before any implementation. Three findings changed the design; the amendments they imply are listed at the end.

### What was tested

| # | Question | Result |
|---|---|---|
| 1 | Does the CLI support per-account auth isolation? | **Yes, via `CLAUDE_CONFIG_DIR`.** Pointing it at a fresh directory yields `{"loggedIn": false, "authMethod": "none"}` while the default profile stays logged in. The CLI creates and owns everything inside that directory. |
| 2 | Can Kora identify an account without handling its credential? | **Yes.** `claude auth status` prints JSON: `loggedIn`, `authMethod` (`claude.ai` for subscription login), `apiProvider`, `email`, `orgId`, `orgName`, `subscriptionType` (`pro`). That is real account identity *and* the auth-type signal acceptance criterion 8 needs, with no secret involved. |
| 3 | How is an account added? | `claude auth login` (interactive, browser) / `auth logout` / `auth status`. There is also `setup-token` for a long-lived subscription token. |
| 4 | Can the real model list be queried? | **Yes** — `control_request` with `{"subtype": "list_models"}` returns each model's `value`, `resolvedModel`, `displayName`, `description`, and capability flags, live from the authenticated CLI. Free: no API call. |
| 5 | Is the mockup's model list still accurate? | **No.** The real list is Default/Sonnet 5, Opus 5, Haiku 4.5, and Fable; the Phase 1 fixture still names `claude-opus-4.1` and friends, which are not values the CLI accepts. |

### Decision — accounts are config directories, and Kora stores no credentials

Each Kora account is a `CLAUDE_CONFIG_DIR` under Kora's app-support directory. Adding an account runs the CLI's own `auth login` against a new directory; Claude Code stores its credential wherever it normally does, and Kora persists only `{ id, name, dir, email, orgName, authMethod, subscriptionType }` — all of it non-secret, all of it obtained from `auth status`.

This is what the master plan's Security #6 asks for ("prefer native credential-scoping mechanisms over env vars"), and it is stronger than the original plan: there is no Kora-owned secret to leak, to log, or to migrate. The one env var involved (`CLAUDE_CONFIG_DIR`) carries a path, never a credential.

### Amendments to this phase file

1. **Keychain integration is not implemented, and that is deliberate.** The in-scope bullet assumed Kora would store credentials in the macOS Keychain. It does not, because it never possesses one. **Acceptance criterion 2 is therefore restated:** Kora must store no credential material on disk at all — verified by inspecting its own account store for anything secret-shaped — rather than by finding a Kora-owned keychain entry. API-key accounts (which would need Kora-held secrets) are deferred; if they are added later, the keychain path in the original bullet applies to them alone.
2. **The WEEK meter caveat is withdrawn**, as already amended in `00-master-plan.md` after the Phase 2 spike: `rate_limit_event` carries real `seven_day` utilization with a reset time. **Acceptance criterion 6 is restated:** the meter shows the agent's real reported utilization, labelled with its window, and falls back to showing nothing (not to a locally-invented figure) for agents that report none.
3. **The model list is queried, never hardcoded** — `list_models` at handshake replaces the Phase 1 fixture, which is stale by two model generations.
