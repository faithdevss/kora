/**
 * Test double for the Rust process layer.
 *
 * Records what the store asked for and lets a test push agent events back, so
 * the whole Phase 2 flow can be exercised without a Tauri runtime or a real
 * `claude` process.
 */

import type {
  AgentBridge,
  AgentEvent,
  AgentUsage,
  SpawnResult,
} from '../state/agentBridge';
import type { PermissionDecision } from '../types/agent';

export interface FakeBridge extends AgentBridge {
  /** Every prompt sent, in order, as `[sessionId, text]`. */
  readonly writes: [string, string][];
  readonly spawns: string[];
  readonly respawns: string[];
  readonly kills: string[];
  readonly permissions: [string, string, string, PermissionDecision][];
  readonly interrupts: string[];
  /** Push an event as though the agent emitted it. */
  emit(sessionId: string, event: AgentEvent): void;
  /** Agents that report as connected. Defaults to Claude only. */
  connected: Set<string>;
  /** Make the next spawn fail with this message. */
  failNextSpawn: string | null;
  /** Make the next write fail with this message. */
  failNextWrite: string | null;
  /** What `respawn` should return for `agent_uuid`; defaults to echoing the request. */
  resumeReturns: string | null;
}

export function usage(over: Partial<AgentUsage> = {}): AgentUsage {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: null,
    context_window: null,
    ...over,
  };
}

export function makeFakeBridge(): FakeBridge {
  const handlers: ((sessionId: string, event: AgentEvent) => void)[] = [];
  let spawnCount = 0;

  const bridge: FakeBridge = {
    writes: [],
    spawns: [],
    respawns: [],
    kills: [],
    permissions: [],
    interrupts: [],
    connected: new Set(['claude']),
    failNextSpawn: null,
    failNextWrite: null,
    resumeReturns: null,

    emit(sessionId, event) {
      handlers.forEach((h) => h(sessionId, event));
    },

    async spawn({ sessionId }): Promise<SpawnResult> {
      if (bridge.failNextSpawn) {
        const msg = bridge.failNextSpawn;
        bridge.failNextSpawn = null;
        throw new Error(msg);
      }
      bridge.spawns.push(sessionId);
      return {
        agent_uuid: `uuid-${++spawnCount}`,
        workspace: { labels: [] },
        cwd: '/work/api-gateway',
      };
    },

    async respawn({ sessionId, resumeUuid }): Promise<SpawnResult> {
      if (bridge.failNextSpawn) {
        const msg = bridge.failNextSpawn;
        bridge.failNextSpawn = null;
        throw new Error(msg);
      }
      bridge.respawns.push(sessionId);
      return {
        agent_uuid: bridge.resumeReturns ?? resumeUuid ?? `uuid-${++spawnCount}`,
        workspace: { labels: [] },
        cwd: '/work/api-gateway',
      };
    },

    async write(sessionId, prompt) {
      if (bridge.failNextWrite) {
        const msg = bridge.failNextWrite;
        bridge.failNextWrite = null;
        throw new Error(msg);
      }
      bridge.writes.push([sessionId, prompt]);
    },

    async answerPermission(sessionId, tool, requestId, decision) {
      bridge.permissions.push([sessionId, tool, requestId, decision]);
      return decision !== 'deny';
    },

    async interrupt(sessionId) {
      bridge.interrupts.push(sessionId);
      return true;
    },

    async kill(sessionId) {
      bridge.kills.push(sessionId);
    },

    async isConnected(agentId) {
      return bridge.connected.has(agentId);
    },

    async workspaceDir() {
      return '/work/api-gateway';
    },

    async subscribe(handler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };

  return bridge;
}
