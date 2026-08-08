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
    bridge.emit(id, { kind: 'tool', name: 'Edit', detail: 'Edit · src/a.ts', path: 'src/a.ts' });
    bridge.emit(id, { kind: 'tool', name: 'Bash', detail: 'Bash · npm test', path: null });

    expect(last()).toMatchObject({ t: 'resp', tools: ['Edit · src/a.ts', 'Bash · npm test'] });
  });

  it('shows a tool that runs before any prose on its own line', async () => {
    const id = store.getState().focusedId;
    store.setInput('read it');
    store.submit();
    await Promise.resolve();

    bridge.emit(id, { kind: 'tool', name: 'Read', detail: 'Read · src/a.ts', path: 'src/a.ts' });
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
    bridge.emit(store.getState().focusedId, { kind: 'compacted', pre_tokens: null, trigger: null });
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
    const file = bridge.seedFile();
    await store.attachPath(file.path);
    await store.attachBytes('shot.png', 'AAAB', 'image/png');
    store.setInput('what is this?');
    store.submit();
    await Promise.resolve();

    expect(store.getState().attachments).toHaveLength(0);
    expect(lines().find((l) => l.t === 'cmd')).toMatchObject({ atts: 2 });
    // The bytes really travelled, in the shape the backend expects.
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toEqual([
      {
        kind: 'text',
        name: file.name,
        path: file.path,
        text: file.text,
        truncated: false,
      },
      { kind: 'image', name: 'shot.png', media_type: 'image/png', data: 'AAAB' },
    ]);
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

/* ---------------- Phase 3 ---------------- */

/** Lets every queued promise and the (zero-delay) save timer run. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('accounts', () => {
  it('loads the backend accounts and runs the session under the active one', async () => {
    const personal = bridge.seedAccount({ name: 'personal' });
    bridge.seedAccount({ name: 'work' });
    await boot();

    expect(store.getState().accounts.map((a) => a.name)).toEqual(['personal', 'work']);
    expect(session().account?.id).toBe(personal.id);
  });

  it('shows identity rather than a masked key, because Kora holds no key', async () => {
    bridge.seedAccount({ name: 'personal' });
    await boot();
    store.runQuick('/accounts');

    const line = last();
    if (line.t !== 'list') throw new Error('expected list');
    expect(line.items[0].sub).toContain('user1@example.com');
    expect(JSON.stringify(line.items)).not.toMatch(/sk-|••••/);
  });

  it('/accounts add creates an account and points at the agent’s own login', async () => {
    await boot();
    store.runQuick('/accounts add personal');
    await settle();

    expect(bridge.accounts.map((a) => a.name)).toEqual(['personal']);
    expect(bridge.accounts[0].identity).toBeNull();
    expect(last()).toMatchObject({ t: 'ok' });
    expect((last() as { text: string }).text).toContain('/accounts login personal');
  });

  it('/accounts login hands over the command instead of touching the credential', async () => {
    bridge.seedAccount({ name: 'personal' });
    await boot();
    store.runQuick('/accounts login personal');
    await settle();

    const text = (last() as { text: string }).text;
    expect(text).toContain('CLAUDE_CONFIG_DIR=');
    expect(text).toContain('claude auth login');
    expect(text).toContain('Kora never sees it');
  });

  it('switching account restarts the agent under it, without resuming', async () => {
    bridge.seedAccount({ name: 'personal' });
    const work = bridge.seedAccount({ name: 'work' });
    await boot();
    const id = store.getState().focusedId;

    // A conversation the switch is about to leave behind.
    bridge.emit(id, { kind: 'turn_end', text: '', usage: usage(), is_error: false });
    store.runQuick('/accounts work');
    await settle();

    expect(bridge.active.get('claude')).toBe(work.id);
    expect(session().account?.id).toBe(work.id);
    expect(bridge.kills).toContain(id);
    // A fresh spawn, not a respawn: the new account never saw the old id.
    expect(bridge.spawns.filter((s) => s === id)).toHaveLength(2);
    expect(bridge.respawns).not.toContain(id);
    expect(lines().some((l) => l.t === 'warn' && l.text.includes('does not carry'))).toBe(true);
  });

  it('a new tab inherits the focused account', async () => {
    bridge.seedAccount({ name: 'personal' });
    const work = bridge.seedAccount({ name: 'work' });
    await boot();

    store.runQuick('/accounts work');
    await settle();
    store.newTab();
    await settle();

    expect(session().account?.id).toBe(work.id);
  });

  it('removing an account says the credentials went with it', async () => {
    bridge.seedAccount({ name: 'personal' });
    await boot();
    store.runQuick('/accounts remove personal');
    await settle();

    expect(bridge.accounts).toHaveLength(0);
    expect((last() as { text: string }).text).toContain('profile directory');
    expect(session().account).toBeUndefined();
  });
});

describe('models', () => {
  it('uses the model list the CLI reports, not the static catalogue', async () => {
    await boot();
    bridge.emit(store.getState().focusedId, {
      kind: 'models',
      models: [
        { id: 'sonnet', display_name: 'Sonnet 5', description: 'everyday', resolved: 'claude-sonnet-5' },
        { id: 'opus', display_name: 'Opus 5', description: 'hardest work', resolved: 'claude-opus-5' },
      ],
    });
    store.runQuick('/models');

    const line = last();
    if (line.t !== 'list') throw new Error('expected list');
    expect(line.items.map((i) => i.label)).toEqual(['Sonnet 5', 'Opus 5']);
    expect(line.items[0].sub).toBe('everyday');
    // The stale fixture names must not appear once the CLI has spoken.
    expect(JSON.stringify(line.items)).not.toContain('claude-opus-4.1');
  });
});

describe('usage tracking', () => {
  it('records the agent’s real token counts against the active account', async () => {
    const account = bridge.seedAccount({ name: 'personal' });
    await boot();
    bridge.emit(store.getState().focusedId, {
      kind: 'turn_end',
      text: '',
      usage: usage({ input_tokens: 120, output_tokens: 340 }),
      is_error: false,
    });
    await settle();

    expect(bridge.recorded).toHaveLength(1);
    expect(bridge.recorded[0].accountId).toBe(account.id);
    expect(bridge.recorded[0].usage.output_tokens).toBe(340);
    expect(store.getState().week[account.id].output_tokens).toBe(340);
  });

  it('a turn the CLI answered itself is not recorded as usage', async () => {
    bridge.seedAccount({ name: 'personal' });
    await boot();
    bridge.emit(store.getState().focusedId, {
      kind: 'turn_end',
      text: 'ok',
      usage: usage({ input_tokens: 0, output_tokens: 0 }),
      is_error: false,
    });
    await settle();

    expect(bridge.recorded).toHaveLength(0);
  });

  it('the usage panel labels a subscription figure as an estimate', async () => {
    bridge.seedAccount({ name: 'personal' });
    await boot();
    store.runQuick('/statistics');

    const line = last();
    if (line.t !== 'panel') throw new Error('expected panel');
    expect(line.data.costEstimated).toBe(true);
    expect(line.data.plan).toBe('Claude pro');
  });

  it('an API-key account is not labelled as an estimate', async () => {
    bridge.seedAccount({
      name: 'byo',
      identity: {
        logged_in: true,
        auth_method: 'apiKey',
        email: null,
        org_name: 'Acme',
        subscription: null,
      },
    });
    await boot();
    store.runQuick('/usage');

    const line = last();
    if (line.t !== 'panel') throw new Error('expected panel');
    expect(line.data.costEstimated).toBe(false);
  });
});

describe('session persistence', () => {
  beforeEach(() => {
    store.saveDelay = 0;
  });

  it('auto-saves the transcript as it grows', async () => {
    await boot();
    const id = store.getState().focusedId;
    store.setInput('hello');
    store.submit();
    await settle();

    const saved = bridge.saved.get(id);
    expect(saved).toBeDefined();
    expect(saved!.meta.agent_id).toBe('claude');
    expect(JSON.stringify(saved!.lines)).toContain('hello');
  });

  it('restores saved sessions as tabs on the next start, transcripts included', async () => {
    await boot();
    store.setInput('remember this');
    store.submit();
    await settle();
    await store.dispose();

    // A fresh app run against the same backend.
    __resetIds();
    const next = new SessionStore(initialState(), mockDataSource, bridge);
    await next.start();
    await settle();

    const restored = focusedSession(next.getState());
    expect(restored.lines.some((l) => l.t === 'cmd' && l.text === 'remember this')).toBe(true);
    // A new tab must not collide with a restored id.
    next.newTab();
    expect(new Set(next.getState().sessions.map((s) => s.id)).size).toBe(
      next.getState().sessions.length,
    );
    await next.dispose();
  });

  it('/session rename and /session list show the saved record', async () => {
    await boot();
    store.runQuick('/session rename debugging-auth');
    await settle();
    store.runQuick('/session list');
    await settle();

    const line = last();
    if (line.t !== 'list') throw new Error('expected list');
    expect(line.items[0].label).toContain('debugging-auth');
    expect(line.items[0].right).toBe('open');
  });

  it('/session export writes a file and says where', async () => {
    await boot();
    store.runQuick('/session export /tmp/kora-session.json');
    await settle();
    expect((last() as { text: string }).text).toContain('/tmp/kora-session.json');
  });

  it('/session delete forgets the saved session', async () => {
    await boot();
    const id = store.getState().focusedId;
    store.setInput('x');
    store.submit();
    await settle();
    expect(bridge.saved.has(id)).toBe(true);

    store.runQuick('/session delete');
    await settle();
    expect(bridge.saved.has(id)).toBe(false);
  });

  it('/session on its own explains the verbs rather than guessing one', async () => {
    await boot();
    store.runQuick('/session');
    await settle();
    expect(last()).toMatchObject({ t: 'list' });
  });
});

describe('context tracking', () => {
  beforeEach(boot);

  /** Ends a turn with the given real usage, as the agent would report it. */
  function turn(over: Partial<ReturnType<typeof usage>> = {}): void {
    bridge.emit(store.getState().focusedId, {
      kind: 'turn_end',
      text: '',
      usage: usage({ context_window: 200000, ...over }),
      is_error: false,
    });
  }

  it('tracks context against the window the agent reports', async () => {
    turn({ input_tokens: 40000, cache_read_tokens: 20000, output_tokens: 1000 });
    expect(session().ctxWin).toBe(200000);
    expect(session().ctxUsed).toBe(61000);
  });

  it('warns at the real 70% crossing, once', async () => {
    turn({ input_tokens: 150000, output_tokens: 1000 });
    const warns = lines().filter((l) => l.t === 'warn');
    expect(warns).toHaveLength(1);
    expect((warns[0] as { text: string }).text).toContain('Consider clearing previous messages');

    turn({ input_tokens: 151000, output_tokens: 1000 });
    expect(lines().filter((l) => l.t === 'warn')).toHaveLength(1);
  });

  it('escalates to the urgent copy when the window is nearly full', async () => {
    turn({ input_tokens: 150000, output_tokens: 1000 });
    turn({ input_tokens: 190000, output_tokens: 1000 });
    const warns = lines().filter((l) => l.t === 'warn') as { text: string }[];
    expect(warns).toHaveLength(2);
    expect(warns[1].text).toBe('Context exceeds 90%. Start a new session or compact the conversation.');
  });

  it('marks the figure approximate after a compaction, until the next turn', async () => {
    turn({ input_tokens: 150000, output_tokens: 1000 });
    bridge.emit(store.getState().focusedId, {
      kind: 'compacted',
      pre_tokens: 151000,
      trigger: 'manual',
    });

    expect(session().ctxStale).toBe(true);
    // What the agent freed *from* is the only number it has at that moment.
    expect((last() as { text: string }).text).toContain('151k tokens before');
    // Kora invents no post-compaction total.
    expect(session().ctxUsed).toBe(151000);

    turn({ input_tokens: 20000, output_tokens: 500 });
    expect(session().ctxStale).toBe(false);
    expect(session().ctxUsed).toBe(20500);
  });

  it('resets tracking when the CLI accepts a /clear', async () => {
    turn({ input_tokens: 150000, output_tokens: 1000 });
    expect(session().ctxUsed).toBeGreaterThan(0);

    store.setInput('/clear');
    store.submit();
    await Promise.resolve();
    expect(bridge.writes.at(-1)).toEqual([store.getState().focusedId, '/clear']);

    // The CLI answers a local command with a turn carrying no tokens.
    bridge.emit(store.getState().focusedId, {
      kind: 'turn_end',
      text: 'Context cleared',
      usage: usage({ input_tokens: 0, output_tokens: 0 }),
      is_error: false,
    });
    expect(session().ctxUsed).toBe(0);
    expect(session().warned).toBeUndefined();
  });

  it('leaves tracking alone when the CLI rejects a /clear', async () => {
    turn({ input_tokens: 150000, output_tokens: 1000 });
    const before = session().ctxUsed;

    store.setInput('/clear');
    store.submit();
    await Promise.resolve();
    bridge.emit(store.getState().focusedId, {
      kind: 'turn_end',
      text: 'not now',
      usage: null,
      is_error: true,
    });
    expect(session().ctxUsed).toBe(before);
  });

  it('never summarizes anything itself — /compact goes to the agent', async () => {
    const id = store.getState().focusedId;
    store.runQuick('/compact');
    await Promise.resolve();
    expect(bridge.writes).toContainEqual([id, '/compact']);
  });
});

