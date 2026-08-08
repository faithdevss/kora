import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIds,
  agentOf,
  focusedSession,
  initialState,
  mkSession,
  modelOf,
  nextLineKey,
  sessionById,
  type AppState,
} from './appState';
import {
  checkContext,
  closeTab,
  lev,
  newTab,
  paneIds,
  runCommand,
  suggestCmd,
  toggleSplit,
  usageData,
} from './commandRouter';
import type { Account, TranscriptLine } from '../types/agent';

let state: AppState;

/**
 * Two sessions with a used-up context, so the routing tests have something to
 * act on. Phase 2 made `initialState()` a single empty session, since real
 * transcripts now come from a real agent.
 */
/** Two Claude accounts, shaped exactly as the backend account store reports. */
function accounts(): Account[] {
  return [
    {
      id: 'c1',
      agent_id: 'claude',
      name: 'personal',
      dir: '/data/accounts/c1',
      identity: {
        logged_in: true,
        auth_method: 'claude.ai',
        email: 'me@example.com',
        org_name: null,
        subscription: 'max',
      },
    },
    {
      id: 'c2',
      agent_id: 'claude',
      name: 'work',
      dir: '/data/accounts/c2',
      identity: {
        logged_in: true,
        auth_method: 'apiKey',
        email: null,
        org_name: 'Acme',
        subscription: null,
      },
    },
  ];
}

function seeded(): AppState {
  const base = { ...initialState(), accounts: accounts() };
  const claude = {
    ...base.sessions[0],
    account: base.accounts[0],
    ctxUsed: 152000,
    sessIn: 119000,
    sessOut: 33000,
    msgs: 6,
    suggested: true,
    lines: [
      base.sessions[0].lines[0],
      { key: nextLineKey(), t: 'cmd' as const, text: 'why do my sessions never log out?' },
    ],
  };
  const codex = { ...mkSession('codex'), ctxUsed: 41000, sessIn: 32000, sessOut: 9000, msgs: 2 };
  return { ...base, sessions: [claude, codex], focusedId: claude.id };
}

function run(cmd: string, s: AppState = state): AppState {
  return runCommand(s, s.focusedId, cmd);
}

function lastLine(s: AppState): TranscriptLine {
  const sess = focusedSession(s);
  return sess.lines[sess.lines.length - 1];
}

beforeEach(() => {
  __resetIds();
  state = seeded();
});

