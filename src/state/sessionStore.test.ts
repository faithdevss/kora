import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './sessionStore';
import { __resetIds, focusedSession, initialState, sessionById } from './appState';
import { mockDataSource } from './mockFixtures';
import { makeFakeBridge, usage, type FakeBridge } from '../test/fakeBridge';
import type { Session, TranscriptLine } from '../types/agent';

let store: SessionStore;
let bridge: FakeBridge;

/** Boots a store with a live Claude session, as `start()` would. */
async function boot(): Promise<void> {
  await store.start();
  bridge.emit(store.getState().focusedId, {
    kind: 'ready',
    agent_session_id: 'agent-1',
    model: 'claude-opus-4.1',
    mcp_servers: 0,
    commands: [],
  });
}

function lines(): TranscriptLine[] {
  return focusedSession(store.getState()).lines;
}

function last(): TranscriptLine {
  const l = lines();
  return l[l.length - 1];
}

function session(): Session {
  return focusedSession(store.getState());
}

beforeEach(() => {
  __resetIds();
  bridge = makeFakeBridge();
  store = new SessionStore(initialState(), mockDataSource, bridge);
});

describe('startup', () => {
  it('spawns an agent for the first session and marks it ready', async () => {
    await boot();
    expect(bridge.spawns).toEqual([store.getState().focusedId]);
    expect(session().status).toBe('idle');
    expect(session().agentUuid).toBe('agent-1');
    expect(session().cwd).toBe('/work/api-gateway');
  });

  it('starts with an empty transcript — no mock conversation', async () => {
    await boot();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].t).toBe('banner');
  });

  it('start is idempotent, so StrictMode double-mounting spawns once', async () => {
    await boot();
    await store.start();
    expect(bridge.spawns).toHaveLength(1);
  });

  it('reports a failed spawn as an error line and stays offline', async () => {
    bridge.failNextSpawn = '`claude` was not found on your PATH.';
    await store.start();
    expect(session().status).toBe('offline');
    expect(last()).toMatchObject({ t: 'err' });
    expect((last() as { text: string }).text).toContain('not found on your PATH');
  });

  it('records workspace config so the banner can mention it', async () => {
    await store.start();
    bridge.emit(store.getState().focusedId, {
      kind: 'ready',
      agent_session_id: 'agent-1',
      model: null,
      mcp_servers: 2,
      commands: [],
    });
    expect(session().workspace?.mcpServers).toBe(2);
  });

  it('learns the agent real command list at handshake', async () => {
    await store.start();
    bridge.emit(store.getState().focusedId, {
      kind: 'ready',
      agent_session_id: 'a',
      model: null,
      mcp_servers: 0,
      commands: [
        { name: '/cost', description: '' },
        { name: '/rewind', description: '' },
      ],
    });
    expect(session().agentCommands).toEqual([
      { c: '/cost', d: '' },
      { c: '/rewind', d: '' },
    ]);

    store.setInput('/help');
    store.submit();
    const help = last();
    if (help.t !== 'help') throw new Error('expected help');
    expect(help.extra.map((e) => e.c)).toEqual(['/cost', '/rewind']);
  });
});

describe('not-connected agents', () => {
  it('says so instead of pretending to run', async () => {
    await boot();
    store.pickItem('agents', 'gemini');
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.spawns).toHaveLength(1); // gemini was never spawned
    expect(session().status).toBe('offline');
    const texts = lines().map((l) => ('text' in l ? l.text : ''));
    expect(texts.some((t) => t.includes('not connected yet'))).toBe(true);
  });

  it('refuses to send a prompt when nothing is connected', async () => {
    bridge.connected.clear();
    await store.start();
    store.setInput('hello');
    store.submit();
    await Promise.resolve();

    expect(bridge.writes).toHaveLength(0);
    expect(last()).toMatchObject({ t: 'err' });
  });
});