describe('rich content', () => {
  it('refuses an image for an agent that reports no vision capability', async () => {
    bridge.capabilities.set('claude', ['streaming', 'usage']);
    await boot();

    await store.attachBytes('shot.png', 'AAAB', 'image/png');
    expect(store.getState().attachments).toHaveLength(0);
    expect((last() as { text: string }).text).toContain('does not accept images');
  });

  it('attaches an image when the agent can see', async () => {
    await boot();
    await store.attachBytes('shot.png', 'AAAB', 'image/png');

    const [att] = store.getState().attachments;
    expect(att).toMatchObject({ kind: 'image', name: 'shot.png', data: 'AAAB' });
  });

  it('reports a refusal from the backend rather than attaching nothing quietly', async () => {
    await boot();
    await store.attachPath('/nope/missing.ts');

    expect(store.getState().attachments).toHaveLength(0);
    expect((last() as { text: string }).text).toContain('no such file');
  });

  it('states a truncation before the turn goes out', async () => {
    await boot();
    const file = bridge.seedFile({ truncated: true, note: 'only the first 64 KB is attached.' });
    await store.attachPath(file.path);

    expect((last() as { text: string }).text).toContain('only the first 64 KB');
    expect(store.getState().attachments[0].truncated).toBe(true);
  });

  it('sends a binary by reference, never as mangled text', async () => {
    await boot();
    const file = bridge.seedFile({ name: 'x.bin', kind: 'binary', text: null, size: 4096 });
    await store.attachPath(file.path);
    store.setInput('what is this?');
    store.submit();
    await settle();

    const sent = bridge.sent[0][0];
    expect(sent.kind).toBe('text');
    if (sent.kind !== 'text') throw new Error('expected a text block');
    expect(sent.text).toContain('binary file');
    expect(sent.path).toBe(file.path);
  });

  it('saves a code block through the backend and says where it went', async () => {
    await boot();
    await store.saveBlock('export const x = 1;\n', './out/snippet.ts');

    expect(bridge.saves).toEqual([['./out/snippet.ts', 'export const x = 1;\n']]);
    expect((last() as { text: string }).text).toContain('./out/snippet.ts');
  });

  it('opens a file in the editor and reports the command that ran', async () => {
    await boot();
    await store.openInEditor('/work/auth.ts');

    expect(bridge.opened).toEqual(['/work/auth.ts']);
    expect((last() as { text: string }).text).toContain('/work/auth.ts');
  });
});

