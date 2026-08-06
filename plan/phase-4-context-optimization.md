# Phase 4 — Context Management & Optimization

Read `plan/00-master-plan.md` first. This file is self-contained for execution.

## Goal

Turn the mock context-percentage gauge and warning banner from Phase 1 into a real context tracker with useful optimization suggestions — **built on top of Claude Code's own native `/compact`/`/clear` (passthrough, per Phase 2's scope adjustment), not a Kora-side reimplementation of compaction logic.** This phase is now primarily about *surfacing real data and driving the existing UI off it*, not building a compaction engine from scratch.

## Scope

**In scope:**
- Real per-session context-window accounting: track cumulative tokens actually sent to the model against the active model's real context window size — sourced from Phase 3's real model metadata. Prefer reading context usage directly from Claude Code's own output/status if it exposes it (check `--output-format json`/stream-json for a usage/context field first); fall back to Kora-side accumulation only where the CLI doesn't expose it.
- Threshold-based warnings matching the docs precisely: informational at ~70%, urgent at ~90% (`docs/features.gpt.md` §8 exact copy: *"Context is now 70%... Consider clearing..."* / *"Context exceeds 90%... Start a new session or compact."*) — reuse the existing `warn` line type and quick-action chip pattern from Phase 1, driven by real percentages.
- `/clear` and `/compact`: **passthrough to the real Claude Code CLI** (per Phase 2) — Kora's job here is just to re-parse the CLI's own response to these commands and update the local context tracker/UI state accordingly (e.g. reset the tracked count after a real `/clear`, reduce it by whatever Claude Code reports after a real `/compact`). Do not build a separate summarization/compaction pipeline.
- Automatic optimization *suggestions* (UI layer only, `docs/features.gpt.md` §9–§11): surface non-intrusive suggestions — nudge toward the real `/compact`/`/clear` passthrough above, note cache-read tokens if Claude Code reports them, suggest splitting large tasks or switching to a cheaper model when context/cost is high. This is a thin rules-engine over data Kora already has (context %, cost, cache hits) — it does not independently generate summaries or edit conversation content itself.

**Out of scope (explicitly deferred, and in some cases permanently cut per review):**
- **Kora-side prompt compression/summarization pipeline is cut.** The original idea of Kora generating its own summaries via an auxiliary prompt is dropped in favor of relying on Claude Code's native compaction — simpler, avoids extra cost/latency, avoids Kora silently rewriting conversation content it didn't originate.
- Any UI for configuring optimization aggressiveness/thresholds — Phase 6 Settings panel.
- Cross-agent optimization behavior for Codex/Gemini/etc. — still Claude-only per the phased adapter rollout.

## Key Files/Modules to Create/Modify

```
src-tauri/
  src/
    context/
      tracker.rs            # real per-session token/window accounting
      passthrough.rs          # parse Claude Code's own /compact and /clear responses, update tracker
      suggestions.rs           # optimization-suggestion rules engine (thin, UI-facing only)
    commands.rs                # add: context_get, context_compact, context_clear
src/
  state/
    contextStore.ts             # replace mock checkContext()/ctxUsed with real backend data
  components/transcript/
    WarnLine.tsx                 # confirm still works unmodified against real data shape
```

## Reference

- `docs/features.gpt.md` §8 (Context Monitoring — exact warning copy), §9 (Automatic Token Optimization), §10 (Prompt Compression), §11 (Token Usage Visualization).
- Design mockup's `checkContext()` and the `/compact` handler in the `<script>` block — same UX pattern (amber banner, chips, "kora optimises tokens automatically" footer text), now backed by real numbers and a real compaction action instead of `Math.round(s.ctxWin*0.28)` fake math.

## Acceptance Criteria

1. Sending enough real prompts/responses to cross ~70% of the actual model context window triggers the warning banner with accurate percentage text — verified by comparing against Claude Code's own reported usage if available, or against a manual token count.
2. `/compact` invokes the real Claude Code CLI's own compaction (verifiable via its actual output) and Kora's tracked context size updates to match what the CLI reports freed — no separate Kora-generated summary is created.
3. `/clear` invokes the real CLI's clear behavior and Kora's context tracking resets to match.
4. Suggestion chips only appear when a real condition is met (context high, cache reuse available, etc.) — never shown unconditionally, and clicking a suggestion chip triggers the real passthrough command, not a Kora-side approximation.
5. No Kora-side code independently summarizes, rewrites, or discards conversation content — confirmed by the removal of any auxiliary-prompt-based compaction path from this phase's implementation.
