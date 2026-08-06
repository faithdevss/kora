import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './sessionStore';
import { __resetIds, focusedSession, initialState } from './appState';
import type { MockResponse } from './mockFixtures';

const RESPONSE: MockResponse = { text: 'canned reply', tool: 'bash · ok' };

function mkStore() {
  return new SessionStore(initialState(), {
    agents: () => [],
    accountsFor: () => [],
    sampleResponse: () => RESPONSE,
    workspace: () => '~/workspace/api-gateway',
  });
}

let store: SessionStore;

beforeEach(() => {
  vi.useFakeTimers();
  __resetIds();
  store = mkStore();
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('prompt round-trip', () => {
  it('shows a spinner, then swaps it for the response', () => {
    store.setInput('fix the tests');
    store.submit();

    let lines = focusedSession(store.getState()).lines;
    expect(lines[lines.length - 2]).toMatchObject({ t: 'cmd', text: 'fix the tests' });
    expect(lines[lines.length - 1]).toMatchObject({ t: 'think' });

    vi.advanceTimersByTime(2000);

    lines = focusedSession(store.getState()).lines;
    expect(lines.some((l) => l.t === 'think')).toBe(false);
    expect(lines[lines.length - 1]).toMatchObject({ t: 'resp', text: 'canned reply' });
  });

  it('accrues session tokens, context and message count', () => {
    const before = focusedSession(store.getState());
    store.setInput('hello');
    store.submit();
    vi.advanceTimersByTime(2000);

    const after = focusedSession(store.getState());
    expect(after.msgs).toBe(before.msgs + 1);
    expect(after.sessIn).toBeGreaterThan(before.sessIn);
    expect(after.sessOut).toBeGreaterThan(before.sessOut);
    expect(after.ctxUsed).toBe(before.ctxUsed + (after.sessIn - before.sessIn) + (after.sessOut - before.sessOut));
  });

  it('sends and clears attachments, tagging the command line', () => {
    store.addPlaceholderAttachment('screenshot');
    store.addPlaceholderAttachment('pasted');
    expect(store.getState().attachments.map((a) => a.name)).toEqual([
      'screenshot-1.png',
      'pasted-2.png',
    ]);

    store.setInput('what is in these?');
    store.submit();
    expect(store.getState().attachments).toHaveLength(0);

    const lines = focusedSession(store.getState()).lines;
    expect(lines[lines.length - 2]).toMatchObject({ t: 'cmd', atts: 2 });
  });

  it('removes an attachment by id', () => {
    store.addPlaceholderAttachment('screenshot');
    const [a] = store.getState().attachments;
    store.removeAttachment(a.id);
    expect(store.getState().attachments).toHaveLength(0);
  });

  it('ignores an empty or whitespace-only submit', () => {
    const before = focusedSession(store.getState()).lines.length;
    store.setInput('   ');
    store.submit();
    expect(focusedSession(store.getState()).lines).toHaveLength(before);
  });

  it('a pending response lands in its own session after the user switches tabs', () => {
    const origin = store.getState().focusedId;
    store.setInput('long running');
    store.submit();
    store.focusPane(store.getState().sessions[1].id);

    vi.advanceTimersByTime(2000);

    const originSession = store.getState().sessions.find((s) => s.id === origin)!;
    expect(originSession.lines[originSession.lines.length - 1]).toMatchObject({ t: 'resp' });
    expect(focusedSession(store.getState()).lines.some((l) => l.t === 'think')).toBe(false);
  });

  it('dispose cancels pending responses', () => {
    store.setInput('hello');
    store.submit();
    store.dispose();
    vi.advanceTimersByTime(5000);
    expect(focusedSession(store.getState()).lines.some((l) => l.t === 'think')).toBe(true);
  });
});

describe('slash commands via submit', () => {
  it('routes to the command router instead of the agent', () => {
    store.setInput('/clear');
    store.submit();
    expect(focusedSession(store.getState()).ctxUsed).toBe(1400);
    expect(store.getState().input).toBe('');
  });

  it('runQuick executes without touching the input', () => {
    store.setInput('half typed');
    store.runQuick('/compact');
    expect(store.getState().input).toBe('half typed');
    expect(focusedSession(store.getState()).ctxUsed).toBe(56000);
  });

  it('runQuick applies to the pane it was clicked in, not the focused one', () => {
    const other = store.getState().sessions[1].id;
    store.runQuick('/clear', other);
    expect(store.getState().sessions.find((s) => s.id === other)!.ctxUsed).toBe(1400);
    expect(focusedSession(store.getState()).ctxUsed).toBe(152000);
  });

  it('pickItem applies to the pane it was clicked in', () => {
    const other = store.getState().sessions[1].id;
    store.pickItem('agents', 'aider', other);
    expect(store.getState().sessions.find((s) => s.id === other)!.agentId).toBe('aider');
    expect(focusedSession(store.getState()).agentId).toBe('claude');
  });
});

describe('history', () => {
  beforeEach(() => {
    for (const t of ['first', 'second']) {
      store.setInput(t);
      store.submit();
    }
    vi.advanceTimersByTime(3000);
  });

  it('reports whether it moved, so the key can be swallowed selectively', () => {
    expect(store.historyPrev()).toBe(true);
    expect(store.historyNext()).toBe(true);
    expect(store.historyNext()).toBe(false); // already past the newest entry

    store.focusPane(store.getState().sessions[1].id); // no history here
    expect(store.historyPrev()).toBe(false);
  });

  it('walks backwards then forwards, ending on an empty input', () => {
    store.historyPrev();
    expect(store.getState().input).toBe('second');
    store.historyPrev();
    expect(store.getState().input).toBe('first');
    store.historyPrev();
    expect(store.getState().input).toBe('first'); // clamped at the oldest entry

    store.historyNext();
    expect(store.getState().input).toBe('second');
    store.historyNext();
    expect(store.getState().input).toBe('');
  });

  it('ignores historyNext before any historyPrev', () => {
    store.setInput('typing');
    store.historyNext();
    expect(store.getState().input).toBe('typing');
  });

  it('keeps history per session', () => {
    store.focusPane(store.getState().sessions[1].id);
    store.historyPrev();
    expect(store.getState().input).toBe('');
  });
});

describe('tab completion', () => {
  it('completes a partial command and appends a space', () => {
    store.setInput('/ag');
    expect(store.tabComplete()).toBe(true);
    expect(store.getState().input).toBe('/agents ');
  });

  it('declines once the command already has an argument', () => {
    store.setInput('/agents co');
    expect(store.tabComplete()).toBe(false);
  });

  it('declines for prose and for unmatched commands', () => {
    store.setInput('hello');
    expect(store.tabComplete()).toBe(false);
    store.setInput('/zz');
    expect(store.tabComplete()).toBe(false);
  });

  it('only completes commands the active agent exposes', () => {
    store.setInput('/rev');
    expect(store.tabComplete()).toBe(true);
    expect(store.getState().input).toBe('/review ');

    store.runQuick('/agents codex');
    store.setInput('/rev');
    expect(store.tabComplete()).toBe(false);
  });
});

describe('escape', () => {
  it('closes search first, then clears the input', () => {
    store.setInput('half typed');
    store.toggleSearch();
    store.escape();
    expect(store.getState().searchOpen).toBe(false);
    expect(store.getState().input).toBe('half typed');

    store.escape();
    expect(store.getState().input).toBe('');
  });
});

describe('input focus hand-off', () => {
  it('bumps focusNonce when search closes, by any route', () => {
    const start = store.getState().focusNonce;
    store.toggleSearch();
    expect(store.getState().focusNonce).toBe(start); // opening does not steal focus

    store.closeSearch();
    expect(store.getState().focusNonce).toBe(start + 1);

    store.toggleSearch();
    store.escape();
    expect(store.getState().focusNonce).toBe(start + 2);

    store.toggleSearch();
    store.toggleSearch();
    expect(store.getState().focusNonce).toBe(start + 3);
  });

  it('fillInput appends a space and refocuses', () => {
    const start = store.getState().focusNonce;
    store.fillInput('/agents');
    expect(store.getState().input).toBe('/agents ');
    expect(store.getState().focusNonce).toBe(start + 1);
  });
});

describe('list clicks', () => {
  it('pickItem switches agent, account and model', () => {
    store.pickItem('agents', 'aider');
    expect(focusedSession(store.getState()).agentId).toBe('aider');

    store.pickItem('models', 'ds');
    expect(focusedSession(store.getState()).modelId).toBe('ds');

    store.pickItem('accounts', 'a1');
    expect(focusedSession(store.getState()).accountId).toBe('a1');
  });
});

describe('subscriptions', () => {
  it('notifies listeners on change and stops after unsubscribe', () => {
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.setInput('x');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    store.setInput('y');
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