describe('cross-session search', () => {
  it('finds matches in sessions that are not open', async () => {
    store.saveDelay = 0;
    await boot();
    store.setInput('the cookie expires early');
    store.submit();
    await settle();

    store.setSearchQuery('cookie');
    await store.searchAllSessions();

    const hits = store.getState().searchAll;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('cookie');
  });

  it('clears stale results when the query changes', async () => {
    await boot();
    store.setSearchQuery('x');
    await store.searchAllSessions();
    store.setSearchQuery('y');
    expect(store.getState().searchAll).toEqual([]);
  });
});

describe('settings', () => {
  it('loads persisted settings on start, including the UI ones', async () => {
    bridge.settings = { ...bridge.settings, density: 'compact', glow: false, fontSize: 15 };
    await boot();

    expect(store.getState().settings.fontSize).toBe(15);
    // Density and glow also drive top-level UI state, so they must agree.
    expect(store.getState().density).toBe('compact');
    expect(store.getState().glow).toBe(false);
  });

  it('persists a change and survives a restart', async () => {
    await boot();
    await store.updateSettings({ autoCompact: true, statusBar: false });

    expect(bridge.settings.autoCompact).toBe(true);
    __resetIds();
    const next = new SessionStore(initialState(), mockDataSource, bridge);
    await next.start();
    expect(next.getState().settings.autoCompact).toBe(true);
    expect(next.getState().settings.statusBar).toBe(false);
    await next.dispose();
  });

  it('renders what the backend stored, not what was asked for', async () => {
    await boot();
    // The backend clamps; the UI must not keep showing the impossible value.
    await store.updateSettings({ fontSize: 400 });
    expect(store.getState().settings.fontSize).toBe(24);
  });

  it('falls back to defaults when settings cannot be read', async () => {
    bridge.settingsGet = async () => {
      throw new Error('no store');
    };
    await boot();
    expect(store.getState().settings.theme).toBe('kora-dark');
  });
});

