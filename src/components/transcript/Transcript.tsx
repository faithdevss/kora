/**
 * Renders a session's transcript, one component per line type.
 *
 * Assistant prose goes through the markdown renderer (Phase 5); everything else
 * is React children, so only that one path ever mounts HTML — and only after
 * sanitizing (see `state/markdown.ts`).
 */

import { useEffect, useRef } from 'react';
import type {
  Agent,
  ListKind,
  PermissionDecision,
  Session,
  TranscriptLine,
} from '../../types/agent';
import { BannerLine } from './BannerLine';
import { CmdLine } from './CmdLine';
import { DimLine } from './DimLine';
import { ErrLine } from './ErrLine';
import { HelpLine } from './HelpLine';
import { ListLine } from './ListLine';
import { OkLine } from './OkLine';
import { OutLine } from './OutLine';
import { PanelLine } from './PanelLine';
import { PermLine } from './PermLine';
import { RespLine } from './RespLine';
import type { CodeActions } from './CodeBlock';
import { ThinkLine } from './ThinkLine';
import { WarnLine } from './WarnLine';

export interface TranscriptActions {
  runQuick: (cmd: string) => void;
  pickItem: (kind: ListKind, id: string) => void;
  fillInput: (cmd: string) => void;
  answerPermission: (requestId: string, decision: PermissionDecision) => void;
  /** What the buttons on a code block do. */
  code: CodeActions;
}

interface Props {
  session: Session;
  agent: Agent;
  query?: string;
  /** Line holding the current search match, scrolled into view. */
  activeMatchKey?: string;
  actions: TranscriptActions;
}

function Line({
  line,
  agent,
  session,
  query,
  actions,
}: {
  line: TranscriptLine;
  agent: Agent;
  session: Session;
  query?: string;
  actions: TranscriptActions;
}) {
  switch (line.t) {
    case 'banner':
      return <BannerLine agent={agent} workspace={session.workspace} status={session.status} />;
    case 'cmd':
      return <CmdLine line={line} query={query} />;
    case 'resp':
      return <RespLine line={line} agent={agent} query={query} actions={actions.code} />;
    case 'out':
      return <OutLine line={line} query={query} />;
    case 'dim':
      return <DimLine line={line} query={query} />;
    case 'ok':
      return <OkLine line={line} query={query} />;
    case 'err':
      return <ErrLine line={line} query={query} onHint={actions.runQuick} />;
    case 'think':
      return <ThinkLine agent={agent} />;
    case 'warn':
      return <WarnLine line={line} query={query} onChip={actions.runQuick} />;
    case 'list':
      return <ListLine line={line} onPick={actions.pickItem} />;
    case 'help':
      return <HelpLine line={line} onPickCmd={actions.fillInput} />;
    case 'panel':
      return <PanelLine line={line} onRun={actions.runQuick} />;
    case 'perm':
      return <PermLine line={line} onAnswer={actions.answerPermission} />;
  }
}

export function Transcript({ session, agent, query, activeMatchKey, actions }: Props) {
  const active = useRef<HTMLDivElement>(null);

  // Stepping through search results scrolls the match into view, which is what
  // makes a hit on a line twenty screens up reachable at all.
  useEffect(() => {
    const el = active.current;
    // Guarded because jsdom has no layout, and so no scrollIntoView.
    if (activeMatchKey && typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' });
    }
  }, [activeMatchKey]);

  return (
    <div className="k-transcript">
      {session.lines.map((line) => {
        const isActive = line.key === activeMatchKey;
        return (
          <div
            key={line.key}
            ref={isActive ? active : undefined}
            className={'k-line' + (isActive ? ' is-hit' : '')}
          >
            <Line line={line} agent={agent} session={session} query={query} actions={actions} />
          </div>
        );
      })}
    </div>
  );
}
