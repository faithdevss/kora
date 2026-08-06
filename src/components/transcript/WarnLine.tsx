import type { WarnLine as WarnLineType } from '../../types/agent';
import { Highlight } from '../Highlight';

interface Props {
  line: WarnLineType;
  query?: string;
  onChip: (cmd: string) => void;
}

export function WarnLine({ line, query, onChip }: Props) {
  return (
    <div className="k-warn">
      <div className="k-warn-row">
        <span aria-hidden="true">⚠</span>
        <span className="k-warn-text">
          <Highlight text={line.text} query={query} />
        </span>
      </div>
      <div className="k-warn-chips">
        {line.chips.map((c) => (
          <button type="button" key={c.cmd} className="k-chip" onClick={() => onChip(c.cmd)}>
            {c.label}
          </button>
        ))}
        <span className="k-warn-note">kora optimises tokens automatically</span>
      </div>
    </div>
  );
}
