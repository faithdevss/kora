import type { ErrLine as ErrLineType } from '../../types/agent';
import { Highlight } from '../Highlight';

interface Props {
  line: ErrLineType;
  query?: string;
  onHint: (cmd: string) => void;
}

export function ErrLine({ line, query, onHint }: Props) {
  return (
    <div className="k-err">
      <div className="k-err-row">
        <span aria-hidden="true">✗</span>
        <span className="k-err-text">
          <Highlight text={line.text} query={query} />
        </span>
      </div>
      {line.hint ? (
        <div className="k-err-hint">
          did you mean{' '}
          <button type="button" className="k-linkbtn" onClick={() => onHint(line.hint!)}>
            {line.hint}
          </button>
          ?
        </div>
      ) : null}
      {line.action ? (
        <div className="k-err-action">
          <button type="button" className="k-chip" onClick={() => onHint(line.action!.cmd)}>
            {line.action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
