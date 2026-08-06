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
          {line.streaming ? <span className="k-caret" aria-hidden="true" /> : null}
        </span>
      </div>
      {line.block ? <CodeBlock block={line.block} lang={line.lang} /> : null}
      {(line.tools ?? (line.tool ? [line.tool] : [])).map((tool, i) => (
        <div className="k-resp-tool" key={i}>
          <span className="k-resp-tool-dot" />
          <span>{tool}</span>
        </div>
      ))}
    </div>
  );
}
