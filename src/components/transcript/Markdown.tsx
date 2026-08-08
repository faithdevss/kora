/**
 * Rendered markdown, and the only place in Kora that mounts HTML.
 *
 * The HTML comes from `state/markdown.ts`, which sanitizes it; this component
 * adds nothing to it but search highlighting, which it applies to text nodes of
 * the already-sanitized tree.
 */

import { useEffect, useRef } from 'react';
import { markMatches, renderMarkdown } from '../../state/markdown';

interface Props {
  text: string;
  /** Active scrollback search, highlighted in place. */
  query?: string;
}

export function Markdown({ text, query }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.innerHTML = renderMarkdown(text);
    if (query) markMatches(host, query);
  }, [text, query]);

  return <div className="k-md" ref={ref} />;
}
