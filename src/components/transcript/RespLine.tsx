import type { Agent, RespLine as RespLineType } from '../../types/agent';
import { Highlight } from '../Highlight';
import { CodeBlock } from './CodeBlock';

interface Props {
  line: RespLineType;
  agent: Agent;
  query?: string;
}

export function RespLine({ line, agent, query }: Props) {
  return (
    <div className="k-resp">
      <div className="k-resp-head">
        <span className="k-resp-avatar">{agent.name[0]}</span>
        <span className="k-resp-text">
          <Highlight text={line.text} query={query} />
        </span>
      </div>
      {line.block ? <CodeBlock block={line.block} lang={line.lang} /> : null}
      {line.tool ? (
        <div className="k-resp-tool">
          <span className="k-resp-tool-dot" />
          <span>{line.tool}</span>
        </div>
      ) : null}
    </div>
  );
}
