/**
 * Optimization suggestions — a thin rules engine over numbers Kora already has.
 *
 * Every rule fires only on a real, measured condition, and every action it
 * offers is a command the *agent* runs (`/compact`, `/clear`) or a Kora tab
 * action. Nothing here summarizes, rewrites, or discards conversation content:
 * compaction belongs to the CLI (master plan, "Passthrough over
 * reimplementation"; phase 4 acceptance criterion 5).
 *
 * The copy for the two context thresholds is quoted from
 * `docs/features.gpt.md` §8 and should stay that way.
 */

import type { Session, Suggestion } from '../types/agent';
import { CTX_URGENT, CTX_WARN, fmt } from './format';
import { modelOf, modelsOf } from './appState';

/** Model families in descending price order, for the "cheaper model" rule. */
const TIERS = ['opus', 'sonnet', 'haiku'];

/** How expensive a session has to get before cost is worth mentioning. */
const COST_NUDGE_USD = 1;
/** How long a session has to run before splitting it is worth mentioning. */
const LONG_SESSION_MSGS = 25;

function tierOf(modelId: string): number {
  return TIERS.findIndex((t) => modelId.toLowerCase().includes(t));
}

/**
 * Everything worth telling the user about this session, most urgent first.
 *
 * Callers decide how loudly to show them: `checkContext` promotes the top
 * context rule to a banner, the `/usage` panel lists them all quietly.
 */
export function suggestions(s: Session): Suggestion[] {
  const out: Suggestion[] = [];
  const pct = s.ctxWin > 0 ? s.ctxUsed / s.ctxWin : 0;

  // --- context, the two thresholds the docs specify verbatim ---
  if (pct >= CTX_URGENT) {
    out.push({
      id: 'context-urgent',
      tone: 'urgent',
      text: 'Context exceeds 90%. Start a new session or compact the conversation.',
      chips: [
        { label: '/compact', cmd: '/compact' },
        { label: '/tab', cmd: '/tab' },
        { label: '/clear', cmd: '/clear' },
      ],
    });
  } else if (pct >= CTX_WARN) {
    out.push({
      id: 'context-high',
      tone: 'info',
      text:
        `Context is now ${Math.round(pct * 100)}%. ` +
        'Consider clearing previous messages to improve quality and reduce token usage.',
      chips: [
        { label: '/compact', cmd: '/compact' },
        { label: '/clear', cmd: '/clear' },
      ],
    });
  }

  // --- quota the agent itself reported ---
  if (s.rateLimit && s.rateLimit.utilization >= 0.9) {
    out.push({
      id: 'quota-near',
      tone: 'urgent',
      text:
        `${s.rateLimit.window.replace('_', '-')} usage is at ` +
        `${Math.round(s.rateLimit.utilization * 100)}%, as reported by the agent. ` +
        'Another account keeps you working.',
      chips: [{ label: '/accounts', cmd: '/accounts' }],
    });
  }

  // --- a cheaper model, but only when one is really on offer ---
  const current = modelOf(s);
  const tier = tierOf(current.id);
  const cheaper = modelsOf(s).find((m) => {
    const t = tierOf(m.id);
    return t > tier && t >= 0;
  });
  if (cheaper && tier >= 0 && (s.costUsd ?? 0) >= COST_NUDGE_USD) {
    out.push({
      id: 'cheaper-model',
      tone: 'info',
      text:
        `This session has cost $${(s.costUsd ?? 0).toFixed(2)} on ${current.name}. ` +
        `${cheaper.name} handles routine turns for less — the agent switches per turn, ` +
        'so this is not a one-way door.',
      chips: [{ label: `/models ${cheaper.id}`, cmd: `/models ${cheaper.id}` }],
    });
  }

  // --- a long session costs more to re-read every turn ---
  if (s.msgs >= LONG_SESSION_MSGS && pct < CTX_WARN) {
    out.push({
      id: 'long-session',
      tone: 'info',
      text:
        `${s.msgs} messages in this session. Starting the next task in a fresh tab keeps ` +
        'each conversation cheap to re-read.',
      chips: [{ label: '/tab', cmd: '/tab' }],
    });
  }

  // --- cache reuse, an observation rather than an action ---
  if (s.cacheRead > 0 && s.sessIn > 0 && s.cacheRead / s.sessIn >= 0.5) {
    out.push({
      id: 'cache-working',
      tone: 'info',
      text:
        `${Math.round((s.cacheRead / s.sessIn) * 100)}% of input tokens (${fmt(s.cacheRead)}) ` +
        'came from the agent’s prompt cache this session, at a fraction of the price. ' +
        'Staying in this session keeps that cache warm.',
      chips: [],
    });
  }

  return out;
}

/** The suggestion a banner should raise for this session, if any. */
export function bannerSuggestion(s: Session): Suggestion | undefined {
  return suggestions(s).find((x) => x.id === 'context-urgent' || x.id === 'context-high');
}
