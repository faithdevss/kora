/**
 * The chips above the input, one per attached file.
 *
 * An image shows the actual bytes as a thumbnail — the point of attaching one
 * is to see what the agent will see. Text and binary files show a type icon and
 * their size, with truncation stated on the chip rather than hidden in a log
 * line the user has already scrolled past.
 */

import type { Attachment } from '../types/agent';

/** Bytes as something a person reads. Mirrors `files::ingest::human`. */
function human(bytes: number): string {
  const kb = 1024;
  if (bytes >= kb * kb) return `${(bytes / (kb * kb)).toFixed(1)} MB`;
  if (bytes >= kb) return `${Math.round(bytes / kb)} KB`;
  return `${bytes} B`;
}

function Icon({ kind }: { kind: Attachment['kind'] }) {
  if (kind === 'image') {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--ac)" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    );
  }
  if (kind === 'binary') {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="2">
        <path d="M12 2l8 4v12l-8 4-8-4V6z" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--ac)" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

interface Props {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}

export function AttachmentRow({ attachments, onRemove }: Props) {
  if (!attachments.length) return null;

  return (
    <div className="k-atts">
      {attachments.map((a) => (
        <span
          key={a.id}
          className={'k-att is-' + a.kind}
          title={[a.path || a.name, human(a.size), a.note].filter(Boolean).join(' · ')}
        >
          {a.kind === 'image' && a.data ? (
            <img
              className="k-att-thumb"
              src={`data:${a.mediaType};base64,${a.data}`}
              alt={a.name}
            />
          ) : (
            <Icon kind={a.kind} />
          )}
          <span className="k-att-name">{a.name}</span>
          <span className="k-att-size">{human(a.size)}</span>
          {a.truncated ? <span className="k-att-flag">truncated</span> : null}
          {a.kind === 'binary' ? <span className="k-att-flag">path only</span> : null}
          <button
            type="button"
            className="k-att-remove"
            title="Remove attachment"
            onClick={() => onRemove(a.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
