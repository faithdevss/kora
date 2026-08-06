/**
 * Whole-app integration smoke.
 *
 * Drives the real store and real UI against a fake agent process, so it covers
 * the Phase 2 path end to end: spawn → prompt → stream → usage → permission →
 * crash → respawn. Each case gets its own store and bridge.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { SessionStore } from './state/sessionStore';
import { __resetIds, initialState } from './state/appState';
import { mockDataSource } from './state/mockFixtures';
import { makeFakeBridge, usage, type FakeBridge } from './test/fakeBridge';

let store: SessionStore;
let bridge: FakeBridge;

const PLACEHOLDER = 'Ask the agent, or type / for commands';

function input(): HTMLElement {
  return screen.getByPlaceholderText(PLACEHOLDER);
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

/** Submits and lets the store's async send settle. */
async function send(text: string) {
  type(text);
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Enter' });
  });
}

function panes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.k-pane'));
}

function sid(): string {
  return store.getState().focusedId;
}

/** Emits an agent event and flushes the resulting render. */
async function emit(...args: Parameters<FakeBridge['emit']>) {
  await act(async () => {
    bridge.emit(...args);
  });
}

/** Renders the app with a live agent already attached. */
async function boot() {
  await act(async () => {
    render(<App store={store} />);
  });
  await emit(sid(), {
    kind: 'ready',
    agent_session_id: 'agent-1',
    model: 'claude-opus-4.1',
    mcp_servers: 0,
    commands: [],
  });
}

beforeEach(() => {
  __resetIds();
  bridge = makeFakeBridge();
  store = new SessionStore(initialState(), mockDataSource, bridge);
});

afterEach(() => {
  cleanup();
});

describe('boot', () => {
  it('starts one live session and shows it as ready', async () => {
    await boot();
    expect(document.querySelector('.k-status-agent')!.textContent).toBe('Claude Code');
    expect(screen.getByText('claude-opus-4.1')).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.getByText('/work/api-gateway')).toBeTruthy();
    expect(bridge.spawns).toHaveLength(1);
  });

  it('shows an empty transcript, not a canned conversation', async () => {
    await boot();
    expect(document.querySelectorAll('.k-resp')).toHaveLength(0);
    expect(screen.getByText(/one terminal, every agent/)).toBeTruthy();
  });

  it('mentions workspace config the agent inherited', async () => {
    await act(async () => {
      render(<App store={store} />);
    });
    await emit(sid(), {
      kind: 'ready',
      agent_session_id: 'a',
      model: null,
      mcp_servers: 2,
      commands: [],
    });
    expect(screen.getByText('Using 2 MCP servers.')).toBeTruthy();
  });

  it('says nothing about config when the workspace has none', async () => {
    await boot();
    expect(screen.queryByText(/^Using /)).toBeNull();
  });

  it('reports a missing CLI as an error line instead of hanging', async () => {
    bridge.failNextSpawn = 'Could not start Claude Code: `claude` was not found on your PATH.';
    await act(async () => {
      render(<App store={store} />);
    });
    expect(screen.getByText(/was not found on your PATH/)).toBeTruthy();
    expect(screen.getByText('not connected')).toBeTruthy();
  });
});

