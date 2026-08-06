import type { Agent } from '../../types/agent';

export function ThinkLine({ agent }: { agent: Agent }) {
  return (
    <div className="k-think" role="status">
      <span className="k-spinner" aria-hidden="true" />
      <span className="k-think-text">{agent.name} is working…</span>
    </div>
  );
}
