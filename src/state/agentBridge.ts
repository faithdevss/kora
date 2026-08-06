/**
 * The frontend's entire view of the Rust process layer.
 *
 * Nothing else in `src/` calls `invoke` or `listen`. That keeps the Tauri
 * surface auditable in one file and lets tests substitute a fake bridge without
 * a Tauri runtime — see `sessionStore.test.ts`.
 */

import type { PermissionDecision, PermissionScope } from '../types/agent';

/** Mirrors `AgentEvent` in `src-tauri/src/adapters/mod.rs`. */
export type AgentEvent =
  | {
      kind: 'ready';
      agent_session_id: string | null;
      model: string | null;
      /** `null` when this event did not carry the count. */
      mcp_servers: number | null;
      commands: { name: string; description: string }[];
    }
  | { kind: 'delta'; text: string }
  | { kind: 'message_done' }
  | { kind: 'tool'; name: string; detail: string }
  | {
      kind: 'permission';
      request_id: string;
      tool: string;
      detail: string;
      scope: PermissionScope;
    }
  | { kind: 'turn_end'; text: string; usage: AgentUsage | null; is_error: boolean }
  | { kind: 'rate_limit'; window: string; utilization: number; resets_at: number | null }
  | { kind: 'compacted' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'exited'; code: number | null; recoverable: boolean };

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number | null;
  context_window: number | null;
}

export interface SessionEvent extends Record<string, unknown> {
  session_id: string;
}

export interface WorkspaceConfig {
  /** Labels for the agent's own config files found in the workspace. */
  labels: string[];
}

export interface SpawnResult {
  agent_uuid: string;
  workspace: WorkspaceConfig;
  cwd: string;
}

/** Everything the store is allowed to ask of the backend. */
export interface AgentBridge {
  spawn(input: {
    sessionId: string;
    agentId: string;
    cwd: string;
    model?: string;
  }): Promise<SpawnResult>;
  respawn(input: {
    sessionId: string;
    agentId: string;
    cwd: string;
    model?: string;
    resumeUuid?: string;
  }): Promise<SpawnResult>;
  write(sessionId: string, prompt: string): Promise<void>;
  answerPermission(
    sessionId: string,
    tool: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<boolean>;
  interrupt(sessionId: string): Promise<boolean>;
  kill(sessionId: string): Promise<void>;
  isConnected(agentId: string): Promise<boolean>;
  workspaceDir(): Promise<string>;
  /** Subscribes to agent events. Returns an unsubscribe function. */
  subscribe(handler: (sessionId: string, event: AgentEvent) => void): Promise<() => void>;
}

/** True when running inside the Tauri shell rather than a plain browser/test. */
export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The real bridge. Imports `@tauri-apps/api` lazily so that importing this
 * module in a browser or under vitest does not blow up.
 */
export const tauriBridge: AgentBridge = {
  async spawn({ sessionId, agentId, cwd, model }) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SpawnResult>('agent_spawn', { sessionId, agentId, cwd, model });
  },

  async respawn({ sessionId, agentId, cwd, model, resumeUuid }) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SpawnResult>('agent_respawn', {
      sessionId,
      agentId,
      cwd,
      model,
      resumeUuid,
    });
  },

  async write(sessionId, prompt) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_write', { sessionId, prompt });
  },

  async answerPermission(sessionId, tool, requestId, decision) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('agent_permission', { sessionId, tool, requestId, decision });
  },

  async interrupt(sessionId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('agent_interrupt', { sessionId });
  },

  async kill(sessionId) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_kill', { sessionId });
  },

  async isConnected(agentId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('agent_is_connected', { agentId });
  },

  async workspaceDir() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('workspace_dir');
  },

  async subscribe(handler) {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<SessionEvent>('agent://event', ({ payload }) => {
      const { session_id, ...event } = payload;
      handler(session_id, event as unknown as AgentEvent);
    });
    return unlisten;
  },
};

/**
 * Stand-in used when Kora runs outside Tauri (browser preview, tests).
 * Every call fails loudly rather than pretending an agent is running.
 */
export const offlineBridge: AgentBridge = {
  spawn: async () => {
    throw new Error('Agent processes need the Kora desktop app — this is a browser preview.');
  },
  respawn: async () => {
    throw new Error('Agent processes need the Kora desktop app — this is a browser preview.');
  },
  write: async () => {
    throw new Error('No agent process is attached to this session.');
  },
  answerPermission: async () => false,
  interrupt: async () => false,
  kill: async () => {},
  isConnected: async () => false,
  workspaceDir: async () => '~',
  subscribe: async () => () => {},
};

export function defaultBridge(): AgentBridge {
  return hasTauri() ? tauriBridge : offlineBridge;
}
