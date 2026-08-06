/**
 * Slash-command routing — port of the prototype's `runCommand()`.
 *
 * Every function here is pure: `(state, …) -> state`. No timers, no DOM, no
 * React. Phase 2 swaps individual cases for passthrough to the real agent CLI
 * (see master plan, "Passthrough over reimplementation") without changing shape.
 */

import type { AppState } from './appState';
import {
  acctOf,
  agentById,
  agentOf,
  availCmds,
  mkSession,
  modelOf,
  pushLine,
  sessionById,
  updateSession,
} from './appState';
import { CMD_DESC, COMMON, ACCOUNTS, AGENTS } from './mockFixtures';
import { CTX_CLEAR, CTX_WARN, compactTarget, fmt, fmtWin } from './format';
import type { ListKind, PanelData, Session } from '../types/agent';

/* ---------------- fuzzy matching ---------------- */

/** Levenshtein distance — drives the "did you mean" hint on unknown commands. */
export function lev(a: string, b: string): number {
  const m: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return m[a.length][b.length];
}

export function suggestCmd(s: Session, cmd: string): string | null {
  let best: string | null = null;
  let bd = 99;
  for (const c of availCmds(s)) {
    const d = lev(cmd, c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return bd <= 3 ? best : null;
}

function matchAgent(arg: string): string | undefined {
  return AGENTS.find((x) => x.id === arg || x.name.toLowerCase().includes(arg))?.id;
}

function matchAcct(s: Session, arg: string): string | undefined {
  return (ACCOUNTS[s.agentId] ?? []).find((x) => x.id === arg || x.name.includes(arg))?.id;
}

function matchModel(s: Session, arg: string): string | undefined {
  return agentOf(s).models.find((x) => x.id === arg || x.name.includes(arg))?.id;
}

/* ---------------- panel data ---------------- */

export function usageData(s: Session): PanelData {
  const a = acctOf(s);
  return {
    ctxUsed: s.ctxUsed,
    ctxWin: s.ctxWin,
    ctxPct: s.ctxUsed / s.ctxWin,
    sessIn: s.sessIn,
    sessOut: s.sessOut,
    msgs: s.msgs,
    cacheRead: Math.round(s.sessIn * 0.42),
    cost: (s.sessIn / 1e6) * 3 + (s.sessOut / 1e6) * 15,
    acctName: a?.name ?? '—',
    plan: a?.plan ?? '—',
    wUsed: a?.wUsed ?? 0,
    wLim: a?.wLim ?? 0,
    unit: a?.unit ?? '',
    model: modelOf(s).name,
  };
}

export function statsData(s: Session): PanelData {
  const d = usageData(s);
  d.avgIn = s.msgs ? Math.round(s.sessIn / s.msgs) : 0;
  d.avgOut = s.msgs ? Math.round(s.sessOut / s.msgs) : 0;
  return d;
}

/* ---------------- selection ---------------- */

export function selectAgent(state: AppState, id: string, agentId: string | undefined): AppState {
  const s = sessionById(state, id);
  if (!s) return state;
  if (!agentId) return pushLine(state, id, { t: 'err', text: 'No such agent.' });

  const ag = agentById(agentId);
  const acct = (ACCOUNTS[agentId] ?? [])[0];
  const next = updateSession(state, id, (sess) => ({
    ...sess,
    agentId,
    accountId: acct?.id ?? '',
    modelId: ag.models[0].id,
    ctxWin: ag.models[0].win,
    name: ag.name.split(' ')[0].toLowerCase(),
  }));
  const updated = sessionById(next, id)!;
  return pushLine(next, id, {
    t: 'ok',
    text:
      `Active agent → ${ag.name}. ${availCmds(updated).length} commands available` +
      ` · account ${acct?.name ?? '—'} · ${ag.models[0].name}.`,
  });
}

export function selectAccount(state: AppState, id: string, accountId: string | undefined): AppState {
  const s = sessionById(state, id);
  if (!s) return state;
  const a = (ACCOUNTS[s.agentId] ?? []).find((x) => x.id === accountId);
  if (!a) return pushLine(state, id, { t: 'err', text: 'No such account.' });

  const next = updateSession(state, id, (sess) => ({ ...sess, accountId: a.id }));
  return pushLine(next, id, {
    t: 'ok',
    text: `Account → ${a.name} · ${a.plan}  (${a.key}). Weekly usage ${a.wUsed}/${a.wLim} ${a.unit}.`,
  });
}

export function selectModel(state: AppState, id: string, modelId: string | undefined): AppState {
  const s = sessionById(state, id);
  if (!s) return state;
  const m = agentOf(s).models.find((x) => x.id === modelId);
  if (!m) return pushLine(state, id, { t: 'err', text: 'No such model.' });

  const next = updateSession(state, id, (sess) => ({ ...sess, modelId: m.id, ctxWin: m.win }));
  return pushLine(next, id, {
    t: 'ok',
    text: `Model → ${m.name} · ${fmtWin(m.win)} context window.`,
  });
}

/* ---------------- list / help builders ---------------- */

export function pushList(state: AppState, id: string, kind: ListKind): AppState {
  const s = sessionById(state, id);
  if (!s) return state;

  if (kind === 'agents') {
    return pushLine(state, id, {
      t: 'list',
      kind,
      title: 'Coding agents — click to switch, or type /agents <name>',
      items: AGENTS.map((a) => ({
        id: a.id,
        label: a.name,
        sub: `${a.vendor} · ${a.models.length} models · ${a.extra.length + COMMON.length} cmds`,
        right: '',
        active: a.id === s.agentId,
        dot: a.accent,
      })),
    });
  }

  if (kind === 'accounts') {
    return pushLine(state, id, {
      t: 'list',
      kind,
      title: `Accounts for ${agentOf(s).name} — each is a separate key / subscription`,
      items: (ACCOUNTS[s.agentId] ?? []).map((a) => ({
        id: a.id,
        label: a.name,
        sub: `${a.plan}  ·  ${a.key}`,
        right: `${a.wUsed}/${a.wLim} ${a.unit}`,
        active: a.id === s.accountId,
      })),
    });
  }

  return pushLine(state, id, {
    t: 'list',
    kind,
    title: `Models for ${agentOf(s).name}`,
    items: agentOf(s).models.map((m) => ({
      id: m.id,
      label: m.name,
      sub: `${fmtWin(m.win)} context window`,
      right: '',
      active: m.id === s.modelId,
    })),
  });
}

function cmdHelp(state: AppState, id: string): AppState {
  const s = sessionById(state, id)!;
  const ag = agentOf(s);
  return pushLine(state, id, {
    t: 'help',
    agent: ag.name,
    common: COMMON.map((c) => ({ c, d: CMD_DESC[c] ?? '' })),
    extra: ag.extra.map((c) => ({ c, d: CMD_DESC[c] ?? '' })),
  });
}

/* ---------------- context tracking ---------------- */

/**
 * Phase 1 mock threshold check. Phase 4 replaces the token math with real
 * usage reported by the agent, but keeps this warn-once/reset-below behaviour.
 */
export function checkContext(state: AppState, id: string): AppState {
  const s = sessionById(state, id);
  if (!s) return state;
  const pct = s.ctxUsed / s.ctxWin;

  if (pct >= CTX_WARN && !s.suggested) {
    const marked = updateSession(state, id, (sess) => ({ ...sess, suggested: true }));
    return pushLine(marked, id, {
      t: 'warn',
      text:
        `Context just crossed ${Math.round(pct * 100)}% of the ${fmtWin(s.ctxWin)} window. ` +
        'Reclaim tokens (and cost) before the next turn.',
      chips: [
        { label: '/compact', cmd: '/compact' },
        { label: '/clear', cmd: '/clear' },
      ],
    });
  }
  if (pct < CTX_CLEAR && s.suggested) {
    return updateSession(state, id, (sess) => ({ ...sess, suggested: false }));
  }
  return state;
}

/* ---------------- tabs / panes ---------------- */

/** New tab inherits the focused tab's agent + account (see phase-1 scope). */
export function newTab(state: AppState): AppState {
  const foc = sessionById(state, state.focusedId);
  const s = mkSession(foc?.agentId ?? AGENTS[0].id, foc?.accountId);
  return {
    ...state,
    sessions: [...state.sessions, s],
    focusedId: s.id,
    input: '',
    histIdx: null,
    attachments: [],
  };
}

export function closeTab(state: AppState, id: string): AppState {
  if (state.sessions.length <= 1) return state;
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return state;
  const sessions = state.sessions.filter((s) => s.id !== id);
  const focusedId =
    state.focusedId === id ? sessions[Math.max(0, idx - 1)].id : state.focusedId;
  return {
    ...state,
    sessions,
    focusedId,
    splitOn: sessions.length < 2 ? false : state.splitOn,
  };
}

export function toggleSplit(state: AppState): AppState {
  const next = state.sessions.length < 2 ? newTab(state) : state;
  return { ...next, splitOn: !next.splitOn };
}

/**
 * Sessions currently rendered as panes, in tab order.
 *
 * Split shows the focused session plus its nearest neighbour — unlike the
 * prototype, which always showed sessions 0 and 1 and could therefore render
 * two panes with neither of them focused.
 */
export function paneIds(state: AppState): string[] {
  if (!state.splitOn) return [state.focusedId];
  const idx = state.sessions.findIndex((s) => s.id === state.focusedId);
  if (idx < 0) return [state.sessions[0].id];
  const partner = state.sessions[idx + 1] ?? state.sessions[idx - 1];
  if (!partner) return [state.focusedId];
  return state.sessions
    .filter((s) => s.id === state.focusedId || s.id === partner.id)
    .map((s) => s.id);
}

/* ---------------- the router ---------------- */

/** Runs `raw` against `sessionId`, echoing the command line first. */
export function runCommand(state: AppState, sessionId: string, raw: string): AppState {
  const s0 = sessionById(state, sessionId);
  if (!s0) return state;

  const parts = raw.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').toLowerCase();

  let next = pushLine(state, sessionId, { t: 'cmd', text: raw });
  const s = sessionById(next, sessionId)!;

  switch (cmd) {
    case '/help':
      return cmdHelp(next, sessionId);

    case '/agents':
      return arg
        ? selectAgent(next, sessionId, matchAgent(arg))
        : pushList(next, sessionId, 'agents');

    case '/users':
    case '/accounts':
      return arg
        ? selectAccount(next, sessionId, matchAcct(s, arg))
        : pushList(next, sessionId, 'accounts');

    case '/models':
    case '/model':
      return arg
        ? selectModel(next, sessionId, matchModel(s, arg))
        : pushList(next, sessionId, 'models');

    case '/usage':
      return pushLine(next, sessionId, { t: 'panel', kind: 'usage', data: usageData(s) });

    case '/statistics':
      return pushLine(next, sessionId, { t: 'panel', kind: 'stats', data: statsData(s) });

    case '/cost':
      return pushLine(next, sessionId, { t: 'panel', kind: 'cost', data: usageData(s) });

    case '/clear':
      next = updateSession(next, sessionId, (sess) => ({
        ...sess,
        lines: [],
        ctxUsed: 1400,
        suggested: false,
      }));
      next = pushLine(next, sessionId, { t: 'banner' });
      return pushLine(next, sessionId, {
        t: 'ok',
        text: `Context cleared — window reset to ${fmt(1400)} tokens (system + tools only).`,
      });

    case '/compact': {
      const before = s.ctxUsed;
      const target = compactTarget(s.ctxWin);
      const after = Math.min(before, target);
      const freed = Math.max(0, before - target);
      next = updateSession(next, sessionId, (sess) => ({
        ...sess,
        ctxUsed: after,
        suggested: false,
      }));
      return pushLine(next, sessionId, {
        t: 'ok',
        text:
          `Compacted context — summarized earlier turns and freed ~${fmt(freed)} tokens. ` +
          `Now at ${Math.round((after / s.ctxWin) * 100)}%.`,
      });
    }

    case '/search':
      return { ...next, searchOpen: true };

    case '/split':
      return toggleSplit(next);

    case '/tab':
      return newTab(next);

    case '/diff':
      return pushLine(next, sessionId, {
        t: 'resp',
        text: 'Working tree — 2 files changed:',
        block:
          "diff --git a/src/gateway/limiter.ts b/src/gateway/limiter.ts\n@@ export function handler(req) {\n+  res.setHeader('X-RateLimit-Remaining', bucket.left)\n+  res.setHeader('X-RateLimit-Reset', bucket.reset)\n   return next()",
        lang: 'diff',
        tool: '2 files · +6 −0',
      });

    case '/tools':
      return pushLine(next, sessionId, {
        t: 'out',
        text:
          `Available tools for ${agentOf(s).name}:\n` +
          '  • read_file        • write_file       • edit_file\n' +
          '  • run_bash         • grep / glob      • web_search\n' +
          `  • ${agentOf(s).extra[0] ?? '/help'} (agent-specific)`,
      });

    case '/memory':
      return pushLine(next, sessionId, {
        t: 'out',
        text:
          `# project memory · ${agentOf(s).name}\n` +
          '  - api-gateway is a Fastify service, TypeScript strict\n' +
          '  - never commit to main; open a PR\n' +
          '  - run `npm test` before every commit',
      });

    case '/review':
      return pushLine(next, sessionId, {
        t: 'ok',
        text: 'Reviewed staged changes — 0 blocking issues, 2 style nits. Looks safe to commit.',
      });

    case '/init':
      return pushLine(next, sessionId, {
        t: 'ok',
        text: 'Scanned 214 files across 31 folders. Wrote memory + tool config. Ready.',
      });

    default: {
      const known = availCmds(s).includes(cmd);
      if (known) {
        return pushLine(next, sessionId, {
          t: 'dim',
          text: `${cmd} — ${CMD_DESC[cmd] ?? 'ok'}. (interactive stub in this preview)`,
        });
      }
      return pushLine(next, sessionId, {
        t: 'err',
        text: `Unknown command: ${cmd}`,
        hint: suggestCmd(s, cmd),
      });
    }
  }
}
