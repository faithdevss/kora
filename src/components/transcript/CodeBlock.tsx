/**
 * Fenced code block. Diff lines get +/−/@ colouring; anything else renders as
 * plain text. Content is always React children, never HTML.
 * Phase 5 replaces this with full syntax highlighting (still text-only output).
 */

interface Props {
  block: string;
  lang?: string;
}

function diffClass(line: string): string {
  if (line.startsWith('+')) return 'k-diff-add';
  if (line.startsWith('-')) return 'k-diff-del';
  if (line.startsWith('@') || line.startsWith('diff')) return 'k-diff-meta';
  return 'k-diff-ctx';
}

export function CodeBlock({ block, lang }: Props) {
  return (
    <pre className="k-code">
      {lang === 'diff' ? (
        block.split('\n').map((ln, i) => (
          <div key={i} className={diffClass(ln)}>
            {ln || ' '}
          </div>
        ))
      ) : (
        <span className="k-code-plain">{block}</span>
      )}
    </pre>
  );
}
