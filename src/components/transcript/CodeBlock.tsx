/**
 * A fenced code block, with the things you actually want to do to one: copy it,
 * save it, open the file it came from, or read it as a diff.
 *
 * Highlighting comes from `state/markdown.ts`, which sanitizes what it
 * produces; nothing else here mounts HTML.
 */

import { useEffect, useRef, useState } from 'react';
import { highlightCode } from '../../state/markdown';
import { DiffViewer, looksLikeDiff } from './DiffViewer';

export interface CodeActions {
  /** Save the block to a path the user gives. */
  save: (contents: string, suggestedName: string) => void;
  /** Open a path in the user's editor. */
  openInEditor: (path: string) => void;
}

interface Props {
  block: string;
  lang?: string;
  /** Path this block came from, when a tool call named one. */
  path?: string;
  actions?: CodeActions;
}

/**
 * Strips the shell prompt characters a copied command block starts with, so
 * pasting into a terminal runs it rather than complaining about `$`
 * (`docs/features.gpt.md` §14).
 */
export function stripPrompts(code: string): string {
  const lines = code.split('\n');
  const prompted = lines.filter((l) => /^\s*[$>]\s+\S/.test(l));
  // Only when prompts are the rule rather than a stray `>` inside real code.
  if (!prompted.length || prompted.length < lines.filter((l) => l.trim()).length / 2) {
    return code;
  }
  return lines.map((l) => l.replace(/^(\s*)[$>]\s+/, '$1')).join('\n');
}

/** A plausible filename for a block, from its language. */
function suggestName(lang?: string): string {
  const ext: Record<string, string> = {
    typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js',
    python: 'py', py: 'py', rust: 'rs', rs: 'rs', go: 'go', json: 'json',
    yaml: 'yaml', yml: 'yaml', bash: 'sh', sh: 'sh', shell: 'sh', sql: 'sql',
    html: 'html', css: 'css', java: 'java', ruby: 'rb', diff: 'patch',
  };
  return `snippet.${ext[(lang ?? '').toLowerCase()] ?? 'txt'}`;
}

export function CodeBlock({ block, lang, path, actions }: Props) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const isDiff = looksLikeDiff(block, lang);

  useEffect(() => {
    if (ref.current && !isDiff) ref.current.innerHTML = highlightCode(block, lang);
  }, [block, lang, isDiff]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    const text = stripPrompts(block);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* a denied clipboard is not worth an error line in the transcript */
    }
  }

  return (
    <div className="k-code-wrap">
      <div className="k-code-bar">
        {lang ? <span className="k-code-lang">{lang}</span> : null}
        {path ? <span className="k-code-path">{path}</span> : null}
        <span className="k-code-spacer" />
        <button type="button" className="k-code-btn" onClick={copy} title="Copy to clipboard">
          {copied ? 'copied' : 'copy'}
        </button>
        {actions ? (
          <button
            type="button"
            className="k-code-btn"
            onClick={() => actions.save(block, suggestName(lang))}
            title="Save this block to a file"
          >
            save
          </button>
        ) : null}
        {actions && path ? (
          <button
            type="button"
            className="k-code-btn"
            onClick={() => actions.openInEditor(path)}
            title={`Open ${path} in your editor`}
          >
            open
          </button>
        ) : null}
      </div>
      {isDiff ? (
        <DiffViewer source={block} />
      ) : (
        <pre className="k-code">
          <code ref={ref} className="hljs" />
        </pre>
      )}
    </div>
  );
}
