import type { HelpEntry, HelpLine as HelpLineType } from '../../types/agent';

interface Props {
  line: HelpLineType;
  /** Fills the command input with this command (and refocuses it). */
  onPickCmd: (cmd: string) => void;
}

function HelpRow({ entry, onPickCmd }: { entry: HelpEntry; onPickCmd: (c: string) => void }) {
  return (
    <button type="button" className="k-help-row" onClick={() => onPickCmd(entry.c)}>
      <span className="k-help-cmd">{entry.c}</span>
      <span className="k-help-desc">{entry.d}</span>
    </button>
  );
}

export function HelpLine({ line, onPickCmd }: Props) {
  return (
    <div className="k-help">
      <div className="k-help-title">Commands — universal, plus what {line.agent} adds</div>
      <div className="k-help-grid">
        {line.common.map((e) => (
          <HelpRow key={e.c} entry={e} onPickCmd={onPickCmd} />
        ))}
      </div>
      {line.extra.length ? (
        <>
          <div className="k-help-section">{line.agent.toUpperCase()} COMMANDS</div>
          <div className="k-help-grid">
            {line.extra.map((e) => (
              <HelpRow key={e.c} entry={e} onPickCmd={onPickCmd} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
