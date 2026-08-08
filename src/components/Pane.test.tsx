import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Pane, type PaneActions } from './Pane';
import { AGENTS } from '../state/mockFixtures';
import { initialState, mkSession, sessionById } from '../state/appState';
import type { Session, TranscriptLine } from '../types/agent';

/** Claude + Codex, so split-pane behaviour has two different agents to show. */
const base = initialState();
const state = { ...base, sessions: [base.sessions[0], mkSession('codex')] };

const blankInput = {
  focusToken: 'tok',
  value: '',
  matches: [] as string[],
  attachments: [],
  onChange: () => {},
  onSubmit: () => {},
  onEscape: () => {},
  onTabComplete: () => false,
  onHistoryPrev: () => false,
  onHistoryNext: () => false,
  onPickCmd: () => {},
  vision: true,
  onRemoveAttachment: () => {},
};

function mkPane(session: Session, focused: boolean, actions: PaneActions, glow = true) {
  return render(
    <Pane
      session={session}
      focused={focused}
      glow={glow}
      actions={actions}
      onFocus={() => {}}
      input={{ ...blankInput, focusToken: session.id }}
    />,
  );
}

function noopActions(): PaneActions {
  return {
    runQuick: vi.fn(),
    pickItem: vi.fn(),
    fillInput: vi.fn(),
    answerPermission: vi.fn(),
    saveBlock: vi.fn(),
    openInEditor: vi.fn(),
    attachBytes: vi.fn(),
    rejectDrop: vi.fn(),
  };
}

describe('pane accent', () => {
  it('wears its own agent accent, not the focused session one', () => {
    const codex = sessionById(state, state.sessions[1].id)!;
    const { container } = mkPane(codex, false, noopActions());
    const pane = container.querySelector('.k-pane') as HTMLElement;
    expect(pane.style.getPropertyValue('--ac')).toBe(AGENTS[1].accent); // #19c37d
    expect(pane.style.getPropertyValue('--glow')).toContain(AGENTS[1].accent);
  });

  it('drops the glow when the setting is off', () => {
    const s = sessionById(state, state.focusedId)!;
    const { container } = mkPane(s, true, noopActions(), false);
    expect((container.querySelector('.k-pane') as HTMLElement).style.getPropertyValue('--glow')).toBe(
      'none',
    );
  });
});

describe('pane action routing', () => {
  const listLine: TranscriptLine = {
    key: 'l1',
    t: 'list',
    kind: 'agents',
    title: 'Coding agents',
    items: [{ id: 'aider', label: 'Aider', sub: 'open source', active: false, dot: '#e8a33d' }],
  };
  const warnLine: TranscriptLine = {
    key: 'l2',
    t: 'warn',
    text: 'context high',
    chips: [{ label: '/compact', cmd: '/compact' }],
  };

  it('sends list clicks in a blurred pane to that pane session', () => {
    const codex = { ...sessionById(state, state.sessions[1].id)!, lines: [listLine] };
    const actions = noopActions();
    const { getByText } = mkPane(codex, false, actions);

    fireEvent.click(getByText('Aider'));
    expect(actions.pickItem).toHaveBeenCalledWith(codex.id, 'agents', 'aider');
  });

  it('sends chip clicks in a blurred pane to that pane session', () => {
    const codex = { ...sessionById(state, state.sessions[1].id)!, lines: [warnLine] };
    const actions = noopActions();
    const { getByText } = mkPane(codex, false, actions);

    fireEvent.click(getByText('/compact'));
    expect(actions.runQuick).toHaveBeenCalledWith(codex.id, '/compact');
  });
});

describe('auto-scroll', () => {
  // jsdom has no layout, so scrollHeight is stubbed. The behaviour under test is
  // the effect's dependency, not the measurement.
  const SCROLL_HEIGHT = 1000;

  function withStubbedScrollHeight<T>(fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => SCROLL_HEIGHT,
    });
    try {
      return fn();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    }
  }

  const base = sessionById(state, state.focusedId)!;
  const think: TranscriptLine = { key: 'l90', t: 'think', rid: 1 };
  const resp: TranscriptLine = { key: 'l91', t: 'resp', text: 'done' };

  it('sticks to the bottom when a response replaces the spinner at equal line count', () => {
    withStubbedScrollHeight(() => {
      const before = { ...base, lines: [think] };
      const { container, rerender } = mkPane(before, true, noopActions());
      const scroller = container.querySelector('.k-pane-scroll') as HTMLElement;

      scroller.scrollTop = 0; // simulate the user having scrolled up

      // The swap removes `think` and appends `resp`: same length, new last key.
      const after = { ...base, lines: [resp] };
      rerender(
        <Pane
          session={after}
          focused
          glow
          actions={noopActions()}
          onFocus={() => {}}
          input={{ ...blankInput, focusToken: after.id }}
        />,
      );

      expect(scroller.scrollTop).toBe(SCROLL_HEIGHT);
    });
  });

  it('scrolls to the bottom on the initial render', () => {
    withStubbedScrollHeight(() => {
      const { container } = mkPane({ ...base, lines: [resp] }, true, noopActions());
      expect((container.querySelector('.k-pane-scroll') as HTMLElement).scrollTop).toBe(
        SCROLL_HEIGHT,
      );
    });
  });
});

describe('pane input', () => {
  it('only the focused pane gets an input; the other offers click-to-focus', () => {
    const s = sessionById(state, state.focusedId)!;
    expect(mkPane(s, true, noopActions()).container.querySelector('.k-input')).toBeTruthy();

    const blurred = mkPane(s, false, noopActions()).container;
    expect(blurred.querySelector('.k-input')).toBeNull();
    expect(blurred.querySelector('.k-pane-bg')?.textContent).toContain('click to focus');
  });
});
