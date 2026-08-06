/**
 * Whole-app integration smoke: drives a real store through the real UI, the way
 * acceptance criteria 2-7 describe. Complements the unit tests, which exercise
 * the state layer directly. Each case gets its own store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { SessionStore } from './state/sessionStore';
import { __resetIds, initialState } from './state/appState';

let store: SessionStore;

const PLACEHOLDER = 'Ask the agent, or type / for commands';

function input(): HTMLElement {
  return screen.getByPlaceholderText(PLACEHOLDER);
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function send(text: string) {
  type(text);
  fireEvent.keyDown(input(), { key: 'Enter' });
}

function panes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.k-pane'));
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetIds();
  store = new SessionStore(initialState());
  render(<App store={store} />);
});

afterEach(() => {
  cleanup();
  store.dispose();
  vi.useRealTimers();
});

describe('boot', () => {
  it('renders the chrome with the seeded Claude session', () => {
    expect(screen.getByText('~/workspace/api-gateway')).toBeTruthy();
    expect(document.querySelector('.k-status-agent')!.textContent).toBe('Claude Code');
    expect(screen.getByText('claude-opus-4.1')).toBeTruthy();
    expect(screen.getByText('76%')).toBeTruthy(); // 152000 / 200000
    expect(screen.getByText('↑119k')).toBeTruthy();
    expect(screen.getByText('↓33k')).toBeTruthy();
    expect(screen.getByText('3.2/10 M tok')).toBeTruthy();
  });

  it('offers the /compact suggestion chip while context is high', () => {
    expect(screen.getByText(/◆ \/compact to free/)).toBeTruthy();
  });

  it('shows the seeded context warning with runnable chips', () => {
    expect(screen.getByText(/Context is at 76%/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '/compact' }));
    expect(screen.getByText(/Compacted context/)).toBeTruthy();
    expect(screen.getByText('28%')).toBeTruthy();
  });
});

describe('commands', () => {
  it('/help lists universal and Claude-specific commands', () => {
    send('/help');
    expect(screen.getByText('Commands — universal, plus what Claude Code adds')).toBeTruthy();
    expect(screen.getByText('CLAUDE CODE COMMANDS')).toBeTruthy();
    expect(screen.getByText('list every command')).toBeTruthy();
  });

  it('clicking a help row loads the command into the input', () => {
    send('/help');
    fireEvent.click(screen.getByText('/statistics'));
    expect(store.getState().input).toBe('/statistics ');
  });

  it('/agents lists agents and clicking one switches the session', () => {
    send('/agents');
    fireEvent.click(screen.getByText('Gemini CLI'));
    expect(screen.getByText('gemini-2.5-pro')).toBeTruthy();
    expect(screen.getByText(/Active agent → Gemini CLI/)).toBeTruthy();
    expect(document.querySelector('.k-status-agent')!.textContent).toBe('Gemini CLI');
  });

  it('/usage renders the three usage cards', () => {
    send('/usage');
    expect(screen.getByText('CONTEXT WINDOW')).toBeTruthy();
    expect(screen.getByText('THIS SESSION')).toBeTruthy();
    expect(screen.getByText(/TRACKED USAGE ·/)).toBeTruthy();
  });

  it('/clear wipes the scrollback back to the banner', () => {
    send('/clear');
    expect(screen.getByText(/Context cleared/)).toBeTruthy();
    expect(screen.queryByText('why do my sessions never log out?')).toBeNull();
    expect(screen.getByText('1%')).toBeTruthy(); // 1400 / 200000
  });

  it('an unknown command errors with a clickable suggestion', () => {
    send('/agent');
    expect(screen.getByText('Unknown command: /agent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '/agents' }));
    expect(screen.getByText('Coding agents — click to switch, or type /agents <name>')).toBeTruthy();
  });
});

describe('prompting', () => {
  it('shows the spinner then replaces it with a response', () => {
    send('why is CI flaky?');
    expect(screen.getByText('Claude Code is working…')).toBeTruthy();
    expect(screen.getByText('why is CI flaky?')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText('Claude Code is working…')).toBeNull();
    expect(document.querySelectorAll('.k-resp').length).toBeGreaterThan(2);
  });
});

describe('palette and history', () => {
  it('opens the palette on / and completes with Tab', () => {
    type('/ag');
    expect(screen.getByRole('option', { name: /\/agents/ })).toBeTruthy();

    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(store.getState().input).toBe('/agents ');
  });

  it('caps the palette at six entries and closes once an argument is typed', () => {
    type('/');
    expect(screen.getAllByRole('option')).toHaveLength(6);
    type('/agents co');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('recalls the previous command with ArrowUp', () => {
    send('/review');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(store.getState().input).toBe('/review');
  });
});

describe('split view', () => {
  it('/split shows two panes, one with an input and one click-to-focus', () => {
    send('/split');
    expect(panes()).toHaveLength(2);
    expect(document.querySelectorAll('.k-input')).toHaveLength(1);
    expect(screen.getByText(/session running in background/)).toBeTruthy();
  });

  it('each pane carries its own agent accent', () => {
    send('/split');
    const [a, b] = panes();
    expect(a.style.getPropertyValue('--ac')).toBe('#d97757'); // Claude
    expect(b.style.getPropertyValue('--ac')).toBe('#19c37d'); // Codex
  });

  it('clicking the blurred pane moves focus and its input appears', () => {
    send('/split');
    fireEvent.click(screen.getByText(/session running in background/));

    const [a, b] = panes();
    expect(a.classList.contains('is-focused')).toBe(false);
    expect(b.classList.contains('is-focused')).toBe(true);
    expect(within(b).getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
    expect(document.querySelector('.k-status-agent')!.textContent).toBe('Codex');
  });

  it('a click inside the blurred pane acts on that pane, not the focused one', () => {
    send('/agents');
    send('/split');

    const [claudePane, codexPane] = panes();
    expect(claudePane.classList.contains('is-focused')).toBe(true);
    // the /agents list lives in the Claude pane; switch the Codex pane instead
    fireEvent.click(within(codexPane).getByText(/session running in background/));

    fireEvent.click(within(panes()[0]).getByText('Aider'));
    expect(store.getState().sessions[0].agentId).toBe('aider');
    expect(store.getState().sessions[1].agentId).toBe('codex');
  });
});

describe('search overlay', () => {
  it('counts and highlights matches, and closes on Escape', () => {
    send('/search');
    const box = screen.getByPlaceholderText('Search scrollback…');
    fireEvent.change(box, { target: { value: 'token' } });

    expect(screen.getByText(/^\d+ match/)).toBeTruthy();
    expect(document.querySelectorAll('mark').length).toBeGreaterThan(0);

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Search scrollback…')).toBeNull();
    expect(document.querySelectorAll('mark')).toHaveLength(0);
  });
});

describe('tabs', () => {
  it('a new tab inherits the current agent and account', () => {
    send('/agents aider');
    fireEvent.click(screen.getByTitle('New session'));

    const tabs = document.querySelectorAll('.k-tab');
    expect(tabs[tabs.length - 1].textContent).toContain('aider · byo-anthropic');
    expect(tabs[tabs.length - 1].classList.contains('is-active')).toBe(true);
  });

  it('closing a tab removes it', () => {
    const before = document.querySelectorAll('.k-tab').length;
    fireEvent.click(document.querySelectorAll('.k-tab-close')[before - 1]);
    expect(document.querySelectorAll('.k-tab')).toHaveLength(before - 1);
  });

  it('switching tabs swaps the transcript and status bar', () => {
    fireEvent.click(document.querySelectorAll('.k-tab')[1]);
    expect(document.querySelector('.k-status-agent')!.textContent).toBe('Codex');
    expect(screen.getByText('add rate-limit headers to the gateway')).toBeTruthy();
    expect(screen.queryByText('why do my sessions never log out?')).toBeNull();
  });
});

describe('attachments', () => {
  it('the attach button stages a chip that can be removed', () => {
    fireEvent.click(screen.getByTitle('Attach image (or paste)'));
    expect(screen.getByText('screenshot-1.png')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Remove attachment'));
    expect(screen.queryByText('screenshot-1.png')).toBeNull();
  });

  it('a staged image is sent with the prompt and clears afterwards', () => {
    fireEvent.click(screen.getByTitle('Attach image (or paste)'));
    send('what is in this screenshot?');

    expect(screen.getByText('📎 1 image')).toBeTruthy();
    expect(screen.queryByText('screenshot-1.png')).toBeNull();
  });
});