describe('a real turn', () => {
  beforeEach(boot);

  it('echoes the prompt, shows the spinner, then streams the response', async () => {
    const id = store.getState().focusedId;
    store.setInput('why is CI flaky?');
    store.submit();
    await Promise.resolve();

    expect(bridge.writes).toEqual([[id, 'why is CI flaky?']]);
    expect(lines()[1]).toMatchObject({ t: 'cmd', text: 'why is CI flaky?' });
    expect(last()).toMatchObject({ t: 'think' });
    expect(session().status).toBe('busy');

    bridge.emit(id, { kind: 'delta', text: 'Because ' });
    // The spinner is replaced by the response the moment text arrives.
    expect(lines().some((l) => l.t === 'think')).toBe(false);
    bridge.emit(id, { kind: 'delta', text: 'the mock is missing.' });

    expect(last()).toMatchObject({
      t: 'resp',
      text: 'Because the mock is missing.',
      streaming: true,
    });

    bridge.emit(id, { kind: 'message_done' });
    expect(last()).toMatchObject({ streaming: false });
  });

  it('folds real usage into the session totals, replacing estimates', async () => {
    const id = store.getState().focusedId;
    store.setInput('hi');
    store.submit();
    await Promise.resolve();

    bridge.emit(id, { kind: 'delta', text: 'hello' });
    bridge.emit(id, {
      kind: 'turn_end',
      text: 'hello',
      is_error: false,
      usage: usage({
        input_tokens: 10,
        output_tokens: 213,
        cache_read_tokens: 11609,
        cache_creation_tokens: 8922,
        total_cost_usd: 0.02,
        context_window: 200000,
      }),
    });

    const s = session();
    expect(s.status).toBe('idle');
    expect(s.sessIn).toBe(10 + 11609 + 8922);
    expect(s.sessOut).toBe(213);
    expect(s.ctxUsed).toBe(10 + 213 + 11609 + 8922);
    expect(s.ctxWin).toBe(200000);
    expect(s.costUsd).toBe(0.02);
    expect(s.msgs).toBe(1);
    expect(s.streamKey).toBeUndefined();
  });

  it('attaches tool calls to the response they belong to', async () => {
    const id = store.getState().focusedId;
    store.setInput('fix it');
    store.submit();
    await Promise.resolve();

    bridge.emit(id, { kind: 'delta', text: 'Editing.' });
    bridge.emit(id, { kind: 'tool', name: 'Edit', detail: 'Edit · src/a.ts' });
    bridge.emit(id, { kind: 'tool', name: 'Bash', detail: 'Bash · npm test' });

    expect(last()).toMatchObject({ t: 'resp', tools: ['Edit · src/a.ts', 'Bash · npm test'] });
  });

  it('shows a tool that runs before any prose on its own line', async () => {
    const id = store.getState().focusedId;
    store.setInput('read it');
    store.submit();
    await Promise.resolve();

    bridge.emit(id, { kind: 'tool', name: 'Read', detail: 'Read · src/a.ts' });
    expect(last()).toMatchObject({ t: 'dim', text: 'Read · src/a.ts' });
    expect(lines().some((l) => l.t === 'think')).toBe(false);
  });

  it('renders a result-only turn (a CLI slash command) as output', async () => {
    const id = store.getState().focusedId;
    store.setInput('/cost');
    store.submit();
    await Promise.resolve();

    bridge.emit(id, {
      kind: 'turn_end',
      text: 'Current week: 90% used',
      is_error: false,
      usage: null,
    });
    expect(last()).toMatchObject({ t: 'out', text: 'Current week: 90% used' });
  });

  it('surfaces a failed write without leaving the spinner up', async () => {
    bridge.failNextWrite = 'pipe closed';
    store.setInput('hello');
    store.submit();
    await Promise.resolve();
    await Promise.resolve();

    expect(lines().some((l) => l.t === 'think')).toBe(false);
    expect(last()).toMatchObject({ t: 'err', text: 'pipe closed' });
    expect(session().status).toBe('idle');
  });

  it('records the agent real quota rather than a local estimate', async () => {
    bridge.emit(store.getState().focusedId, {
      kind: 'rate_limit',
      window: 'seven_day',
      utilization: 0.9,
      resets_at: 1786190400,
    });
    expect(session().rateLimit).toEqual({
      window: 'seven_day',
      utilization: 0.9,
      resetsAt: 1786190400,
    });
  });

  it('reports agent-side compaction', async () => {
    bridge.emit(store.getState().focusedId, { kind: 'compacted' });
    expect(last()).toMatchObject({ t: 'ok' });
    expect((last() as { text: string }).text).toContain('compacted');
  });
});

describe('command routing', () => {
  beforeEach(boot);

  it('sends the agent native commands to the agent, unmodified', async () => {
    const id = store.getState().focusedId;
    for (const cmd of ['/compact', '/clear', '/cost', '/review', '/init', '/memory']) {
      store.setInput(cmd);
      store.submit();
      await Promise.resolve();
    }
    expect(bridge.writes.map(([, text]) => text)).toEqual([
      '/compact',
      '/clear',
      '/cost',
      '/review',
      '/init',
      '/memory',
    ]);
    expect(bridge.writes.every(([s]) => s === id)).toBe(true);
  });

  it('handles Kora own commands locally without touching the agent', async () => {
    for (const cmd of ['/agents', '/accounts', '/models', '/usage', '/statistics', '/help']) {
      store.setInput(cmd);
      store.submit();
      await Promise.resolve();
    }
    expect(bridge.writes).toHaveLength(0);
  });

  it('never invents a result for an agent command when nothing is running', async () => {
    bridge.connected.clear();
    __resetIds();
    const offline = new SessionStore(initialState(), mockDataSource, bridge);
    await offline.start();

    offline.setInput('/compact');
    offline.submit();

    expect(bridge.writes).toHaveLength(0);
    const l = focusedSession(offline.getState()).lines;
    const line = l[l.length - 1];
    expect(line).toMatchObject({ t: 'err' });
    if (line.t !== 'err') throw new Error('expected err');
    expect(line.text).toContain('handled by the agent');
  });

  it('picking a model tells the CLI rather than restarting the process', async () => {
    store.pickItem('models', 'haiku');
    await Promise.resolve();
    // The CLI's own alias, not the display name — `--model claude-haiku-4` is
    // not a value the CLI accepts.
    expect(bridge.writes.at(-1)?.[1]).toBe('/model haiku');
    expect(bridge.kills).toHaveLength(0);
  });
});

