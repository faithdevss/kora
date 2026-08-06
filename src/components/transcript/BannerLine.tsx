import type { Agent, SessionStatus, WorkspaceInfo } from '../../types/agent';

interface Props {
  agent: Agent;
  /** Config the wrapped CLI inherited from the workspace, once known. */
  workspace?: WorkspaceInfo;
  status?: SessionStatus;
}

/**
 * "Using project CLAUDE.md, 2 MCP servers" — or nothing when the workspace has
 * none. The file labels come from the adapter, so a different agent's config
 * files describe themselves without this component knowing about them.
 */
function configNote(w?: WorkspaceInfo): string | null {
  if (!w) return null;
  const parts = [...w.labels];
  if (w.mcpServers > 0) {
    parts.push(`${w.mcpServers} MCP server${w.mcpServers === 1 ? '' : 's'}`);
  }
  return parts.length ? `Using ${parts.join(', ')}.` : null;
}

export function BannerLine({ agent, workspace, status }: Props) {
  const note = configNote(workspace);

  return (
    <div className="k-banner">
      <div className="k-banner-head">
        <span className="k-banner-mark">k</span>
        <span className="k-banner-name">kora</span>
        <span className="k-banner-tag">· one terminal, every agent</span>
      </div>
      <div className="k-banner-sub">
        {status === 'starting' ? 'Starting ' : 'Connected to '}
        <span className="k-ac">{agent.name}</span> — type <span className="k-ac">/help</span> for
        commands, <span className="k-ac">/agents</span> to switch agent,{' '}
        <span className="k-ac">/users</span> to switch account.
      </div>
      {note ? <div className="k-banner-note">{note}</div> : null}
    </div>
  );
}
