import type { Session } from '../types/agent';
import { acctOf, agentOf, modelOf } from '../state/appState';
import { CTX_WARN, compactTarget, ctxTone, fmt } from '../state/format';
import { Bar, Dot } from './Bits';

interface Props {
  session: Session;
  onSuggest: (cmd: string) => void;
}

/**
 * The WEEK meter shows Kora's own locally-tracked rolling usage, not authoritative
 * plan quota — see master plan, "Weekly quota is not a real number".
 */
export function StatusBar({ session, onSuggest }: Props) {
  const agent = agentOf(session);
  const acct = acctOf(session);
  const model = modelOf(session);

  const cpct = session.ctxUsed / session.ctxWin;
  const tone = ctxTone(cpct);
  const wpct = acct?.wLim ? acct.wUsed / acct.wLim : 0;

  const suggestion =
    cpct >= CTX_WARN
      ? `/compact to free ~${fmt(session.ctxUsed - compactTarget(session.ctxWin))} tokens`
      : wpct >= 0.9
        ? 'weekly limit near — switch account'
        : '';

  return (
    <div className="k-statusbar">
      <div className="k-status-left">
        <Dot color={agent.accent} size={8} />
        <span className="k-status-agent">{agent.name}</span>
        <span className="k-status-account">{acct?.name ?? '—'}</span>
        <span className="k-status-sep">·</span>
        <span className="k-status-model">{model.name}</span>
      </div>

      <div className="k-status-right">
        <div className="k-status-group">
          <span className="k-status-key">CONTEXT</span>
          <Bar pct={cpct} color={tone} width={74} />
          <span className="k-status-pct" style={{ color: tone }}>
            {Math.round(cpct * 100)}%
          </span>
        </div>

        <div className="k-status-group">
          <span className="k-status-key">SESSION</span>
          <span className="k-tok-in">↑{fmt(session.sessIn)}</span>
          <span className="k-tok-out">↓{fmt(session.sessOut)}</span>
        </div>

        <div className="k-status-group" title="Usage Kora recorded locally — not plan quota">
          <span className="k-status-key">WEEK</span>
          <Bar pct={wpct} color={wpct >= 0.9 ? 'var(--red)' : 'var(--blue)'} width={56} />
          <span className="k-status-week">
            {acct ? `${acct.wUsed}/${acct.wLim} ${acct.unit}` : '—'}
          </span>
        </div>

        {suggestion ? (
          <button
            type="button"
            className="k-suggest"
            onClick={() => onSuggest(suggestion.startsWith('/compact') ? '/compact' : '/accounts')}
          >
            ◆ {suggestion}
          </button>
        ) : null}
      </div>
    </div>
  );
}
