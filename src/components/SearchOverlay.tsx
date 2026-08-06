import { useEffect, useRef } from 'react';

interface Props {
  query: string;
  matchCount: number;
  onChange: (v: string) => void;
  onClose: () => void;
}

export function SearchOverlay({ query, matchCount, onChange, onClose }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="k-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.5" y2="16.5" />
      </svg>
      <input
        ref={ref}
        className="k-search-input"
        value={query}
        placeholder="Search scrollback…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="k-search-count">
        {query ? `${matchCount} match${matchCount === 1 ? '' : 'es'}` : ''}
      </span>
      <button type="button" className="k-search-close" title="Close search" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
