/**
 * Case-insensitive search highlighting.
 *
 * Returns React children — never an HTML string. Agent output and file content
 * are attacker-reachable in a coding-agent context, so no path in this codebase
 * may pass them through `dangerouslySetInnerHTML` (master plan, Security #1).
 */

interface Props {
  text: string;
  query?: string;
}

export function Highlight({ text, query }: Props) {
  if (!query) return <>{text}</>;

  const low = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  for (;;) {
    const idx = low.indexOf(q, i);
    if (idx < 0) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={k++} className="k-mark">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    i = idx + query.length;
  }

  return <>{out}</>;
}

/** Count of non-overlapping matches of `query` in `text`. */
export function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const low = text.toLowerCase();
  const q = query.toLowerCase();
  let n = 0;
  let i = low.indexOf(q);
  while (i >= 0) {
    n++;
    i = low.indexOf(q, i + q.length);
  }
  return n;
}
