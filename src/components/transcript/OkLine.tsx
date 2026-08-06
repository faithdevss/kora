import type { OkLine as OkLineType } from '../../types/agent';
import { Highlight } from '../Highlight';

export function OkLine({ line, query }: { line: OkLineType; query?: string }) {
  return (
    <div className="k-ok">
      <span aria-hidden="true">✓</span>
      <span className="k-ok-text">
        <Highlight text={line.text} query={query} />
      </span>
    </div>
  );
}