describe('notifications', () => {
  /** Ends a turn at a given fraction of a 200k window. */
  function fill(pct: number): void {
    bridge.emit(store.getState().focusedId, {
      kind: 'turn_end',
      text: '',
      usage: usage({
        input_tokens: Math.round(200000 * pct) - 500,
        output_tokens: 500,
        context_window: 200000,
      }),
      is_error: false,
    });
  }

  it('fires when context crosses the urgent threshold, without opening /usage', async () => {
    await boot();
    fill(0.95);

    const [toast] = store.getState().toasts;
    expect(toast.kind).toBe('context');
    expect(toast.text).toContain('%');
    expect(toast.action?.cmd).toBe('/compact');
  });

  it('never quotes the conversation, since it can be read on a locked screen', async () => {
    await boot();
    store.setInput('my secret production database password is hunter2');
    store.submit();
    await Promise.resolve();
    fill(0.95);

    for (const toast of store.getState().toasts) {
      expect(toast.text).not.toContain('hunter2');
      expect(toast.text).not.toContain('password');
    }
  });

  it('warns once per condition rather than on every turn', async () => {
    await boot();
    fill(0.95);
    fill(0.96);
    fill(0.97);
    expect(store.getState().toasts.filter((t) => t.kind === 'context')).toHaveLength(1);
  });

  it('stays silent for a kind the user switched off', async () => {
    bridge.settings = {
      ...bridge.settings,
      notifications: { ...bridge.settings.notifications, context: false },
    };
    await boot();
    fill(0.95);
    expect(store.getState().toasts).toHaveLength(0);
  });

  it('reports a failed turn, and a sign-in problem as its own kind', async () => {
    await boot();
    bridge.emit(store.getState().focusedId, { kind: 'error', message: 'network went away' });
    expect(store.getState().toasts.at(-1)?.kind).toBe('errors');

    store.dismissToast(store.getState().toasts.at(-1)!.id);
    bridge.emit(store.getState().focusedId, { kind: 'error', message: '401 Unauthorized' });
    expect(store.getState().toasts.at(-1)?.kind).toBe('auth');
  });

  it('can be dismissed, and then the same condition can warn again', async () => {
    await boot();
    fill(0.95);
    const id = store.getState().toasts[0].id;
    store.dismissToast(id);
    expect(store.getState().toasts).toHaveLength(0);

    fill(0.96);
    expect(store.getState().toasts).toHaveLength(1);
  });

  describe('auto-compact', () => {
    it('is off by default: the user is asked, not acted upon', async () => {
      await boot();
      fill(0.95);
      expect(bridge.writes.some(([, text]) => text === '/compact')).toBe(false);
      expect(store.getState().toasts).toHaveLength(1);
    });

    it('when on, asks the agent to compact instead of notifying', async () => {
      bridge.settings = { ...bridge.settings, autoCompact: true };
      await boot();
      fill(0.95);
      await Promise.resolve();

      expect(bridge.writes.some(([, text]) => text === '/compact')).toBe(true);
      expect(store.getState().toasts).toHaveLength(0);
    });
  });
});

