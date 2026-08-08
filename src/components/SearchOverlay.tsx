import { useEffect, useRef } from 'react';
import type { SearchHit } from '../state/agentBridge';
import type { SearchMode } from '../state/search';

interface Props {
  query: string;
  mode: SearchMode;
  /** Matches in this session's whole transcript, not just what is on screen. */
  matchCount: number;
  /** Which match is current, 0-based. */
  index: number;
  /** Hits from other saved sessions, once the search was widened. */
  hits: SearchHit[];
  searchingAll: boolean;
  onChange: (v: string) => void;
  onMode: (mode: SearchMode) => void;
  onStep: (delta: number) => void;
  onSearchAll: () => void;
  onOpenHit: (hit: SearchHit) => void;
  onClose: () => void;
}

const MODES: { id: SearchMode; label: string; title: string }[] = [
  { id: 'plain', label: 'text', title: 'Plain substring match' },
  { id: 'regex', label: '.*', title: 'Regular expression' },
  { id: 'fuzzy', label: '~', title: 'Fuzzy — these characters, in order' },
];

export function SearchOverlay(props: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="k-search">
      <div className="k-search-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
        <input
          ref={ref}
          className="k-search-input"
          value={props.query}
          placeholder="Search this session…"
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose();
            if (e.key === 'Enter') {
              e.preventDefault();
              props.onStep(e.shiftKey ? -1 : 1);
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />

        <div className="k-search-modes">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.title}
              className={'k-search-mode' + (props.mode === m.id ? ' is-on' : '')}
              onClick={() => props.onMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <span className="k-search-count">
          {props.query
            ? props.matchCount
              ? `${props.index + 1}/${props.matchCount}`
              : 'no matches'
            : ''}
        </span>

        <button
          type="button"
          className="k-search-step"
          title="Previous match (⇧⏎)"
          disabled={!props.matchCount}
          onClick={() => props.onStep(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="k-search-step"
          title="Next match (⏎)"
          disabled={!props.matchCount}
          onClick={() => props.onStep(1)}
        >
          ↓
        </button>

        <button
          type="button"
          className="k-search-all"
          title="Search every saved session, not just this one"
          disabled={!props.query.trim() || props.searchingAll}
          onClick={props.onSearchAll}
        >
          {props.searchingAll ? 'searching…' : 'all sessions'}
        </button>

        <button type="button" className="k-search-close" title="Close search" onClick={props.onClose}>
          ×
        </button>
      </div>

      {props.hits.length ? (
        <div className="k-search-hits kscroll">
          {props.hits.map((hit) => (
            <button
              key={`${hit.session_id}:${hit.seq}`}
              type="button"
              className="k-search-hit"
              onClick={() => props.onOpenHit(hit)}
            >
              <span className="k-search-hit-name">{hit.session_name}</span>
              <span className="k-search-hit-snippet">{hit.snippet}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