describe('permissions', () => {
  beforeEach(boot);

  it('renders a request and marks it approved, granting and retrying', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, {
      kind: 'permission',
      request_id: 'toolu_1',
      tool: 'Edit',
      detail: 'wants to write src/a.ts',
      scope: 'session_edits',
    });
    expect(last()).toMatchObject({ t: 'perm', requestId: 'toolu_1', tool: 'Edit' });

    await store.answerPermission(id, 'toolu_1', 'allow');

    // The tool goes with the answer, so the adapter can pick the right grant.
    expect(bridge.permissions).toEqual([[id, 'Edit', 'toolu_1', 'allow']]);
    const perm = lines().find((l) => l.t === 'perm');
    expect(perm).toMatchObject({ resolved: 'allow' });
    // Whatever granting takes is the adapter's business; the store only reports
    // it, and shows a spinner because a retry turn is now in flight.
    expect(bridge.writes).toHaveLength(0);
    expect(lines().some((l) => l.t === 'dim')).toBe(true);
    expect(last()).toMatchObject({ t: 'think' });
    expect(session().status).toBe('busy');
  });

  it('denying tells the agent nothing and leaves the record', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, {
      kind: 'permission',
      request_id: 'toolu_2',
      tool: 'Bash',
      detail: 'wants to run rm',
      scope: 'session_all',
    });
    await store.answerPermission(id, 'toolu_2', 'deny');

    expect(bridge.permissions).toHaveLength(0);
    expect(bridge.writes).toHaveLength(0);
    expect(lines().find((l) => l.t === 'perm')).toMatchObject({ resolved: 'deny' });
    expect(last()).toMatchObject({ t: 'dim' });
  });
});

describe('crash and recovery', () => {
  beforeEach(boot);

  it('marks the session dead and offers a respawn', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, { kind: 'exited', code: 9, recoverable: true });

    expect(session().status).toBe('dead');
    expect(last()).toMatchObject({
      t: 'err',
      action: { label: 'respawn agent', cmd: '/respawn' },
    });
    expect((last() as { text: string }).text).toContain('exit 9');
  });

  it('clears any spinner when the process dies mid-turn', async () => {
    const id = store.getState().focusedId;
    store.setInput('long one');
    store.submit();
    await Promise.resolve();
    expect(lines().some((l) => l.t === 'think')).toBe(true);

    bridge.emit(id, { kind: 'exited', code: null, recoverable: true });
    expect(lines().some((l) => l.t === 'think')).toBe(false);
  });

  it('respawn asks the agent to resume, and says only that', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });

    await store.respawn(id);

    expect(bridge.respawns).toEqual([id]);
    expect(session().status).toBe('idle');
    // Spawning is not proof the conversation came back, so it does not claim it.
    expect((last() as { text: string }).text).toContain('resuming the previous conversation');
  });

  it('a resume that dies before producing anything falls back to a fresh session', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });
    await store.respawn(id);

    // The agent rejected the conversation id and exited straight away.
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });
    await Promise.resolve();
    await Promise.resolve();

    const texts = lines().map((l) => ('text' in l ? l.text : ''));
    expect(texts.some((t) => t.includes('could not be restored'))).toBe(true);
    expect(bridge.spawns.length).toBeGreaterThan(1); // fresh, not another resume
  });

  it('a resume that produces output is not second-guessed', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });
    await store.respawn(id);

    bridge.emit(id, { kind: 'delta', text: 'still here' });
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });

    const texts = lines().map((l) => ('text' in l ? l.text : ''));
    expect(texts.some((t) => t.includes('could not be restored'))).toBe(false);
    expect(last()).toMatchObject({ t: 'err', action: { cmd: '/respawn' } });
  });

  it('refuses to send while dead, and the error offers the fix', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });

    store.setInput('are you there?');
    store.submit();
    await Promise.resolve();

    expect(bridge.writes).toHaveLength(0);
    expect(last()).toMatchObject({ t: 'err', action: { cmd: '/respawn' } });
  });

  it('/respawn from the chip restarts the agent', async () => {
    const id = store.getState().focusedId;
    bridge.emit(id, { kind: 'exited', code: 1, recoverable: true });

    store.runQuick('/respawn', id);
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.respawns).toEqual([id]);
  });

  it('/stop interrupts a busy agent', async () => {
    const id = store.getState().focusedId;
    store.setInput('long one');
    store.submit();
    await Promise.resolve();

    store.runQuick('/stop', id);
    await Promise.resolve();
    expect(bridge.interrupts).toEqual([id]);
  });
});

