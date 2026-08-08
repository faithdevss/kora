import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Transcript } from './transcript/Transcript';
import { Highlight, countMatches } from './Highlight';
import { paletteMatches } from './CommandPalette';
import { AGENTS, COMMON } from '../state/mockFixtures';
import { initialState, focusedSession, availCmds } from '../state/appState';
import { usageData } from '../state/commandRouter';
import type { Session, TranscriptLine } from '../types/agent';

const agent = AGENTS[0];
const actions = {
  runQuick: () => {},
  pickItem: () => {},
  fillInput: () => {},
  answerPermission: () => {},
  code: { save: () => {}, openInEditor: () => {} },
};

function withLines(lines: TranscriptLine[]): Session {
  return { ...focusedSession(initialState()), lines };
}

function renderLines(lines: TranscriptLine[], query?: string) {
  return render(
    <Transcript session={withLines(lines)} agent={agent} query={query} actions={actions} />,
  );
}

describe('transcript renderers', () => {
  it('renders every line type without crashing', () => {
    const state = initialState();
    const data = usageData(state, focusedSession(state));
    const lines: TranscriptLine[] = [
      { key: '1', t: 'banner' },
      { key: '2', t: 'cmd', text: 'do the thing', atts: 2 },
      { key: '3', t: 'resp', text: 'did it', block: '+ added\n- removed', lang: 'diff', tool: 'edit · +1 −1' },
      { key: '4', t: 'out', text: 'plain output' },
      { key: '5', t: 'dim', text: 'dimmed note' },
      { key: '6', t: 'ok', text: 'succeeded' },
      { key: '7', t: 'err', text: 'Unknown command: /agent', hint: '/agents' },
      { key: '8', t: 'think', rid: 1 },
      { key: '9', t: 'warn', text: 'context high', chips: [{ label: '/compact', cmd: '/compact' }] },
      {
        key: '10',
        t: 'list',
        kind: 'agents',
        title: 'Coding agents',
        items: [{ id: 'claude', label: 'Claude Code', sub: 'Anthropic', active: true, dot: '#d97757' }],
      },
      {
        key: '11',
        t: 'help',
        agent: 'Claude Code',
        common: [{ c: '/help', d: 'list every command' }],
        extra: [{ c: '/cost', d: 'estimated cost this session' }],
      },
      {
        key: '12b',
        t: 'perm',
        requestId: 'toolu_1',
        tool: 'Edit',
        detail: 'wants to write src/a.ts',
        scope: 'session_edits',
      },
      { key: '12', t: 'panel', kind: 'usage', data },
      { key: '13', t: 'panel', kind: 'stats', data: { ...data, avgIn: 10, avgOut: 20 } },
    ];

    const { container } = renderLines(lines);
    expect(container.querySelectorAll('.k-line')).toHaveLength(lines.length);
    expect(screen.getByText('did it')).toBeTruthy();
    expect(screen.getAllByText('/agents').length).toBeGreaterThan(0);
    expect(screen.getByText('Claude Code is working…')).toBeTruthy();
  });

  it('colours diff blocks by line prefix', () => {
    const { container } = renderLines([
      { key: '1', t: 'resp', text: 'diff', block: '+ add\n- del\n@@ hunk\n ctx', lang: 'diff' },
    ]);
    expect(container.querySelectorAll('.k-diff-add')).toHaveLength(1);
    expect(container.querySelectorAll('.k-diff-del')).toHaveLength(1);
    expect(container.querySelectorAll('.k-diff-meta')).toHaveLength(1);
    expect(container.querySelectorAll('.k-diff-ctx')).toHaveLength(1);
  });

  it('renders untrusted text as text, never as markup', () => {
    const payload = '<img src=x onerror="alert(1)"> <script>bad()</script>';
    const { container } = renderLines([
      { key: '1', t: 'resp', text: payload, block: payload, lang: 'ts', tool: payload },
      { key: '2', t: 'out', text: payload },
      { key: '3', t: 'cmd', text: payload },
    ]);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>bad()</script>');
  });
});

describe('search highlighting', () => {
  it('wraps every case-insensitive match in a mark', () => {
    const { container } = render(<Highlight text="Auth and auth again" query="auth" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(container.textContent).toBe('Auth and auth again');
  });

  it('returns the text untouched without a query', () => {
    const { container } = render(<Highlight text="nothing to mark" />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('counts non-overlapping matches', () => {
    expect(countMatches('aaa', 'aa')).toBe(1);
    expect(countMatches('token token', 'token')).toBe(2);
    expect(countMatches('anything', '')).toBe(0);
  });

  it('highlights transcript text when a query is active', () => {
    const { container } = renderLines([{ key: '1', t: 'out', text: 'refresh token' }], 'token');
    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });
});

describe('command palette matching', () => {
  const avail = availCmds(focusedSession(initialState()));

  it('matches on a slash prefix', () => {
    expect(paletteMatches('/a', avail)).toEqual(['/agents', '/accounts']);
  });

  it('caps the list at six entries', () => {
    expect(paletteMatches('/', avail)).toHaveLength(6);
  });

  it('closes once an argument is typed, and never opens for prose', () => {
    expect(paletteMatches('/agents ', avail)).toEqual([]);
    expect(paletteMatches('hello', avail)).toEqual([]);
  });

  it('offers agent-specific commands alongside the universal ones', () => {
    expect(paletteMatches('/c', avail)).toContain('/cost');
    expect(avail.slice(0, COMMON.length)).toEqual(COMMON);
  });
});
