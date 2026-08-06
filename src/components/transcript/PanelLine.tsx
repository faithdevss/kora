import type { PanelData, PanelLine as PanelLineType } from '../../types/agent';
import { Bar } from '../Bits';
import { CTX_WARN, compactTarget, ctxTone, fmt, fmtWin } from '../../state/format';

interface Props {
  line: PanelLineType;
  onCompact: () => void;
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

function UsageCards({ d, onCompact }: { d: PanelData; onCompact: () => void }) {
  const tone = ctxTone(d.ctxPct);
  const wpct = d.wLim ? d.wUsed / d.wLim : 0;
  return (
    <>
      <Card title="CONTEXT WINDOW" wide>
        <Meter
          label={d.model}
          current={`${fmt(d.ctxUsed)} used`}
          max={fmtWin(d.ctxWin)}
          pct={d.ctxPct}
          color={tone}
        />
        {d.ctxPct >= CTX_WARN ? (
          <button type="button" className="k-card-action" onClick={onCompact}>
            → /compact to reclaim ~{fmt(d.ctxUsed - compactTarget(d.ctxWin))} tokens
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
      <Card title={`TRACKED USAGE · ${d.acctName}`} wide>
        <Meter
          label={d.plan}
          current={`${d.wUsed} ${d.unit}`}
          max={`${d.wLim} ${d.unit}`}
          pct={wpct}
          color={wpct >= 0.9 ? 'var(--red)' : 'var(--blue)'}
        />
        <Row label="plan" value={d.plan} tone="var(--dim)" />
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
      <Card title="COST">
        <Row label="this session" value={`$${d.cost.toFixed(2)}`} tone="var(--green)" />
        <Row
          label="per message"
          value={`$${(d.msgs ? d.cost / d.msgs : 0).toFixed(3)}`}
          tone="var(--dim)"
        />
        <Row label="billed to" value={d.acctName} tone="var(--dim)" />
      </Card>
    </>
  );
}

function CostCards({ d }: { d: PanelData }) {
  return (
    <Card title="COST — THIS SESSION">
      <Row label={`input · ${fmt(d.sessIn)} tok`} value={`$${((d.sessIn / 1e6) * 3).toFixed(2)}`} />
      <Row
        label={`output · ${fmt(d.sessOut)} tok`}
        value={`$${((d.sessOut / 1e6) * 15).toFixed(2)}`}
      />
      <div className="k-card-rule" />
      <Row label="total" value={`$${d.cost.toFixed(2)}`} tone="var(--green)" />
      <Row label="billed to" value={`${d.acctName} · ${d.plan}`} tone="var(--dim)" />
    </Card>
  );
}

const TITLES: Record<PanelLineType['kind'], string> = {
  usage: 'usage',
  stats: 'session statistics',
  cost: 'cost estimate',
};

export function PanelLine({ line, onCompact }: Props) {
  const d = line.data;
  return (
    <div className="k-panel">
      <div className="k-panel-title">{TITLES[line.kind]}</div>
      <div className="k-panel-cards">
        {line.kind === 'usage' ? <UsageCards d={d} onCompact={onCompact} /> : null}
        {line.kind === 'stats' ? <StatsCards d={d} /> : null}
        {line.kind === 'cost' ? <CostCards d={d} /> : null}
      </div>
    </div>
  );
}