describe('line echo', () => {
  it('echoes the command before its output', () => {
    const next = run('/help');
    const lines = focusedSession(next).lines;
    expect(lines[lines.length - 2]).toMatchObject({ t: 'cmd', text: '/help' });
  });

  it('gives every line a unique key', () => {
    let s = run('/help');
    s = run('/usage', s);
    s = run('/agents', s);
    const keys = focusedSession(s).lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('command coverage', () => {
  const panels: Array<[string, string]> = [
    ['/usage', 'usage'],
    ['/statistics', 'stats'],
  ];
  it.each(panels)('%s renders a %s panel', (cmd, kind) => {
    expect(lastLine(run(cmd))).toMatchObject({ t: 'panel', kind });
  });

  const lists: Array<[string, string]> = [
    ['/agents', 'agents'],
    ['/accounts', 'accounts'],
    ['/users', 'accounts'],
    ['/models', 'models'],
    ['/model', 'models'],
  ];
  it.each(lists)('%s renders a %s list', (cmd, kind) => {
    expect(lastLine(run(cmd))).toMatchObject({ t: 'list', kind });
  });

  it('/help lists universal plus agent-specific commands', () => {
    const line = lastLine(run('/help'));
    expect(line).toMatchObject({ t: 'help', agent: 'Claude Code' });
    if (line.t !== 'help') throw new Error('expected help');
    expect(line.common.map((e) => e.c)).toContain('/agents');
    expect(line.extra.map((e) => e.c)).toEqual(['/cost', '/review', '/memory', '/init']);
    expect(line.common.every((e) => e.d.length > 0)).toBe(true);
  });

  // Commands the agent owns are never answered locally. Reaching the router
  // means no process is running, and Phase 2 removed the Phase 1 fakes that
  // used to invent plausible-looking output here.
  // Claude Code's own set: the universal /compact and /clear, plus what this
  // agent declares. (/tools and /diff belong to other agents, so under Claude
  // they are correctly unknown rather than agent-owned.)
  const agentOwned = ['/compact', '/clear', '/memory', '/review', '/init', '/cost'];
  it.each(agentOwned)('%s says the agent owns it rather than faking a result', (cmd) => {
    const line = lastLine(run(cmd));
    expect(line).toMatchObject({ t: 'err' });
    if (line.t !== 'err') throw new Error('expected err');
    expect(line.text).toContain('handled by the agent');
  });

  it('does not invent a result for an agent command it merely knows the name of', () => {
    let s = run('/agents codex');
    s = run('/approvals', s);
    const line = lastLine(s);
    expect(line).toMatchObject({ t: 'err' });
    if (line.t !== 'err') throw new Error('expected err');
    expect(line.text).toContain('no agent is running');
  });

  it('offers a respawn when the session had an agent that died', () => {
    const dead = {
      ...state,
      sessions: state.sessions.map((x) =>
        x.id === state.focusedId ? { ...x, status: 'dead' as const } : x,
      ),
    };
    expect(lastLine(run('/compact', dead))).toMatchObject({
      t: 'err',
      action: { cmd: '/respawn' },
    });
  });
});

describe('checkContext', () => {
  it('warns once when crossing 72% and re-arms below 60%', () => {
    let s = state;
    const id = s.focusedId;
    s = {
      ...s,
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, ctxUsed: 150000, suggested: false } : x,
      ),
    };
    s = checkContext(s, id);
    expect(lastLine(s)).toMatchObject({ t: 'warn' });
    expect(focusedSession(s).suggested).toBe(true);

    const before = focusedSession(s).lines.length;
    s = checkContext(s, id);
    expect(focusedSession(s).lines).toHaveLength(before); // does not warn twice

    s = { ...s, sessions: s.sessions.map((x) => (x.id === id ? { ...x, ctxUsed: 10000 } : x)) };
    s = checkContext(s, id);
    expect(focusedSession(s).suggested).toBe(false);
  });

  it('warn chips carry runnable /compact and /clear commands', () => {
    let s = state;
    const id = s.focusedId;
    s = {
      ...s,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ctxUsed: 150000, suggested: false } : x)),
    };
    const line = lastLine(checkContext(s, id));
    if (line.t !== 'warn') throw new Error('expected warn');
    expect(line.chips.map((c) => c.cmd)).toEqual(['/compact', '/clear']);
  });
});

describe('switching', () => {
  it('/agents <name> switches agent, resets account + model + window', () => {
    const next = run('/agents gemini');
    const sess = focusedSession(next);
    expect(sess.agentId).toBe('gemini');
    // Gemini has no accounts configured, so the session carries none rather
    // than keeping the Claude one it was using.
    expect(sess.account).toBeUndefined();
    expect(modelOf(sess).name).toBe('gemini-2.5-pro');
    expect(sess.ctxWin).toBe(1000000);
    expect(sess.name).toBe('gemini');
    expect(agentOf(sess).accent).toBe('#4587f5');
  });

  it('matches agents by fuzzy name as well as id', () => {
    expect(focusedSession(run('/agents cursor')).agentId).toBe('cursor');
    expect(focusedSession(run('/agents aider')).agentId).toBe('aider');
  });

  it('/accounts <name> switches account within the agent', () => {
    const next = run('/accounts work');
    expect(focusedSession(next).account?.id).toBe('c2');
    expect(lastLine(next)).toMatchObject({ t: 'ok' });
  });

  it('an account line shows identity, because there is no key to mask', () => {
    const line = lastLine(run('/accounts work'));
    if (line.t !== 'ok') throw new Error('expected ok');
    expect(line.text).toContain('Acme');
    expect(line.text).not.toMatch(/sk-|••••/);
  });

  it('/models <name> switches model and context window', () => {
    const next = run('/models haiku');
    expect(focusedSession(next).modelId).toBe('haiku');
    expect(focusedSession(next).ctxWin).toBe(200000);
  });

  it('reports unknown agent/account/model as errors', () => {
    expect(lastLine(run('/agents nope'))).toMatchObject({ t: 'err', text: 'No such agent.' });
    expect(lastLine(run('/accounts nope'))).toMatchObject({ t: 'err', text: 'No such account.' });
    expect(lastLine(run('/models nope'))).toMatchObject({ t: 'err', text: 'No such model.' });
  });

  it('only offers accounts belonging to the active agent', () => {
    let s = run('/agents codex');
    s = run('/accounts work', s); // 'work' is a Claude account
    expect(lastLine(s)).toMatchObject({ t: 'err' });
  });
});

