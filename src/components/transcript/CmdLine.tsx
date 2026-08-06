import type { CmdLine as CmdLineType } from '../../types/agent';
import { Highlight } from '../Highlight';

export function CmdLine({ line, query }: { line: CmdLineType; query?: string }) {
  return (
    <div className="k-cmd">
      <span className="k-cmd-caret">❯</span>
      <span className="k-cmd-text">
        <Highlight text={line.text} query={query} />
        {line.atts ? (
          <span className="k-cmd-atts">
            📎 {line.atts} image{line.atts > 1 ? 's' : ''}
          </span>
        ) : null}
      </span>
    </div>
  );
}
