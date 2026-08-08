import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ListKind, PermissionDecision, Session } from '../types/agent';
import { agentOf } from '../state/appState';
import { Transcript, type TranscriptActions } from './transcript/Transcript';
import { CommandInput, readAsBase64 } from './CommandInput';

/** Pane-level callbacks. Every one takes the owning session id so a click in a
 *  blurred split pane acts on that pane, not on whichever pane has focus. */
export interface PaneActions {
  runQuick: (sessionId: string, cmd: string) => void;
  pickItem: (sessionId: string, kind: ListKind, itemId: string) => void;
  fillInput: (cmd: string) => void;
  answerPermission: (
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ) => void;
  /** Save a code block from the transcript. */
  saveBlock: (sessionId: string, contents: string, suggestedName: string) => void;
  /** Open a file the transcript referred to. */
  openInEditor: (sessionId: string, path: string) => void;
  /** Bytes dropped or pasted onto this pane. */
  attachBytes: (sessionId: string, name: string, dataBase64: string, mediaType: string) => void;
  /** Something the user tried to attach that Kora will not take. */
  rejectDrop: (sessionId: string, message: string) => void;
}

interface Props {
  session: Session;
  focused: boolean;
  glow: boolean;
  query?: string;
  /** React key of the line holding the match the user is parked on. */
  activeMatchKey?: string;
  actions: PaneActions;
  onFocus: () => void;
  /** Input wiring — only rendered for the focused pane. */
  input: {
    /** Changes whenever focus should return to the input. */
    focusToken: string;
    value: string;
    matches: string[];
    attachments: Attachment[];
    onChange: (v: string) => void;
    onSubmit: () => void;
    onEscape: () => void;
    onTabComplete: () => boolean;
    onHistoryPrev: () => boolean;
    onHistoryNext: () => boolean;
    onPickCmd: (cmd: string) => void;
    vision: boolean;
    onRemoveAttachment: (id: string) => void;
  };
}

export function Pane({
  session,
  focused,
  glow,
  query,
  activeMatchKey,
  actions,
  onFocus,
  input,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const agent = agentOf(session);

  // Keyed on the last line's key, not on the line count: a response both removes
  // the `think` line and appends a `resp`, leaving the count unchanged.
  const lastKey = session.lines[session.lines.length - 1]?.key;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastKey, session.id]);

  const paneActions: TranscriptActions = useMemo(
    () => ({
      runQuick: (cmd) => actions.runQuick(session.id, cmd),
      pickItem: (kind, itemId) => actions.pickItem(session.id, kind, itemId),
      fillInput: actions.fillInput,
      answerPermission: (requestId, decision) =>
        actions.answerPermission(session.id, requestId, decision),
      code: {
        save: (contents: string, suggestedName: string) =>
          actions.saveBlock(session.id, contents, suggestedName),
        openInEditor: (path: string) => actions.openInEditor(session.id, path),
      },
    }),
    [actions, session.id],
  );

  /**
   * Files dropped anywhere on the pane, not just on a drop target.
   *
   * A folder has no bytes to read here, so it is refused with a line the user
   * can act on rather than silently ingesting whatever files it happens to
   * contain (phase-5 scope: single files for v1).
   */
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropping(false);
    const items = Array.from(e.dataTransfer?.items ?? []);
    const folder = items.some(
      (i) => i.kind === 'file' && i.webkitGetAsEntry?.()?.isDirectory,
    );
    if (folder) {
      actions.rejectDrop(
        session.id,
        'Dropping a folder is not supported — drop a single file, or ask the agent to read the directory itself.',
      );
      return;
    }
    for (const file of Array.from(e.dataTransfer?.files ?? [])) {
      // A folder arrives as a zero-byte, type-less entry; the backend would
      // refuse it, but there is nothing to send it in the first place.
      if (!file.type && file.size === 0) continue;
      void readAsBase64(file).then((data) =>
        actions.attachBytes(
          session.id,
          file.name,
          data,
          file.type || 'application/octet-stream',
        ),
      );
    }
  }

  return (
    <div
      className={
        'k-pane' + (focused ? ' is-focused' : '') + (dropping ? ' is-dropping' : '')
      }
      onClick={focused ? undefined : onFocus}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer really left the pane, not on every child.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
      // Each pane wears its own agent's accent, so a split Claude+Codex view
      // shows orange and green side by side.
      style={
        {
          '--ac': agent.accent,
          '--ac-dim': agent.accent + '22',
          '--ac-soft': agent.accent + '12',
          '--ac-edge': agent.accent + '66',
          '--glow': glow ? `0 0 10px ${agent.accent}88` : 'none',
        } as React.CSSProperties
      }
    >
      <div className="k-pane-rule" />
      <div ref={scrollRef} className="k-pane-scroll kscroll">
        <Transcript
          session={session}
          agent={agent}
          query={query}
          activeMatchKey={activeMatchKey}
          actions={paneActions}
        />
      </div>

      {focused ? (
        <CommandInput
          value={input.value}
          matches={input.matches}
          attachments={input.attachments}
          focusToken={input.focusToken}
          onChange={input.onChange}
          onSubmit={input.onSubmit}
          onEscape={input.onEscape}
          onTabComplete={input.onTabComplete}
          onHistoryPrev={input.onHistoryPrev}
          onHistoryNext={input.onHistoryNext}
          onPickCmd={input.onPickCmd}
          vision={input.vision}
          onAttachBytes={(name, data, mediaType) =>
            actions.attachBytes(session.id, name, data, mediaType)
          }
          onRemoveAttachment={input.onRemoveAttachment}
        />
      ) : (
        <button type="button" className="k-pane-bg" onClick={onFocus}>
          <span className="k-pane-bg-dot" />
          session running in background — click to focus
        </button>
      )}
    </div>
  );
}
