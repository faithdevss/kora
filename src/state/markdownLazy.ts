/**
 * Loads the markdown renderer on first use.
 *
 * `state/markdown.ts` pulls in marked, DOMPurify and highlight.js — together
 * about two-thirds of Kora's JavaScript. None of it is needed to show a window,
 * a prompt, or a command: it is needed the first time an agent says something.
 * So it lives in its own chunk, fetched then (phase-6 performance pass).
 *
 * The promise is cached, so the second response waits for nothing.
 */

type MarkdownModule = typeof import('./markdown');

let pending: Promise<MarkdownModule> | null = null;
let ready: MarkdownModule | null = null;

/** The renderer, loading it if this is the first call. */
export function loadMarkdown(): Promise<MarkdownModule> {
  pending ??= import('./markdown').then((m) => {
    ready = m;
    return m;
  });
  return pending;
}

/**
 * The renderer if it is already in memory, else `null`.
 *
 * Lets a component render synchronously once the chunk has arrived, instead of
 * flashing a placeholder on every subsequent response.
 */
export function loadedMarkdown(): MarkdownModule | null {
  return ready;
}
