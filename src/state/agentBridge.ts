/**
 * The frontend's entire view of the Rust process layer.
 *
 * Nothing else in `src/` calls `invoke` or `listen`. That keeps the Tauri
 * surface auditable in one file and lets tests substitute a fake bridge without
 * a Tauri runtime — see `sessionStore.test.ts`.
 */

import type {
  Account,
  AccountIdentity,
  PermissionDecision,
  PermissionScope,
  Settings,
  UsageTotals,
} from '../types/agent';

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
  | { kind: 'tool'; name: string; detail: string; path: string | null }
  | {
      kind: 'permission';
      request_id: string;
      tool: string;
      detail: string;
      scope: PermissionScope;
    }
  | { kind: 'turn_end'; text: string; usage: AgentUsage | null; is_error: boolean }
  | { kind: 'models'; models: AgentModel[] }
  | { kind: 'rate_limit'; window: string; utilization: number; resets_at: number | null }
  | { kind: 'compacted'; pre_tokens: number | null; trigger: string | null }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'exited'; code: number | null; recoverable: boolean };

/** Mirrors `ModelInfo` in `src-tauri/src/adapters/mod.rs`. */
export interface AgentModel {
  id: string;
  display_name: string;
  description: string;
  resolved: string | null;
}

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
  /** The account the process was spawned under, if one is configured. */
  account: Account | null;
}

/** Mirrors `Capability` in `src-tauri/src/adapters/mod.rs`. */
export type Capability =
  | 'streaming'
  | 'usage'
  | 'cost'
  | 'permission_prompts'
  | 'interrupt'
  | 'resume'
  | 'vision';

/** Mirrors `IngestedFile` in `src-tauri/src/files/ingest.rs`. */
export interface IngestedFile {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  size: number;
  media_type: string;
  text: string | null;
  data: string | null;
  truncated: boolean;
  note: string | null;
}

/**
 * An attachment in the shape `agent_write` expects — the serde tagging of
 * `Attachment` in `src-tauri/src/adapters/mod.rs`.
 */
export type WireAttachment =
  | { kind: 'text'; name: string; path: string; text: string; truncated: boolean }
  | { kind: 'image'; name: string; media_type: string; data: string };

/** Mirrors `VersionInfo` in `src-tauri/src/commands.rs`. */
export interface VersionInfo {
  version: string;
  platform: string;
  releases_url: string;
  /** False in v1: Kora points at releases rather than updating itself. */
  self_update: boolean;
}

/** Mirrors `SearchHit` in `src-tauri/src/store/sessions.rs`. */
export interface SearchHit {
  session_id: string;
  session_name: string;
  agent_id: string;
  seq: number;
  snippet: string;
  updated_at: number;
}

/** Mirrors `SessionMeta` in `src-tauri/src/store/sessions.rs`. */
export interface SessionMeta {
  id: string;
  name: string;
  agent_id: string;
  account_id: string | null;
  model_id: string | null;
  cwd: string | null;
  agent_uuid: string | null;
  pinned: boolean;
  archived: boolean;
  created_at: number;
  updated_at: number;
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
  write(sessionId: string, prompt: string, attachments?: WireAttachment[]): Promise<void>;
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

  /* ---- accounts (Phase 3) ---- */

  accountsList(agentId: string): Promise<Account[]>;
  accountsActive(agentId: string): Promise<Account | null>;
  accountsAdd(agentId: string, name: string): Promise<Account>;
  accountsRename(accountId: string, name: string): Promise<void>;
  accountsRemove(accountId: string): Promise<void>;
  accountsSwitch(agentId: string, accountId: string): Promise<void>;
  /** Asks the agent who is signed in, and records the answer. */
  accountsRefresh(accountId: string): Promise<AccountIdentity | null>;
  /** The command the user runs to sign an account in; login is interactive. */
  accountsLoginCommand(accountId: string): Promise<string>;

  /* ---- sessions (Phase 3) ---- */

