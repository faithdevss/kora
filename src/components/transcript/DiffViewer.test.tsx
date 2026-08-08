import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DiffViewer, looksLikeDiff, pairRows, parseDiff } from './DiffViewer';
import { stripPrompts } from './CodeBlock';

const PATCH = [
  'diff --git a/auth.ts b/auth.ts',
  '@@ -10,4 +10,5 @@ export function login() {',
  ' const session = start();',
  '-  session.ttl = 30;',
  '+  session.ttl = 30_000;',
  '+  session.touch();',
  ' return session;',
].join('\n');

describe('parseDiff', () => {
  it('numbers lines from the hunk header, per side', () => {
    const rows = parseDiff(PATCH);
    const ctx = rows.find((r) => r.kind === 'ctx')!;
    expect(ctx.oldNo).toBe(10);
    expect(ctx.newNo).toBe(10);

    const del = rows.find((r) => r.kind === 'del')!;
    expect(del.oldNo).toBe(11);
    expect(del.newNo).toBeUndefined();

    const add = rows.find((r) => r.kind === 'add')!;
    expect(add.newNo).toBe(11);
    expect(add.oldNo).toBeUndefined();
  });

  it('classifies headers and hunk markers as metadata', () => {
    const kinds = parseDiff(PATCH).map((r) => r.kind);
    expect(kinds.slice(0, 2)).toEqual(['meta', 'meta']);
  });

  it('strips the marker column from the text it shows', () => {
    const add = parseDiff(PATCH).find((r) => r.kind === 'add')!;
    expect(add.text).toBe('  session.ttl = 30_000;');
  });
});

describe('looksLikeDiff', () => {
  it('trusts an explicit fence label', () => {
    expect(looksLikeDiff('anything at all', 'diff')).toBe(true);
    expect(looksLikeDiff('anything at all', 'patch')).toBe(true);
  });

  it('recognises a hunk header whatever the fence said', () => {
    expect(looksLikeDiff(PATCH, 'ts')).toBe(true);
  });

  it('does not mistake ordinary code for a diff', () => {
    const code = 'const a = 1;\nconst b = 2;\nreturn a + b;';
    expect(looksLikeDiff(code, 'ts')).toBe(false);
  });
});

describe('pairRows', () => {
  it('lines a deletion up beside the addition that replaced it', () => {
    const pairs = pairRows(parseDiff(PATCH));
    const changed = pairs.find(([l, r]) => l?.kind === 'del' && r?.kind === 'add')!;
    expect(changed[0]!.text).toContain('30;');
    expect(changed[1]!.text).toContain('30_000;');
  });

  it('leaves the left side empty for an addition with no counterpart', () => {
    const pairs = pairRows(parseDiff(PATCH));
    const added = pairs.filter(([l, r]) => l === null && r?.kind === 'add');
    expect(added).toHaveLength(1);
    expect(added[0][1]!.text).toContain('session.touch();');
  });
});

describe('DiffViewer', () => {
  it('renders a unified view, and switches to side by side', () => {
    const { container, getByRole } = render(<DiffViewer source={PATCH} />);
    expect(container.querySelectorAll('.k-diff-row').length).toBeGreaterThan(0);
    expect(container.querySelector('.k-diff-pair')).toBeNull();

    fireEvent.click(getByRole('button', { name: 'side by side' }));
    expect(container.querySelectorAll('.k-diff-pair').length).toBeGreaterThan(0);
  });

  it('shows the file line numbers, not row indices', () => {
    const { container } = render(<DiffViewer source={PATCH} />);
    const gutters = Array.from(container.querySelectorAll('.k-diff-no')).map(
      (n) => n.textContent,
    );
    expect(gutters).toContain('10');
    expect(gutters).toContain('11');
  });
});

describe('stripPrompts', () => {
  it('removes shell prompts so a copied command can be pasted and run', () => {
    expect(stripPrompts('$ npm test\n$ npm run build')).toBe('npm test\nnpm run build');
  });

  it('leaves code that merely contains > alone', () => {
    const code = 'if (a > b) {\n  return a;\n}';
    expect(stripPrompts(code)).toBe(code);
  });

  it('keeps indentation that was there before the prompt', () => {
    expect(stripPrompts('  $ cd src\n  $ ls')).toBe('  cd src\n  ls');
  });
});
