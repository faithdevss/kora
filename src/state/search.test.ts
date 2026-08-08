import { describe, expect, it } from 'vitest';
import { __resetIds, mkSession, withKey } from './appState';
import { findMatches, lineMatches, wrapIndex } from './search';
import type { NewLine, Session } from '../types/agent';

/** A session whose transcript is exactly these lines. */
function sess(lines: NewLine[]): Session {
  __resetIds();
  return { ...mkSession('claude'), lines: lines.map(withKey) };
}

describe('findMatches', () => {
  it('searches the whole transcript, not just the last screen of it', () => {
    const many: NewLine[] = Array.from({ length: 200 }, (_, i) => ({
      t: 'out' as const,
      text: i === 3 ? 'the needle is here' : `filler ${i}`,
    }));
    const matches = findMatches(sess(many), 'needle', 'plain');

    expect(matches).toHaveLength(1);
    expect(matches[0].lineIndex).toBe(3);
  });

  it('finds code blocks, not only the prose above them', () => {
    const s = sess([
      { t: 'resp', text: 'here you go', block: 'const timeout = 30;', lang: 'ts' },
    ]);
    expect(findMatches(s, 'timeout', 'plain')).toHaveLength(1);
  });

  it('reports every occurrence, in transcript order', () => {
    const s = sess([
      { t: 'cmd', text: 'token token' },
      { t: 'out', text: 'one token' },
    ]);
    const matches = findMatches(s, 'token', 'plain');

    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.lineIndex)).toEqual([0, 0, 1]);
    expect(matches[0].at).toBe(0);
    expect(matches[1].at).toBe(6);
  });

  it('ignores case', () => {
    const s = sess([{ t: 'out', text: 'Token' }]);
    expect(findMatches(s, 'token', 'plain')).toHaveLength(1);
    expect(findMatches(s, 'TOKEN', 'plain')).toHaveLength(1);
  });

  it('finds nothing for an empty query', () => {
    expect(findMatches(sess([{ t: 'out', text: 'x' }]), '', 'plain')).toEqual([]);
  });

  describe('regex mode', () => {
    it('matches by pattern', () => {
      const s = sess([{ t: 'out', text: 'error 404, error 500, ok 200' }]);
      const matches = findMatches(s, 'error \\d+', 'regex');
      expect(matches).toHaveLength(2);
    });

    it('treats an unfinished pattern as no matches rather than an error', () => {
      const s = sess([{ t: 'out', text: 'anything' }]);
      expect(() => findMatches(s, 'error (', 'regex')).not.toThrow();
      expect(findMatches(s, 'error (', 'regex')).toEqual([]);
    });

    it('cannot hang on a zero-width pattern', () => {
      const s = sess([{ t: 'out', text: 'abc' }]);
      expect(findMatches(s, 'x*', 'regex')).toEqual([]);
    });
  });

  describe('fuzzy mode', () => {
    it('matches characters in order, with gaps', () => {
      const s = sess([{ t: 'out', text: 'session lifecycle manager' }]);
      expect(findMatches(s, 'sesmgr', 'fuzzy')).toHaveLength(1);
    });

    it('does not match characters out of order', () => {
      const s = sess([{ t: 'out', text: 'session lifecycle manager' }]);
      expect(findMatches(s, 'mgrses', 'fuzzy')).toEqual([]);
    });

    it('reports one match per line, not one per character', () => {
      const s = sess([{ t: 'out', text: 'aaa bbb ccc' }]);
      expect(findMatches(s, 'abc', 'fuzzy')).toHaveLength(1);
    });
  });
});

describe('lineMatches', () => {
  it('answers per line, in whichever mode is active', () => {
    expect(lineMatches('the TOKEN budget', 'token', 'plain')).toBe(true);
    expect(lineMatches('nothing here', 'token', 'plain')).toBe(false);
    expect(lineMatches('error 404', 'error \\d+', 'regex')).toBe(true);
    expect(lineMatches('session manager', 'sesmgr', 'fuzzy')).toBe(true);
  });
});

describe('wrapIndex', () => {
  it('cycles in both directions', () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(1, 3)).toBe(1);
  });

  it('is 0 when there is nothing to step through', () => {
    expect(wrapIndex(5, 0)).toBe(0);
  });
});
