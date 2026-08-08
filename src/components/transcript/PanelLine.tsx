import type { PanelData, PanelLine as PanelLineType } from '../../types/agent';
import { Bar } from '../Bits';
import { CTX_WARN, ctxTone, fmt, fmtWin } from '../../state/format';
import { totalTokens } from '../../state/accounts';

interface Props {
  line: PanelLineType;
  /** Runs a command on the session this panel belongs to. */
  onRun: (cmd: string) => void;
}

function Card({
  title,
  children,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  /** Meter-bearing cards use the mockup's slightly looser 9px row gap. */
  wide?: boolean;
}) {
  return (
    <div className="k-card">
      <div className="k-card-title">{title}</div>
      <div className={'k-card-body' + (wide ? ' is-wide' : '')}>{children}</div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="k-row">
      <span className="k-row-label">{label}</span>
      <span className="k-row-value" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

function Meter({
  label,
  current,
  max,
  pct,
  color,
}: {
  label: string;
  current: string;
  max?: string;
  pct: number;
  color: string;
}) {
  return (
    <div className="k-meter">
      <div className="k-meter-head">
        <span className="k-meter-label">{label}</span>
        <span className="k-meter-pct" style={{ color }}>
          {Math.round(pct * 100)}%
        </span>
      </div>
      <Bar pct={pct} color={color} width="100%" />
      <div className="k-meter-foot">{max ? `${current} / ${max}` : current}</div>
    </div>
  );
}

/** Money, or "—" when the agent did not report any. */
function money(v: number | null, digits = 2): string {
  return v === null ? '—' : `$${v.toFixed(digits)}`;
}

/**
 * The seven-day figure: what the agent reported spending, or failing that what
 * these tokens list at. Both are only as real as the account they belong to —
 * `costEstimated` is what decides how the card labels them.
 */
function weekCost(d: PanelData): number | null {
  return d.week?.cost_usd ?? d.week?.estimated_cost_usd ?? null;
}

/**
 * Suggestions, shown quietly.
 *
 * Every one of these fired on a measured condition, and every action is a real
 * command — the agent's `/compact` and `/clear`, or a Kora tab. Nothing here
 * rewrites the conversation (`docs/features.gpt.md` §9, "never intrusive").
 */
function TipsCard({ d, onRun }: { d: PanelData; onRun: (cmd: string) => void }) {
  if (!d.tips.length) return null;
  return (
    <Card title="SUGGESTIONS" wide>
      {d.tips.map((tip) => (
        <div key={tip.id} className="k-tip">
          <div className={'k-tip-text is-' + tip.tone}>{tip.text}</div>
          {tip.chips.length ? (
            <div className="k-tip-chips">
              {tip.chips.map((c) => (
                <button
                  key={c.cmd}
                  type="button"
                  className="k-card-action"
                  onClick={() => onRun(c.cmd)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </Card>
  );
}

function UsageCards({ d, onRun }: { d: PanelData; onRun: (cmd: string) => void }) {
  const onCompact = () => onRun('/compact');
  const tone = ctxTone(d.ctxPct);
  return (
    <>
      <Card title="CONTEXT WINDOW" wide>
        <Meter
          label={d.model}
          // Marked approximate between a compaction and the next turn, when
          // the agent has dropped context it has not yet re-counted.
          current={`${d.ctxStale ? '≈' : ''}${fmt(d.ctxUsed)} used`}
          max={fmtWin(d.ctxWin)}
          pct={d.ctxPct}
          color={tone}
        />
        {d.ctxStale ? (
          <div className="k-card-healthy">measured before the last compaction — updates next turn</div>
        ) : d.ctxPct >= CTX_WARN ? (
          <button type="button" className="k-card-action" onClick={onCompact}>
            → /compact — the agent decides what to summarize
          </button>
        ) : (
          <div className="k-card-healthy">✓ healthy — plenty of headroom</div>
        )}
      </Card>
      <Card title="THIS SESSION">
        <Row label="input ↑" value={`${fmt(d.sessIn)} tok`} tone="var(--green)" />
        <Row label="output ↓" value={`${fmt(d.sessOut)} tok`} tone="var(--blue)" />
        <Row label="cache read" value={`${fmt(d.cacheRead)} tok`} tone="var(--dim)" />
        <Row label="messages" value={d.msgs} />
      </Card>
      <Card title={`QUOTA · ${d.acctName}`} wide>
        {d.utilization === null ? (
          <div className="k-card-healthy">this agent reports no quota</div>
        ) : (
          <Meter
            label={(d.window ?? '').replace('_', '-')}
            current={`${Math.round(d.utilization * 100)}% used`}
            pct={d.utilization}
            color={d.utilization >= 0.9 ? 'var(--red)' : 'var(--blue)'}
          />
        )}
        <Row label="plan" value={d.plan} tone="var(--dim)" />
        {/* Kora's own record, kept separate from the agent's quota above so the
            two are never read as one number. */}
        <Row
          label="tracked by Kora · 7d"
          value={d.week ? `${fmt(totalTokens(d.week))} tok` : '—'}
          tone="var(--dim)"
        />
        <Row
          label="tracked turns · 7d"
          value={d.week ? d.week.turns : '—'}
          tone="var(--dim)"
        />
      </Card>
    </>
  );
}

function StatsCards({ d }: { d: PanelData }) {
  return (
    <>
      <Card title="THROUGHPUT">
        <Row label="messages" value={d.msgs} />
        <Row label="avg input" value={`${fmt(d.avgIn ?? 0)} tok`} tone="var(--green)" />
        <Row label="avg output" value={`${fmt(d.avgOut ?? 0)} tok`} tone="var(--blue)" />
      </Card>
      <Card title="EFFICIENCY">
        <Row label="cache reads" value={`${fmt(d.cacheRead)} tok`} tone="var(--dim)" />
        <Row label="context fill" value={`${Math.round(d.ctxPct * 100)}%`} tone={ctxTone(d.ctxPct)} />
        <Row label="total tokens" value={fmt(d.sessIn + d.sessOut)} />
      </Card>
      {/* On a subscription the plan is a flat fee, so a per-token figure is an
          API-equivalent estimate and never what the user actually pays. The
          card title carries that, not a footnote. */}
      <Card title={d.costEstimated ? 'COST · API-EQUIVALENT ESTIMATE' : 'COST'}>
        <Row label="this session" value={money(d.cost)} tone="var(--green)" />
        <Row
          label="per message"
          value={d.cost !== null && d.msgs ? money(d.cost / d.msgs, 3) : '—'}
          tone="var(--dim)"
        />
        <Row label="tracked · 7d" value={money(weekCost(d))} tone="var(--dim)" />
        <Row
          label={d.costEstimated ? 'not billed — flat plan' : 'billed to'}
          value={d.acctName}
          tone="var(--dim)"
        />
      </Card>
    </>
  );
}

const TITLES: Record<PanelLineType['kind'], string> = {
  usage: 'usage',
  stats: 'session statistics',
};

export function PanelLine({ line, onRun }: Props) {
  const d = line.data;
  return (
    <div className="k-panel">
      <div className="k-panel-title">{TITLES[line.kind]}</div>
      <div className="k-panel-cards">
        {line.kind === 'usage' ? <UsageCards d={d} onRun={onRun} /> : null}
        {line.kind === 'stats' ? <StatsCards d={d} /> : null}
        <TipsCard d={d} onRun={onRun} />
      </div>
    </div>
  );
}
