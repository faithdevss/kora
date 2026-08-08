/**
 * Renders a session's transcript. One component per line type — the same set
 * Phase 2's real agent output and Phase 5's rich markdown will feed into.
 */

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
import { ThinkLine } from './ThinkLine';
import { WarnLine } from './WarnLine';

export interface TranscriptActions {
  runQuick: (cmd: string) => void;
  pickItem: (kind: ListKind, id: string) => void;
  fillInput: (cmd: string) => void;
  answerPermission: (requestId: string, decision: PermissionDecision) => void;
}

interface Props {
  session: Session;
  agent: Agent;
  query?: string;
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
      return <RespLine line={line} agent={agent} query={query} />;
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

export function Transcript({ session, agent, query, actions }: Props) {
  return (
    <div className="k-transcript">
      {session.lines.map((line) => (
        <div key={line.key} className="k-line">
          <Line line={line} agent={agent} session={session} query={query} actions={actions} />
        </div>
      ))}
    </div>
  );
}
