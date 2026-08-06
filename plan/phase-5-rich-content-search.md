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
