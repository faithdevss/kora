import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIds,
  agentOf,
  focusedSession,
  initialState,
  modelOf,
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
import type { TranscriptLine } from '../types/agent';

let state: AppState;

function run(cmd: string, s: AppState = state): AppState {
  return runCommand(s, s.focusedId, cmd);
}

function lastLine(s: AppState): TranscriptLine {
  const sess = focusedSession(s);
  return sess.lines[sess.lines.length - 1];
}

beforeEach(() => {
  __resetIds();
  state = initialState();
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
    ['/cost', 'cost'],
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

  it('/tools, /memory print agent-scoped output', () => {
    expect(lastLine(run('/tools'))).toMatchObject({ t: 'out' });
    if (lastLine(run('/tools')).t === 'out') {
      const l = lastLine(run('/tools'));
      expect('text' in l && l.text.includes('Claude Code')).toBe(true);
    }
    expect(lastLine(run('/memory'))).toMatchObject({ t: 'out' });
  });

  it('/review and /init report success', () => {
    expect(lastLine(run('/review'))).toMatchObject({ t: 'ok' });
    expect(lastLine(run('/init'))).toMatchObject({ t: 'ok' });
  });

  it('/diff renders a diff-highlighted response block', () => {
    expect(lastLine(run('/diff'))).toMatchObject({ t: 'resp', lang: 'diff' });
  });

  it('stubs commands the agent declares but that are not implemented', () => {
    let s = run('/agents codex');
    s = run('/approvals', s);
    expect(lastLine(s)).toMatchObject({ t: 'dim' });
  });
});

describe('context commands', () => {
  it('/clear resets the transcript to a banner and the window to 1.4k', () => {
    const next = run('/clear');
    const sess = focusedSession(next);
    expect(sess.ctxUsed).toBe(1400);
    expect(sess.suggested).toBe(false);
    expect(sess.lines[0]).toMatchObject({ t: 'banner' });
    // the echoed /clear is wiped along with the rest of the scrollback
    expect(sess.lines).toHaveLength(2); // banner + ok
    expect(sess.lines[1]).toMatchObject({ t: 'ok' });
  });

  it('/compact shrinks the context to 28% of the window and reports what it freed', () => {
    const next = run('/compact');
    const sess = focusedSession(next);
    expect(sess.ctxUsed).toBe(56000); // 28% of 200k
    const line = lastLine(next);
    if (line.t !== 'ok') throw new Error('expected ok');
    expect(line.text).toContain('96k');
    expect(line.text).toContain('28%');
  });

  it('/compact never inflates a context that is already small', () => {
    let s = run('/clear');
    s = run('/compact', s);
    expect(focusedSession(s).ctxUsed).toBe(1400);
  });
});

describe('checkContext', () => {
  it('warns once when crossing 72% and re-arms below 60%', () => {
    let s = run('/clear');
    const id = s.focusedId;
    s = {
      ...s,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ctxUsed: 150000 } : x)),
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
    let s = run('/clear');
    const id = s.focusedId;
    s = { ...s, sessions: s.sessions.map((x) => (x.id === id ? { ...x, ctxUsed: 150000 } : x)) };
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
    expect(sess.accountId).toBe('g1');
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
    expect(focusedSession(next).accountId).toBe('c2');
    expect(lastLine(next)).toMatchObject({ t: 'ok' });
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
    let s = run('/agents gemini');
    s = run('/accounts workspace', s);
    s = newTab(s);
    const fresh = focusedSession(s);
    expect(fresh.agentId).toBe('gemini');
    expect(fresh.accountId).toBe('g2');
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
    const s = runCommand(state, other, '/clear');
    expect(sessionById(s, other)!.ctxUsed).toBe(1400);
    expect(focusedSession(s).ctxUsed).toBe(152000);
  });
});

describe('/search', () => {
  it('opens the search overlay', () => {
    expect(run('/search').searchOpen).toBe(true);
  });
});

describe('usageData', () => {
  it('derives cost and cache figures from session tokens', () => {
    const d = usageData(focusedSession(state));
    expect(d.ctxPct).toBeCloseTo(0.76, 2);
    expect(d.cacheRead).toBe(Math.round(119000 * 0.42));
    expect(d.cost).toBeCloseTo((119000 / 1e6) * 3 + (33000 / 1e6) * 15, 6);
    expect(d.acctName).toBe('personal');
  });
});