describe('unknown commands', () => {
  it('suggests the nearest command within edit distance 3', () => {
    const line = lastLine(run('/agent'));
    expect(line).toMatchObject({ t: 'err', hint: '/agents' });
  });

  it('offers no hint when nothing is close', () => {
    expect(lastLine(run('/zzzzzzzzzz'))).toMatchObject({ t: 'err', hint: null });
  });

  it('suggests only commands the active agent exposes', () => {
    const claude = focusedSession(state);
    expect(suggestCmd(claude, '/revie')).toBe('/review');
    const codex = focusedSession(run('/agents codex'));
    expect(suggestCmd(codex, '/approval')).toBe('/approvals');
    expect(suggestCmd(codex, '/revie')).not.toBe('/review');
  });

  it('lev computes edit distance', () => {
    expect(lev('kitten', 'sitting')).toBe(3);
    expect(lev('/help', '/help')).toBe(0);
  });
});

describe('tabs and panes', () => {
  it('a new tab inherits the focused tab agent and account', () => {
    const s = newTab(run('/accounts work'));
    const fresh = focusedSession(s);
    expect(fresh.agentId).toBe('claude');
    expect(fresh.account?.id).toBe('c2');
    expect(fresh.lines).toHaveLength(1);
    expect(fresh.lines[0]).toMatchObject({ t: 'banner' });
  });

  it('/tab opens and focuses a new session', () => {
    const before = state.sessions.length;
    const s = run('/tab');
    expect(s.sessions).toHaveLength(before + 1);
    expect(s.focusedId).toBe(s.sessions[s.sessions.length - 1].id);
  });

  it('closing a tab moves focus to its neighbour and never empties the list', () => {
    const s = closeTab(state, state.focusedId);
    expect(s.sessions).toHaveLength(1);
    expect(s.focusedId).toBe(s.sessions[0].id);
    expect(closeTab(s, s.focusedId).sessions).toHaveLength(1);
  });

  it('closing below two sessions turns split off', () => {
    let s = toggleSplit(state);
    expect(s.splitOn).toBe(true);
    s = closeTab(s, s.sessions[1].id);
    expect(s.splitOn).toBe(false);
  });

  it('split always includes the focused session', () => {
    let s = newTab(newTab(state)); // 4 sessions, last focused
    s = toggleSplit(s);
    expect(paneIds(s)).toHaveLength(2);
    expect(paneIds(s)).toContain(s.focusedId);

    s = { ...s, focusedId: s.sessions[0].id };
    expect(paneIds(s)).toContain(s.focusedId);
  });

  it('panes render in tab order', () => {
    const s = toggleSplit(state);
    expect(paneIds(s)).toEqual(s.sessions.slice(0, 2).map((x) => x.id));
  });

  it('/split with a single session opens a second one first', () => {
    const single = closeTab(state, state.sessions[1].id);
    const s = toggleSplit(single);
    expect(s.sessions).toHaveLength(2);
    expect(s.splitOn).toBe(true);
    expect(paneIds(s)).toHaveLength(2);
  });

  it('commands route to the session they were issued in, not the focused one', () => {
    const other = state.sessions[1].id;
    const s = runCommand(state, other, '/usage');
    expect(sessionById(s, other)!.lines.at(-1)).toMatchObject({ t: 'panel' });
    expect(focusedSession(s).lines.at(-1)).not.toMatchObject({ t: 'panel' });
  });
});

describe('/search', () => {
  it('opens the search overlay', () => {
    expect(run('/search').searchOpen).toBe(true);
  });
});

describe('usageData', () => {
  it('reports only figures the agent actually gave us', () => {
    const d = usageData(state, focusedSession(state));
    expect(d.ctxPct).toBeCloseTo(0.76, 2);
    // Nothing was reported for these, so they are absent rather than invented.
    expect(d.cost).toBeNull();
    expect(d.utilization).toBeNull();
    expect(d.cacheRead).toBe(0);
    expect(d.acctName).toBe('personal');
  });

  it('passes through real cost and quota once the agent reports them', () => {
    const s = {
      ...focusedSession(state),
      costUsd: 0.42,
      cacheRead: 1234,
      rateLimit: { window: 'seven_day', utilization: 0.9, resetsAt: null },
    };
    const d = usageData(state, s);
    expect(d.cost).toBe(0.42);
    expect(d.cacheRead).toBe(1234);
    expect(d.utilization).toBe(0.9);
    expect(d.window).toBe('seven_day');
  });
});