  sessionsList(includeArchived: boolean): Promise<SessionMeta[]>;
  sessionsSave(meta: SessionMeta, lines: unknown[]): Promise<void>;
  sessionsLines(sessionId: string): Promise<unknown[]>;
  sessionsDelete(sessionId: string): Promise<void>;
  sessionsRename(sessionId: string, name: string): Promise<void>;
  sessionsSetFlags(
    sessionId: string,
    flags: { pinned?: boolean; archived?: boolean },
  ): Promise<void>;
  sessionsExport(sessionId: string): Promise<string>;
  /** Writes an export to `path` (or Kora's exports dir) and returns the file. */
  sessionsExportFile(sessionId: string, path?: string): Promise<string>;
  sessionsImport(json: string): Promise<SessionMeta>;
  sessionsImportFile(path: string): Promise<SessionMeta>;

  /* ---- usage (Phase 3) ---- */

  /* ---- files, search, capabilities (Phase 5) ---- */

  /** Read a file from disk under the backend's size/binary policy. */
  fileIngest(path: string): Promise<IngestedFile>;
  /** Same policy, for bytes that never had a path (paste, file picker). */
  fileIngestBytes(name: string, dataBase64: string, mediaType?: string): Promise<IngestedFile>;
  fileSave(path: string, contents: string): Promise<string>;
  fileOpenInEditor(path: string): Promise<string>;
  agentCapabilities(agentId: string): Promise<Capability[]>;
  /** Search every saved transcript. In-session search never leaves the UI. */
  sessionsSearch(query: string, limit?: number): Promise<SearchHit[]>;

  /* ---- settings & version (Phase 6) ---- */

  settingsGet(): Promise<Settings>;
  /** Returns what was stored, which may differ from what was asked for. */
  settingsSet(value: Settings): Promise<Settings>;
  versionInfo(): Promise<VersionInfo>;

  usageWeek(accountId: string | null): Promise<UsageTotals>;
  usageRecord(input: {
    agentId: string;
    accountId: string | null;
    model: string | null;
    usage: AgentUsage;
  }): Promise<boolean>;
}

/** True when running inside the Tauri shell rather than a plain browser/test. */
export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** One Tauri command call. Imports the API lazily, like everything here. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
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

  async write(sessionId, prompt, attachments) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_write', { sessionId, prompt, attachments: attachments ?? null });
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

  /* ---- accounts ---- */

  async accountsList(agentId) {
    return call<Account[]>('accounts_list', { agentId });
  },
  async accountsActive(agentId) {
    return call<Account | null>('accounts_active', { agentId });
  },
  async accountsAdd(agentId, name) {
    return call<Account>('accounts_add', { agentId, name });
  },
  async accountsRename(accountId, name) {
    await call('accounts_rename', { accountId, name });
  },
  async accountsRemove(accountId) {
    await call('accounts_remove', { accountId });
  },
  async accountsSwitch(agentId, accountId) {
    await call('accounts_switch', { agentId, accountId });
  },
  async accountsRefresh(accountId) {
    return call<AccountIdentity | null>('accounts_refresh', { accountId });
  },
  async accountsLoginCommand(accountId) {
    return call<string>('accounts_login_command', { accountId });
  },

  /* ---- sessions ---- */

  async sessionsList(includeArchived) {
    return call<SessionMeta[]>('sessions_list', { includeArchived });
  },
  async sessionsSave(meta, lines) {
    await call('sessions_save', { meta, lines });
  },
  async sessionsLines(sessionId) {
    return call<unknown[]>('sessions_lines', { sessionId });
  },
  async sessionsDelete(sessionId) {
    await call('sessions_delete', { sessionId });
  },
  async sessionsRename(sessionId, name) {
    await call('sessions_rename', { sessionId, name });
  },
  async sessionsSetFlags(sessionId, flags) {
    await call('sessions_set_flags', {
      sessionId,
      pinned: flags.pinned ?? null,
      archived: flags.archived ?? null,
    });
  },
  async sessionsExport(sessionId) {
    return call<string>('sessions_export', { sessionId });
  },
  async sessionsExportFile(sessionId, path) {
    return call<string>('sessions_export_file', { sessionId, path: path ?? null });
  },
  async sessionsImport(json) {
    return call<SessionMeta>('sessions_import', { json });
  },
  async sessionsImportFile(path) {
    return call<SessionMeta>('sessions_import_file', { path });
  },

  /* ---- usage ---- */

  async fileIngest(path) {
    return call<IngestedFile>('file_ingest', { path });
  },
  async fileIngestBytes(name, dataBase64, mediaType) {
    return call<IngestedFile>('file_ingest_bytes', {
      name,
      data: dataBase64,
      mediaType: mediaType ?? null,
    });
  },
  async fileSave(path, contents) {
    return call<string>('file_save', { path, contents });
  },
  async fileOpenInEditor(path) {
    return call<string>('file_open_in_editor', { path });
  },
  async agentCapabilities(agentId) {
    return call<Capability[]>('agent_capabilities', { agentId });
  },
  async sessionsSearch(query, limit) {
    return call<SearchHit[]>('sessions_search', { query, limit: limit ?? null });
  },

  async settingsGet() {
    return call<Settings>('settings_get');
  },
  async settingsSet(value) {
    return call<Settings>('settings_set', { value });
  },
  async versionInfo() {
    return call<VersionInfo>('version_info');
  },

  async usageWeek(accountId) {
    return call<UsageTotals>('usage_week', { accountId });
  },
  async usageRecord({ agentId, accountId, model, usage }) {
    return call<boolean>('usage_record', { agentId, accountId, model, turn: usage });
  },
};

