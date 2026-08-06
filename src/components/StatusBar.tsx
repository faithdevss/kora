import type { Session } from '../types/agent';
import { acctOf, agentOf, modelOf } from '../state/appState';
import { CTX_WARN, compactTarget, ctxTone, fmt } from '../state/format';
import { Bar, Dot } from './Bits';

interface Props {
  session: Session;
  onSuggest: (cmd: string) => void;
}

/**
 * The WEEK meter shows the agent's real reported utilization when it exposes one
 * — Claude Code sends `rate_limit_event` every turn. It falls back to the
 * account's recorded figure only for agents that report nothing. (The master
 * plan's original "weekly quota is not a real number" note was amended after the
 * Phase 2 spike.)
 */
export function StatusBar({ session, onSuggest }: Props) {
  const agent = agentOf(session);
  const acct = acctOf(session);
  const model = modelOf(session);

  const cpct = session.ctxUsed / session.ctxWin;
  const tone = ctxTone(cpct);

  // Only what the agent actually reported. Until a rate_limit_event arrives
  // there is nothing real to show, so it shows nothing — the Phase-1 mock
  // account figures used to sit here and read as live data.
  const live = session.rateLimit;
  const wpct = live ? live.utilization : 0;
  const weekText = live
    ? `${Math.round(live.utilization * 100)}% ${live.window.replace('_', '-')}`
    : '—';
  const weekTitle = live
    ? `Reported by ${agent.name}${live.resetsAt ? ` · resets ${new Date(live.resetsAt * 1000).toLocaleString()}` : ''}`
    : `${agent.name} has not reported quota usage yet`;

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
        <span className={`k-status-state is-${session.status}`} title={`agent ${session.status}`}>
          {session.status === 'busy'
            ? 'working'
            : session.status === 'dead'
              ? 'stopped'
              : session.status === 'starting'
                ? 'starting'
                : session.status === 'offline'
                  ? 'not connected'
                  : 'ready'}
        </span>
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

        <div className="k-status-group" title={weekTitle}>
          <span className="k-status-key">WEEK</span>
          <Bar pct={wpct} color={wpct >= 0.9 ? 'var(--red)' : 'var(--blue)'} width={56} />
          <span className="k-status-week">{weekText}</span>
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
