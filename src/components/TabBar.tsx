import type { Session } from '../types/agent';
import { acctOf, agentOf } from '../state/appState';
import { Dot } from './Bits';

interface Props {
  sessions: Session[];
  focusedId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

export function TabBar({ sessions, focusedId, onSelect, onClose, onNewTab }: Props) {
  return (
    <div className="k-tabbar">
      <div className="k-tabs kscroll">
        {sessions.map((s) => {
          const active = s.id === focusedId;
          return (
            <div
              key={s.id}
              className={'k-tab' + (active ? ' is-active' : '')}
              onClick={() => onSelect(s.id)}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(s.id);
              }}
            >
              <Dot color={agentOf(s).accent} size={7} />
              <span className="k-tab-name">
                {s.name} · {acctOf(s)?.name ?? '—'}
              </span>
              <span
                className="k-tab-close"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>
      <button type="button" className="k-tab-new" title="New session" onClick={onNewTab}>
        +
      </button>
    </div>
  );
}
