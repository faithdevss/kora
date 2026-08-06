import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Attachment, ListKind, PermissionDecision, Session } from '../types/agent';
import { agentOf } from '../state/appState';
import { Transcript, type TranscriptActions } from './transcript/Transcript';
import { CommandInput } from './CommandInput';

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
}

interface Props {
  session: Session;
  focused: boolean;
  glow: boolean;
  query?: string;
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
    onAttach: () => void;
    onPasteImage: () => void;
    onRemoveAttachment: (id: string) => void;
  };
}

export function Pane({ session, focused, glow, query, actions, onFocus, input }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
    }),
    [actions, session.id],
  );

  return (
    <div
      className={'k-pane' + (focused ? ' is-focused' : '')}
      onClick={focused ? undefined : onFocus}
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
        <Transcript session={session} agent={agent} query={query} actions={paneActions} />
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
          onAttach={input.onAttach}
          onPasteImage={input.onPasteImage}
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
