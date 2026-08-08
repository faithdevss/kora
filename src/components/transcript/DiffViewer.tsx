/**
 * Unified diff rendering, with an optional side-by-side view.
 *
 * Phase 1 coloured `+`/`-` lines; this parses the hunks properly, so line
 * numbers are the file's own and the split view can pair changes up. Content is
 * always React children — a diff is text, and text is all it renders as.
 */

import { useState } from 'react';

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** Line number in the original file, when the row has one. */
  oldNo?: number;
  /** Line number in the new file, when the row has one. */
  newNo?: number;
}

const HUNK = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/** Parses a unified diff, tracking real line numbers through each hunk. */
export function parseDiff(source: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const line of source.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    // File headers, and any other hunk-ish marker we could not parse numbers
    // out of, are metadata rather than content.
    if (/^(@@|diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

/** Whether a block looks like a unified diff, whatever its fence claimed. */
export function looksLikeDiff(source: string, lang?: string): boolean {
  if (lang === 'diff' || lang === 'patch') return true;
  const lines = source.split('\n');
  const marked = lines.filter((l) => /^[+-]/.test(l)).length;
  return lines.some((l) => HUNK.test(l)) || (lines.length > 2 && marked >= lines.length / 2);
}

/** Pairs deletions with the additions that replaced them, for the split view. */
export function pairRows(rows: DiffRow[]): [DiffRow | null, DiffRow | null][] {
  const pairs: [DiffRow | null, DiffRow | null][] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'del') {
      const dels: DiffRow[] = [];
      while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++]);
      const adds: DiffRow[] = [];
      while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        pairs.push([dels[k] ?? null, adds[k] ?? null]);
      }
      continue;
    }
    if (row.kind === 'add') {
      pairs.push([null, row]);
    } else {
      pairs.push([row, row]);
    }
    i += 1;
  }
  return pairs;
}

function Gutter({ n }: { n?: number }) {
  return <span className="k-diff-no">{n ?? ''}</span>;
}

function Unified({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="k-diff">
      {rows.map((row, i) => (
        <div key={i} className={`k-diff-row k-diff-${row.kind}`}>
          <Gutter n={row.oldNo} />
          <Gutter n={row.newNo} />
          <span className="k-diff-sign">
            {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
          </span>
          <span className="k-diff-text">{row.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function Split({ rows }: { rows: DiffRow[] }) {
  const pairs = pairRows(rows);
  return (
    <div className="k-diff is-split">
      {pairs.map(([left, right], i) => (
        <div key={i} className="k-diff-pair">
          <div className={`k-diff-side k-diff-${left?.kind ?? 'empty'}`}>
            <Gutter n={left?.oldNo} />
            <span className="k-diff-text">{left && left.kind !== 'add' ? left.text || ' ' : ' '}</span>
          </div>
          <div className={`k-diff-side k-diff-${right?.kind ?? 'empty'}`}>
            <Gutter n={right?.newNo} />
            <span className="k-diff-text">
              {right && right.kind !== 'del' ? right.text || ' ' : ' '}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function DiffViewer({ source }: { source: string }) {
  const [split, setSplit] = useState(false);
  const rows = parseDiff(source);

  return (
    <div className="k-diff-wrap">
      <button
        type="button"
        className="k-code-btn k-diff-toggle"
        onClick={() => setSplit((s) => !s)}
        title={split ? 'Show as a unified diff' : 'Show the two sides separately'}
      >
        {split ? 'unified' : 'side by side'}
      </button>
      {split ? <Split rows={rows} /> : <Unified rows={rows} />}
    </div>
  );
}