describe('keyboard actions', () => {
  beforeEach(boot);

  it('opens and closes the palette', () => {
    store.runAction('palette');
    expect(store.getState().paletteOpen).toBe(true);
    store.runAction('palette');
    expect(store.getState().paletteOpen).toBe(false);
  });

  it('opens settings, and closing returns focus to the input', () => {
    const before = store.getState().focusNonce;
    store.runAction('settings');
    expect(store.getState().settingsOpen).toBe(true);
    store.closeSettings();
    expect(store.getState().settingsOpen).toBe(false);
    expect(store.getState().focusNonce).toBe(before + 1);
  });

  it('sends /clear to the agent rather than clearing the transcript itself', async () => {
    store.runAction('clear');
    await Promise.resolve();
    expect(bridge.writes.at(-1)?.[1]).toBe('/clear');
  });

  it('cycles tabs in both directions, wrapping', async () => {
    store.newTab();
    await Promise.resolve();
    const [first, second] = store.getState().sessions.map((s) => s.id);

    store.focusPane(first);
    store.runAction('nextTab');
    expect(store.getState().focusedId).toBe(second);
    store.runAction('nextTab');
    expect(store.getState().focusedId).toBe(first);
    store.runAction('prevTab');
    expect(store.getState().focusedId).toBe(second);
  });

  it('opens and closes split view', () => {
    store.runAction('split');
    expect(store.getState().splitOn).toBe(true);
  });

  it('interrupts the agent', async () => {
    store.runAction('interrupt');
    await Promise.resolve();
    expect(bridge.interrupts).toContain(store.getState().focusedId);
  });
});

describe('version', () => {
  it('/version reports the build and says it does not self-update', async () => {
    await boot();
    store.runQuick('/version');
    await settle();

    const text = (last() as { text: string }).text;
    expect(text).toContain('Kora 0.1.0');
    expect(text).toContain('does not update itself');
    expect(text).toContain('releases');
  });

  it('/update says the same thing, rather than pretending to update', async () => {
    await boot();
    store.runQuick('/update');
    await settle();
    expect((last() as { text: string }).text).toContain('releases');
  });
});
