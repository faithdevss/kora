/**
 * Number/token formatting — ported from the prototype's fmt/fmtWin.
 *
 * The prototype's `estTok` character-count estimator is gone: from Phase 2 on
 * every token figure is one the agent itself reported.
 */

/** 1400 → "1.4k", 152000 → "152k", 3_200_000 → "3.2M" */
export function fmt(n: number): string {
  const v = Math.round(n);
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
  return String(v);
}

/** Context-window size, always in whole units: 200000 → "200k", 1e6 → "1M". */
export function fmtWin(w: number): string {
  return w >= 1e6 ? w / 1e6 + 'M' : w / 1e3 + 'k';
}

/** Informational threshold, per `docs/features.gpt.md` §8. */
export const CTX_WARN = 0.7;
/** Urgent threshold: the conversation is close to not fitting. */
export const CTX_URGENT = 0.9;
/** Drop back below this before the same warning may fire again. */
export const CTX_CLEAR = 0.6;

/** Colour for a context fill ratio: green → amber → red. */
export function ctxTone(pct: number): string {
  if (pct >= 0.85) return 'var(--red)';
  if (pct >= 0.6) return 'var(--amber)';
  return 'var(--green)';
}