describe('a real turn', () => {
  beforeEach(boot);

  it('streams the response in, replacing the spinner', async () => {
    await send('why is CI flaky?');
    expect(screen.getByText('Claude Code is working…')).toBeTruthy();
    expect(screen.getByText('working')).toBeTruthy();
    expect(bridge.writes).toEqual([[sid(), 'why is CI flaky?']]);

    await emit(sid(), { kind: 'delta', text: 'Because the ' });
    expect(screen.queryByText('Claude Code is working…')).toBeNull();
    await emit(sid(), { kind: 'delta', text: 'mock is missing.' });
    expect(screen.getByText('Because the mock is missing.')).toBeTruthy();
    expect(document.querySelector('.k-caret')).toBeTruthy();

    await emit(sid(), { kind: 'message_done' });
    expect(document.querySelector('.k-caret')).toBeNull();
  });

  it('shows real token and cost numbers in the status bar', async () => {
    await send('hi');
    await emit(sid(), { kind: 'delta', text: 'hello' });
    await emit(sid(), {
      kind: 'turn_end',
      text: 'hello',
      is_error: false,
      usage: usage({
        input_tokens: 10,
        output_tokens: 213,
        cache_read_tokens: 11609,
        cache_creation_tokens: 8922,
        context_window: 200000,
      }),
    });

    expect(screen.getByText('↑21k')).toBeTruthy();
    expect(screen.getByText('↓213')).toBeTruthy();
    expect(screen.getByText('10%')).toBeTruthy(); // 20754 / 200000
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('shows the agent real weekly utilization', async () => {
    await emit(sid(), {
      kind: 'rate_limit',
      window: 'seven_day',
      utilization: 0.9,
      resets_at: null,
    });
    expect(screen.getByText('90% seven-day')).toBeTruthy();
  });

  it('lists tool calls under the response', async () => {
    await send('fix it');
    await emit(sid(), { kind: 'delta', text: 'On it.' });
    await emit(sid(), { kind: 'tool', name: 'Edit', detail: 'Edit · src/a.ts' });
    expect(screen.getByText('Edit · src/a.ts')).toBeTruthy();
  });

  it('renders untrusted agent output as text, never as markup', async () => {
    await send('show me');
    await emit(sid(), {
      kind: 'delta',
      text: '<img src=x onerror="alert(1)"><script>bad()</script>',
    });
    const pane = panes()[0];
    expect(pane.querySelector('script')).toBeNull();
    expect(pane.querySelector('img')).toBeNull();
    expect(pane.textContent).toContain('<script>bad()</script>');
  });
});

describe('command routing', () => {
  beforeEach(boot);

  it('forwards the CLI own commands instead of reimplementing them', async () => {
    await send('/compact');
    expect(bridge.writes.at(-1)).toEqual([sid(), '/compact']);

    await emit(sid(), { kind: 'compacted' });
    expect(screen.getByText(/Context compacted by the agent/)).toBeTruthy();
  });

  it('keeps Kora own commands local', async () => {
    await send('/agents');
    expect(bridge.writes).toHaveLength(0);
    expect(screen.getByText('Coding agents — click to switch, or type /agents <name>')).toBeTruthy();
  });

  it('/help merges in the command list the agent reported', async () => {
    await emit(sid(), {
      kind: 'ready',
      agent_session_id: 'a',
      model: null,
      mcp_servers: 0,
      commands: [{ name: '/rewind', description: '' }],
    });
    await send('/help');
    expect(screen.getByText('/rewind')).toBeTruthy();
  });

  it('switching to an unconnected agent says so rather than pretending', async () => {
    await send('/agents');
    await act(async () => {
      fireEvent.click(screen.getByText('Gemini CLI'));
    });
    expect(screen.getByText(/is not connected yet/)).toBeTruthy();
    expect(screen.getByText('not connected')).toBeTruthy();
    expect(bridge.spawns).toHaveLength(1);
  });
});

describe('permissions', () => {
  beforeEach(boot);

  it('surfaces a blocked tool and lets the user grant it', async () => {
    await send('edit the file');
    await emit(sid(), {
      kind: 'permission',
      request_id: 'toolu_1',
      tool: 'Edit',
      detail: 'wants to write src/a.ts',
      scope: 'session_edits',
    });

    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('wants to write src/a.ts')).toBeTruthy();

    // The label states the real scope rather than promising a one-off grant.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'allow file edits for this session' }));
    });

    expect(bridge.permissions).toEqual([[sid(), 'Edit', 'toolu_1', 'allow']]);
    expect(screen.getByText('✓ approved')).toBeTruthy();
  });

  it('says plainly that a Bash approval widens the whole session', async () => {
    await emit(sid(), {
      kind: 'permission',
      request_id: 'toolu_3',
      tool: 'Bash',
      detail: 'wants to run npm test',
      scope: 'session_all',
    });
    // The broadest grant asks twice — one click cannot be undone.
    const first = screen.getByRole('button', { name: /allow all tools for this session/ });
    expect(screen.getByText(/cannot grant one tool at a time/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(first);
    });
    expect(bridge.permissions).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes — lift tool prompts/ }));
    });
    expect(bridge.permissions).toEqual([[sid(), 'Bash', 'toolu_3', 'allow']]);
  });

  it('denying sends nothing to the agent', async () => {
    await emit(sid(), {
      kind: 'permission',
      request_id: 'toolu_2',
      tool: 'Bash',
      detail: 'wants to run rm -rf',
      scope: 'session_all',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'deny' }));
    });

    expect(bridge.permissions).toHaveLength(0);
    expect(bridge.writes).toHaveLength(0);
    expect(screen.getByText('✗ denied')).toBeTruthy();
  });
});

describe('crash recovery', () => {
  beforeEach(boot);

  it('offers a respawn when the process dies, and asks the agent to resume', async () => {
    await emit(sid(), { kind: 'exited', code: 9, recoverable: true });

    expect(screen.getByText(/The agent process ended \(exit 9\)/)).toBeTruthy();
    expect(screen.getByText('stopped')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'respawn agent' }));
    });

    expect(bridge.respawns).toEqual([sid()]);
    expect(screen.getByText(/resuming the previous conversation/)).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('will not send into a dead session', async () => {
    await emit(sid(), { kind: 'exited', code: 1, recoverable: true });
    await send('still there?');
    expect(bridge.writes).toHaveLength(0);
    expect(screen.getByText(/agent process is not running/)).toBeTruthy();
  });
});

