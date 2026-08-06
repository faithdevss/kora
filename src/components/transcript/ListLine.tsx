import type { ListKind, ListLine as ListLineType } from '../../types/agent';
import { Dot } from '../Bits';

interface Props {
  line: ListLineType;
  onPick: (kind: ListKind, id: string) => void;
}

export function ListLine({ line, onPick }: Props) {
  return (
    <div className="k-list">
      <div className="k-list-title">{line.title}</div>
      {line.items.map((it) => (
        <button
          type="button"
          key={it.id}
          className={'k-list-item' + (it.active ? ' is-active' : '')}
          onClick={() => onPick(line.kind, it.id)}
        >
          {it.dot ? (
            <Dot color={it.dot} size={9} />
          ) : (
            <span className={'k-list-pip' + (it.active ? ' is-active' : '')} />
          )}
          <span className="k-list-body">
            <span className="k-list-label">
              {it.label}
              {it.active ? <span className="k-list-active">● active</span> : null}
            </span>
            <span className="k-list-sub">{it.sub}</span>
          </span>
          {it.right ? <span className="k-list-right">{it.right}</span> : null}
          <span className="k-list-arrow" aria-hidden="true">
            →
          </span>
        </button>
      ))}
    </div>
  );
}
