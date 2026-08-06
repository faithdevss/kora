import type { OutLine as OutLineType } from '../../types/agent';
import { Highlight } from '../Highlight';

export function OutLine({ line, query }: { line: OutLineType; query?: string }) {
  return (
    <pre className="k-out">
      <Highlight text={line.text} query={query} />
    </pre>
  );
}
