import type { DimLine as DimLineType } from '../../types/agent';
import { Highlight } from '../Highlight';

export function DimLine({ line, query }: { line: DimLineType; query?: string }) {
  return (
    <div className="k-dimline">
      <Highlight text={line.text} query={query} />
    </div>
  );
}
