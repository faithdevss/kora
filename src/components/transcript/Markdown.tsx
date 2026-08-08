/**
 * Rendered markdown, and the only place in Kora that mounts HTML.
 *
 * The HTML comes from `state/markdown.ts`, which sanitizes it; this component
 * adds nothing to it but search highlighting, which it applies to text nodes of
 * the already-sanitized tree.
 *
 * The renderer is loaded on first use rather than at startup (see
 * `state/markdownLazy.ts`). Until it arrives the text is mounted as a text
 * node, which is readable and cannot be markup by construction.
 */

import { useEffect, useRef, useState } from 'react';
import { loadMarkdown, loadedMarkdown } from '../../state/markdownLazy';

interface Props {
  text: string;
  /** Active scrollback search, highlighted in place. */
  query?: string;
}

export function Markdown({ text, query }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Bumped when the renderer arrives, so the placeholder is replaced.
  const [loaded, setLoaded] = useState(() => loadedMarkdown() !== null);

  useEffect(() => {
    let cancelled = false;
    const host = ref.current;
    if (!host) return;

    const md = loadedMarkdown();
    if (md) {
      host.innerHTML = md.renderMarkdown(text);
      if (query) md.markMatches(host, query);
      return;
    }

    // First response of the session: show the text, then upgrade it in place.
    host.textContent = '';
    host.append(document.createTextNode(text));
    void loadMarkdown().then(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [text, query, loaded]);

  return <div className="k-md" ref={ref} />;
}
