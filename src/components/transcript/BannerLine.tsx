import type { Agent } from '../../types/agent';

export function BannerLine({ agent }: { agent: Agent }) {
  return (
    <div className="k-banner">
      <div className="k-banner-head">
        <span className="k-banner-mark">k</span>
        <span className="k-banner-name">kora</span>
        <span className="k-banner-tag">· one terminal, every agent</span>
      </div>
      <div className="k-banner-sub">
        Connected to <span className="k-ac">{agent.name}</span> — type{' '}
        <span className="k-ac">/help</span> for commands, <span className="k-ac">/agents</span> to
        switch agent, <span className="k-ac">/users</span> to switch account.
      </div>
    </div>
  );
}