describe('tabs and split view', () => {
  beforeEach(boot);

  it('a new tab spawns its own process and inherits the agent', async () => {
    await act(async () => {
      fireEvent.click(screen.getByTitle('New session'));
    });
    expect(bridge.spawns).toHaveLength(2);
    expect(document.querySelectorAll('.k-tab')).toHaveLength(2);
  });

  it('closing a tab kills its process', async () => {
    await act(async () => {
      fireEvent.click(screen.getByTitle('New session'));
    });
    const doomed = sid();
    await act(async () => {
      fireEvent.click(document.querySelectorAll('.k-tab-close')[1]);
    });
    expect(bridge.kills).toContain(doomed);
    expect(document.querySelectorAll('.k-tab')).toHaveLength(1);
  });

  it('/split opens a second pane with its own process', async () => {
    await send('/split');
    expect(panes()).toHaveLength(2);
    expect(bridge.spawns).toHaveLength(2);
    expect(document.querySelectorAll('.k-input')).toHaveLength(1);
    expect(screen.getByText(/session running in background/)).toBeTruthy();
  });

  it('clicking the blurred pane focuses it', async () => {
    // /split opens a second session and focuses it, so the first pane is the
    // blurred one.
    await send('/split');
    const [a, b] = panes();
    expect(a.classList.contains('is-focused')).toBe(false);
    expect(b.classList.contains('is-focused')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText(/session running in background/));
    });

    const [a2, b2] = panes();
    expect(a2.classList.contains('is-focused')).toBe(true);
    expect(b2.classList.contains('is-focused')).toBe(false);
    expect(within(a2).getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
  });

  it('each pane streams its own session', async () => {
    await send('/split');
    const [first, second] = store.getState().sessions.map((s) => s.id);

    await emit(first, { kind: 'delta', text: 'from pane one' });
    await emit(second, { kind: 'delta', text: 'from pane two' });

    expect(within(panes()[0]).getByText('from pane one')).toBeTruthy();
    expect(within(panes()[1]).getByText('from pane two')).toBeTruthy();
  });
});

describe('palette, history and search', () => {
  beforeEach(boot);

  it('opens the palette on / and completes with Tab', async () => {
    type('/ag');
    expect(screen.getByRole('option', { name: /\/agents/ })).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(store.getState().input).toBe('/agents ');
  });

  it('caps the palette at six entries', () => {
    type('/');
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });

  it('recalls the previous command with ArrowUp', async () => {
    await send('/usage');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(store.getState().input).toBe('/usage');
  });

  it('searches the scrollback and closes on Escape', async () => {
    await send('tell me about tokens');
    await emit(sid(), { kind: 'delta', text: 'tokens are counted per turn' });

    await send('/search');
    const box = screen.getByPlaceholderText('Search scrollback…');
    fireEvent.change(box, { target: { value: 'tokens' } });

    expect(screen.getByText('2 matches')).toBeTruthy();
    expect(document.querySelectorAll('mark').length).toBe(2);

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Search scrollback…')).toBeNull();
    expect(document.querySelectorAll('mark')).toHaveLength(0);
  });

  it('an unknown command errors with a clickable suggestion', async () => {
    // Unknown commands only resolve locally when nothing is connected;
    // a live agent gets the chance to answer for itself.
    await emit(sid(), { kind: 'exited', code: 1, recoverable: false });
    await send('/agent');
    expect(screen.getByText('Unknown command: /agent')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '/agents' }));
    });
    expect(screen.getByText('Coding agents — click to switch, or type /agents <name>')).toBeTruthy();
  });
});

describe('attachments', () => {
  beforeEach(boot);

  it('stages a chip, sends it with the prompt, then clears it', async () => {
    await act(async () => {
      fireEvent.click(screen.getByTitle('Attach image (or paste)'));
    });
    expect(screen.getByText('screenshot-1.png')).toBeTruthy();

    await send('what is in this?');
    expect(screen.getByText('📎 1 image')).toBeTruthy();
    expect(screen.queryByText('screenshot-1.png')).toBeNull();
  });

  it('removes a staged chip', async () => {
    await act(async () => {
      fireEvent.click(screen.getByTitle('Attach image (or paste)'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Remove attachment'));
    });
    expect(screen.queryByText('screenshot-1.png')).toBeNull();
  });
});
