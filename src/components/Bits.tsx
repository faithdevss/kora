/** Small shared primitives: accent dot and progress bar. */

interface DotProps {
  color: string;
  size?: number;
}

export function Dot({ color, size = 8 }: DotProps) {
  return (
    <span
      className="k-dot"
      style={{ width: size, height: size, background: color, boxShadow: `0 0 6px ${color}99` }}
    />
  );
}

interface BarProps {
  /** 0–1 fill ratio. */
  pct: number;
  color: string;
  width?: number | string;
}

export function Bar({ pct, color, width = 64 }: BarProps) {
  const w = Math.min(100, Math.max(2, pct * 100));
  return (
    <div className="k-bar" style={{ width }}>
      <div className="k-bar-fill" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}
