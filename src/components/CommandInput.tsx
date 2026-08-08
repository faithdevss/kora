import { useEffect, useRef } from 'react';
import type { Attachment } from '../types/agent';
import { AttachmentRow } from './AttachmentRow';
import { CommandPalette } from './CommandPalette';

interface Props {
  value: string;
  matches: string[];
  attachments: Attachment[];
  /** Changes whenever focus should return to the input (pane switch, new tab). */
  focusToken: string;
  /** Whether the current agent accepts images, which gates the picker. */
  vision: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onEscape: () => void;
  onTabComplete: () => boolean;
  onHistoryPrev: () => boolean;
  onHistoryNext: () => boolean;
  onPickCmd: (cmd: string) => void;
  /** Real bytes from a paste or the file picker, base64-encoded. */
  onAttachBytes: (name: string, dataBase64: string, mediaType: string) => void;
  onRemoveAttachment: (id: string) => void;
}

/** Reads a File/Blob as base64, without the `data:` prefix. */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read that file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Grows the textarea with its content, up to a few lines. */
function autoSize(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

export function CommandInput(props: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [props.focusToken]);

  useEffect(() => {
    autoSize(ref.current);
  }, [props.value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Shift+Enter is a newline; Enter alone sends. A pasted multi-line block
      // stays as it was pasted until the user chooses to send it.
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
    // History only takes the arrow key when the caret is at the edge of a
    // single-line input; multi-line editing keeps normal caret movement.
    const multiline = props.value.includes('\n');
    if (e.key === 'ArrowUp' && !multiline) {
      if (props.onHistoryPrev()) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && !multiline) {
      if (props.onHistoryNext()) e.preventDefault();
    }
  }

  /**
   * Paste.
   *
   * An image on the clipboard is attached with its real bytes; text is left to
   * the browser, which keeps newlines and indentation exactly as they were.
   */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const image = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!image) return;

    const file = image.getAsFile();
    if (!file) return;
    e.preventDefault();
    void readAsBase64(file).then((data) =>
      props.onAttachBytes(file.name || 'pasted.png', data, file.type || 'image/png'),
    );
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      void readAsBase64(file).then((data) =>
        props.onAttachBytes(file.name, data, file.type || 'application/octet-stream'),
      );
    }
    // Let the same file be chosen twice in a row.
    e.target.value = '';
  }

  return (
    <div className="k-inputbar">
      {/* onPickCmd returns focus here via the store's focusNonce. */}
      <CommandPalette matches={props.matches} onPick={props.onPickCmd} />
      <div className="k-inputrow">
        <span className="k-prompt">❯</span>
        <div className="k-inputcol">
          <AttachmentRow attachments={props.attachments} onRemove={props.onRemoveAttachment} />
          <textarea
            ref={ref}
            className="k-input"
            rows={1}
            value={props.value}
            placeholder="Ask the agent, or type / for commands"
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <input
          ref={picker}
          type="file"
          className="k-file-input"
          multiple
          // An agent that cannot see images is not offered them.
          accept={props.vision ? undefined : '.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.rb,.php,.c,.h,.cpp,.sh,.sql,.html,.css,.xml'}
          onChange={onPick}
          tabIndex={-1}
        />
        <button
          type="button"
          className="k-icon-btn k-attach"
          title={props.vision ? 'Attach a file or image (or paste one)' : 'Attach a file'}
          onClick={() => picker.current?.click()}
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