const DESKTOP_ONLY = 'That needs the Kora desktop app — this is a browser preview.';

/** Settings for a browser preview: real enough to use, gone when the tab is. */
let previewSettings: Settings = {
  theme: 'kora-dark',
  fontSize: 13,
  fontFamily: '',
  density: 'comfortable',
  glow: true,
  statusBar: true,
  defaultAgent: 'claude',
  defaultModel: null,
  autoCompact: false,
  notifications: { context: true, usage: true, auth: true, errors: true, updates: true },
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

  // Accounts and local history live in the desktop app's data directory, so a
  // browser preview has none rather than a fake one.
  accountsList: async () => [],
  accountsActive: async () => null,
  accountsAdd: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  accountsRename: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  accountsRemove: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  accountsSwitch: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  accountsRefresh: async () => null,
  accountsLoginCommand: async () => {
    throw new Error(DESKTOP_ONLY);
  },

  sessionsList: async () => [],
  sessionsSave: async () => {},
  sessionsLines: async () => [],
  sessionsDelete: async () => {},
  sessionsRename: async () => {},
  sessionsSetFlags: async () => {},
  sessionsExport: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  sessionsExportFile: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  sessionsImport: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  sessionsImportFile: async () => {
    throw new Error(DESKTOP_ONLY);
  },

  // Reading files and opening editors is the desktop app's job; a browser
  // preview has no filesystem to reach.
  fileIngest: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  fileIngestBytes: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  fileSave: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  fileOpenInEditor: async () => {
    throw new Error(DESKTOP_ONLY);
  },
  agentCapabilities: async () => [],
  sessionsSearch: async () => [],

  // A browser preview keeps settings for the session only, in memory.
  settingsGet: async () => previewSettings,
  settingsSet: async (value) => {
    previewSettings = value;
    return value;
  },
  versionInfo: async () => ({
    version: '0.0.0-preview',
    platform: 'browser',
    releases_url: 'https://github.com/faithdevss/kora/releases',
    self_update: false,
  }),

  usageWeek: async () => ({
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: null,
    estimated_cost_usd: null,
    turns: 0,
  }),
  usageRecord: async () => false,
};

export function defaultBridge(): AgentBridge {
  return hasTauri() ? tauriBridge : offlineBridge;
}
