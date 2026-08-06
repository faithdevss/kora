/** `/`-prefixed autocomplete above the input. Up to 6 matches, click or Tab. */

import { CMD_DESC } from '../state/mockFixtures';

interface Props {
  matches: string[];
  onPick: (cmd: string) => void;
}

export const PALETTE_LIMIT = 6;

/** Commands from `avail` that complete the current input, capped at 6. */
export function paletteMatches(input: string, avail: string[]): string[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  return avail.filter((c) => c.startsWith(input.toLowerCase())).slice(0, PALETTE_LIMIT);
}

export function CommandPalette({ matches, onPick }: Props) {
  if (!matches.length) return null;
  return (
    <div className="k-palette" role="listbox">
      {matches.map((c, i) => (
        <button
          type="button"
          key={c}
          role="option"
          aria-selected={i === 0}
          className={'k-palette-item' + (i === 0 ? ' is-first' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
        >
          <span className="k-palette-cmd">{c}</span>
          <span className="k-palette-desc">{CMD_DESC[c] ?? ''}</span>
        </button>
      ))}
    </div>
  );
}
