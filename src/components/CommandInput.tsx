import { useEffect, useRef } from 'react';
import type { Attachment } from '../types/agent';
import { CommandPalette } from './CommandPalette';

interface Props {
  value: string;
  matches: string[];
  attachments: Attachment[];
  /** Changes whenever focus should return to the input (pane switch, new tab). */
  focusToken: string;
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
}

export function CommandInput(props: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [props.focusToken]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onSubmit();
      return;
    }
    if (e.key === 'Escape') {
      props.onEscape();
      return;
    }
    if (e.key === 'Tab') {
      if (props.onTabComplete()) e.preventDefault();
      return;
    }
    // Only swallow the arrow key when history actually moves, so caret
    // navigation still works in a session with no history.
    if (e.key === 'ArrowUp') {
      if (props.onHistoryPrev()) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (props.onHistoryNext()) e.preventDefault();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    // Phase 5 reads the real bitmap; Phase 1 only creates the chip.
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type?.startsWith('image')) {
        e.preventDefault();
        props.onPasteImage();
        return;
      }
    }
  }

  return (
    <div className="k-inputbar">
      {/* onPickCmd returns focus here via the store's focusNonce. */}
      <CommandPalette matches={props.matches} onPick={props.onPickCmd} />
      <div className="k-inputrow">
        <span className="k-prompt">❯</span>
        <div className="k-inputcol">
          {props.attachments.length ? (
            <div className="k-atts">
              {props.attachments.map((a) => (
                <span key={a.id} className="k-att">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--ac)" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  {a.name}
                  <span
                    className="k-att-remove"
                    title="Remove attachment"
                    onClick={() => props.onRemoveAttachment(a.id)}
                  >
                    ×
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          <input
            ref={ref}
            className="k-input"
            value={props.value}
            placeholder="Ask the agent, or type / for commands"
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="k-icon-btn k-attach"
          title="Attach image (or paste)"
          onClick={props.onAttach}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10 15" />
          </svg>
        </button>
        <span className="k-sendhint">⏎ send</span>
      </div>
    </div>
  );
}
