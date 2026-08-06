/** Number/token formatting — ported from the prototype's fmt/fmtWin/estTok. */

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

/**
 * Rough token estimate for Phase 1 only. Phase 3 replaces every call site with
 * real usage numbers reported by the agent process.
 */
export function estTok(str: string): number {
  return Math.max(1, Math.round(str.length / 3.6));
}

export const CTX_WARN = 0.72;
export const CTX_CLEAR = 0.6;

/** Colour for a context fill ratio: green → amber → red. */
export function ctxTone(pct: number): string {
  if (pct >= 0.85) return 'var(--red)';
  if (pct >= 0.6) return 'var(--amber)';
  return 'var(--green)';
}

/** Tokens a /compact would reclaim at the current fill level. */
export function compactTarget(ctxWin: number): number {
  return Math.max(1400, Math.round(ctxWin * 0.28));
}
