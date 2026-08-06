import type { ReactNode } from 'react';

/** One or two panes side by side, separated by a 1px rule. */
export function SplitView({ children }: { children: ReactNode }) {
  return <div className="k-splitview">{children}</div>;
}
