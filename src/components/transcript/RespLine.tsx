import type { Agent, RespLine as RespLineType } from '../../types/agent';
import { Highlight } from '../Highlight';
import { CodeBlock, type CodeActions } from './CodeBlock';
import { Markdown } from './Markdown';

interface Props {
  line: RespLineType;
  agent: Agent;
  query?: string;
  actions?: CodeActions;
}

export function RespLine({ line, agent, query, actions }: Props) {
  return (
    <div className="k-resp">
      <div className="k-resp-head">
        <span className="k-resp-avatar">{agent.name[0]}</span>
        <span className="k-resp-text">
          {/* While tokens are still arriving the text is rendered raw: a half
              written fence or table would otherwise flicker through every
              intermediate parse. It becomes markdown once the turn settles. */}
          {line.streaming ? (
            <>
              <Highlight text={line.text} query={query} />
              <span className="k-caret" aria-hidden="true" />
            </>
          ) : (
            <Markdown text={line.text} query={query} />
          )}
        </span>
      </div>
      {line.block ? (
        <CodeBlock block={line.block} lang={line.lang} path={line.path} actions={actions} />
      ) : null}
      {(line.tools ?? (line.tool ? [line.tool] : [])).map((tool, i) => (
        <div className="k-resp-tool" key={i}>
          <span className="k-resp-tool-dot" />
          <span>{tool}</span>
        </div>
      ))}
    </div>
  );
}
