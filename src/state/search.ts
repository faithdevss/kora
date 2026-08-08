/**
 * Scrollback search.
 *
 * Searches the session's whole transcript — every line the store holds, not the
 * subset React has mounted — so a match twenty screens up is found (phase-5
 * acceptance criterion 5). Three modes, because they answer different
 * questions: `plain` for a literal string, `regex` for a pattern, `fuzzy` for
 * "the characters, in order, somewhere".
 */

import type { Session, TranscriptLine } from '../types/agent';
import { lineText } from './sessionStore';

export type SearchMode = 'plain' | 'regex' | 'fuzzy';

/** One match, located precisely enough to scroll to and highlight. */
export interface Match {
  /** React key of the line it is in. */
  key: string;
  /** Index of the line in the transcript. */
  lineIndex: number;
  /** Character offset within the line's searchable text. */
  at: number;
  length: number;
}

/** Compiles a query into something that can find matches in a string. */
function matcher(query: string, mode: SearchMode): ((text: string) => Match[]) | null {
  if (!query) return null;

  if (mode === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(query, 'gi');
    } catch {
      // An unfinished pattern while typing is not an error worth shouting
      // about; it simply matches nothing until it parses.
      return null;
    }
    return (text) => {
      const out: Match[] = [];
      re.lastIndex = 0;
      for (;;) {
        const m = re.exec(text);
        if (!m) break;
        // A zero-width match would loop forever otherwise.
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        out.push({ key: '', lineIndex: 0, at: m.index, length: m[0].length });
      }
      return out;
    };
  }

  if (mode === 'fuzzy') {
    const needle = query.toLowerCase().replace(/\s+/g, '');
    return (text) => {
      const hay = text.toLowerCase();
      let i = 0;
      let start = -1;
      for (let j = 0; j < hay.length && i < needle.length; j++) {
        if (hay[j] === needle[i]) {
          if (i === 0) start = j;
          i += 1;
        }
      }
      // One match per line: the span from the first character to the last.
      return i === needle.length && start >= 0
        ? [{ key: '', lineIndex: 0, at: start, length: 1 }]
        : [];
    };
  }

  const needle = query.toLowerCase();
  return (text) => {
    const out: Match[] = [];
    const hay = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      out.push({ key: '', lineIndex: 0, at, length: query.length });
      from = at + needle.length;
    }
    return out;
  };
}

/** Every match in a session's transcript, in transcript order. */
export function findMatches(session: Session, query: string, mode: SearchMode): Match[] {
  const find = matcher(query, mode);
  if (!find) return [];
  const out: Match[] = [];
  session.lines.forEach((line: TranscriptLine, lineIndex) => {
    const text = lineText(line);
    if (!text) return;
    for (const m of find(text)) {
      out.push({ ...m, key: line.key, lineIndex });
    }
  });
  return out;
}

/** Whether a line contains a match, for per-line highlighting. */
export function lineMatches(text: string, query: string, mode: SearchMode): boolean {
  const find = matcher(query, mode);
  return Boolean(find && find(text).length);
}

/** Wraps an index into range, so next/prev cycle rather than stopping. */
export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