describe('session lifecycle', () => {
  beforeEach(boot);

  it('a new tab spawns its own process', async () => {
    store.newTab();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.spawns).toHaveLength(2);
    expect(bridge.spawns[1]).toBe(store.getState().focusedId);
  });

  it('closing a tab kills its process', async () => {
    store.newTab();
    await Promise.resolve();
    const doomed = store.getState().focusedId;

    store.closeTab(doomed);
    await Promise.resolve();
    expect(bridge.kills).toContain(doomed);
  });

  it('dispose kills every process', async () => {
    store.newTab();
    await Promise.resolve();
    const ids = store.getState().sessions.map((s) => s.id);

    await store.dispose();
    for (const id of ids) expect(bridge.kills).toContain(id);
  });

  it('switching agent replaces the process rather than reusing it', async () => {
    const id = store.getState().focusedId;
    bridge.connected.add('codex');

    store.pickItem('agents', 'codex');
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.kills).toContain(id);
    expect(bridge.spawns.filter((s) => s === id)).toHaveLength(2);
  });

  it('events for an unknown session are ignored', async () => {
    const before = lines().length;
    bridge.emit('s-does-not-exist', { kind: 'delta', text: 'stray' });
    expect(lines()).toHaveLength(before);
  });

  it('a response lands in its own session after the user switches tabs', async () => {
    const origin = store.getState().focusedId;
    store.setInput('slow one');
    store.submit();
    await Promise.resolve();

    store.newTab();
    await Promise.resolve();
    bridge.emit(origin, { kind: 'delta', text: 'answer' });

    const originSession = sessionById(store.getState(), origin)!;
    expect(originSession.lines.at(-1)).toMatchObject({ t: 'resp', text: 'answer' });
    expect(lines().some((l) => l.t === 'resp')).toBe(false);
  });
});

describe('input handling', () => {
  beforeEach(boot);

  it('ignores an empty or whitespace-only submit', async () => {
    const before = lines().length;
    store.setInput('   ');
    store.submit();
    expect(lines()).toHaveLength(before);
    expect(bridge.writes).toHaveLength(0);
  });

  it('walks history backwards then forwards', async () => {
    for (const t of ['first', 'second']) {
      store.setInput(t);
      store.submit();
      await Promise.resolve();
    }
    expect(store.historyPrev()).toBe(true);
    expect(store.getState().input).toBe('second');
    store.historyPrev();
    expect(store.getState().input).toBe('first');
    store.historyPrev();
    expect(store.getState().input).toBe('first'); // clamped
    store.historyNext();
    expect(store.getState().input).toBe('second');
    store.historyNext();
    expect(store.getState().input).toBe('');
    expect(store.historyNext()).toBe(false);
  });

  it('tab-completes only commands the active agent exposes', () => {
    store.setInput('/ag');
    expect(store.tabComplete()).toBe(true);
    expect(store.getState().input).toBe('/agents ');

    store.setInput('/agents co');
    expect(store.tabComplete()).toBe(false);
    store.setInput('/zz');
    expect(store.tabComplete()).toBe(false);
  });

  it('escape closes search first, then clears the input', () => {
    store.setInput('half typed');
    store.toggleSearch();
    store.escape();
    expect(store.getState().searchOpen).toBe(false);
    expect(store.getState().input).toBe('half typed');
    store.escape();
    expect(store.getState().input).toBe('');
  });

  it('bumps focusNonce when search closes, never when it opens', () => {
    const start = store.getState().focusNonce;
    store.toggleSearch();
    expect(store.getState().focusNonce).toBe(start);
    store.closeSearch();
    expect(store.getState().focusNonce).toBe(start + 1);
  });

  it('sends staged attachments with the prompt and clears them', async () => {
    store.addPlaceholderAttachment('screenshot');
    store.addPlaceholderAttachment('pasted');
    store.setInput('what is this?');
    store.submit();
    await Promise.resolve();

    expect(store.getState().attachments).toHaveLength(0);
    expect(lines().find((l) => l.t === 'cmd')).toMatchObject({ atts: 2 });
  });

  it('notifies listeners and stops after unsubscribe', () => {
    const seen: number[] = [];
    const off = store.subscribe(() => seen.push(1));
    store.setInput('x');
    expect(seen).toHaveLength(1);
    off();
    store.setInput('y');
    expect(seen).toHaveLength(1);
  });
});
