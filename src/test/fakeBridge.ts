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
  SessionMeta,
  SpawnResult,
} from '../state/agentBridge';
import type { Account, PermissionDecision, Settings, UsageTotals } from '../types/agent';
import type {
  Capability,
  IngestedFile,
  SearchHit,
  WireAttachment,
} from '../state/agentBridge';

export interface FakeBridge extends AgentBridge {
  /** Every prompt sent, in order, as `[sessionId, text]`. */
  readonly writes: [string, string][];
  /** Attachments that went with a prompt, in the wire shape. */
  readonly sent: WireAttachment[][];
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

  /* ---- Phase 3: a stand-in for the backend's own stores ---- */

  /** Accounts the fake backend holds, in creation order. */
  readonly accounts: Account[];
  /** Active account id per agent, as `accounts_switch` sets it. */
  readonly active: Map<string, string>;
  /** Saved sessions, keyed by id. */
  readonly saved: Map<string, { meta: SessionMeta; lines: unknown[] }>;
  /** Every turn handed to `usage_record`. */
  readonly recorded: { accountId: string | null; model: string | null; usage: AgentUsage }[];
  /** Profile dirs `accounts_login_command` was asked about. */
  readonly loginCommands: string[];
  /** Adds a signed-in account without going through the command flow. */
  seedAccount(over?: Partial<Account>): Account;

  /* ---- Phase 5 ---- */

  /** Files `fileIngest` will find, keyed by path. */
  readonly files: Map<string, IngestedFile>;
  /** What each agent reports it can do; Claude sees images by default. */
  readonly capabilities: Map<string, Capability[]>;
  /** Every `[path, contents]` handed to `fileSave`. */
  readonly saves: [string, string][];
  /** Every path handed to `fileOpenInEditor`. */
  readonly opened: string[];
  /** Puts a file on the fake disk. */
  seedFile(over?: Partial<IngestedFile>): IngestedFile;

  /* ---- Phase 6 ---- */

  /** Settings as the fake backend has them stored. */
  settings: Settings;
}

/** Kora's shipped defaults, mirroring `Settings::default()` in Rust. */
export function defaultSettings(): Settings {
  return {
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
}

/** A small text file, the shape the Rust ingest layer returns. */
function seededFile(n: number, over: Partial<IngestedFile> = {}): IngestedFile {
  return {
    path: `/work/file-${n}.ts`,
    name: `file-${n}.ts`,
    kind: 'text',
    size: 12,
    media_type: 'text/typescript',
    text: 'export const x = 1;',
    data: null,
    truncated: false,
    note: null,
    ...over,
  };
}

/** A subscription account, which is what a `claude auth login` produces. */
function seededAccount(n: number, over: Partial<Account> = {}): Account {
  return {
    id: `acct-${n}`,
    agent_id: 'claude',
    name: `account-${n}`,
    dir: `/data/accounts/acct-${n}`,
    identity: {
      logged_in: true,
      auth_method: 'claude.ai',
      email: `user${n}@example.com`,
      org_name: null,
      subscription: 'pro',
    },
    ...over,
  };
}

function emptyTotals(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: null,
    estimated_cost_usd: null,
    turns: 0,
  };
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
  let acctCount = 0;

  /** The account a spawn for `agentId` runs under, mirroring the real store. */
  const activeAccount = (agentId: string): Account | null => {
    const id = bridge.active.get(agentId);
    return (
      bridge.accounts.find((a) => a.id === id) ??
      bridge.accounts.find((a) => a.agent_id === agentId) ??
      null
    );
  };

  const findAccount = (id: string): Account => {
    const a = bridge.accounts.find((x) => x.id === id);
    if (!a) throw new Error('no such account');
    return a;
  };

  const bridge: FakeBridge = {
    writes: [],
    sent: [],
    spawns: [],
    respawns: [],
    kills: [],
    permissions: [],
    interrupts: [],
    connected: new Set(['claude']),
    failNextSpawn: null,
    failNextWrite: null,
    resumeReturns: null,
    accounts: [],
    active: new Map(),
    saved: new Map(),
    recorded: [],
    loginCommands: [],
    files: new Map(),
    capabilities: new Map([['claude', ['streaming', 'usage', 'vision'] as Capability[]]]),
    saves: [],
    opened: [],
    settings: defaultSettings(),

    emit(sessionId, event) {
      handlers.forEach((h) => h(sessionId, event));
    },

    seedAccount(over = {}) {
      const account = seededAccount(++acctCount, over);
      bridge.accounts.push(account);
      return account;
    },

    seedFile(over = {}) {
      const file = seededFile(bridge.files.size + 1, over);
      bridge.files.set(file.path, file);
      return file;
    },

    async spawn({ sessionId, agentId }): Promise<SpawnResult> {
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
        account: activeAccount(agentId),
      };
    },

    async respawn({ sessionId, agentId, resumeUuid }): Promise<SpawnResult> {
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
        account: activeAccount(agentId),
      };
    },

    async write(sessionId, prompt, attachments) {
      if (bridge.failNextWrite) {
        const msg = bridge.failNextWrite;
        bridge.failNextWrite = null;
        throw new Error(msg);
      }
      bridge.writes.push([sessionId, prompt]);
      if (attachments?.length) bridge.sent.push(attachments);
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

    /* ---- accounts ---- */

    async accountsList(agentId) {
      return bridge.accounts.filter((a) => a.agent_id === agentId);
    },

    async accountsActive(agentId) {
      return activeAccount(agentId);
    },

    async accountsAdd(agentId, name) {
      if (bridge.accounts.some((a) => a.agent_id === agentId && a.name === name)) {
        throw new Error(`an account named ${name} already exists`);
      }
      // As in the real store: a new account has a directory but no sign-in yet.
      const account = seededAccount(++acctCount, { agent_id: agentId, name, identity: null });
      bridge.accounts.push(account);
      if (!bridge.active.has(agentId)) bridge.active.set(agentId, account.id);
      return account;
    },

    async accountsRename(accountId, name) {
      findAccount(accountId).name = name;
    },

    async accountsRemove(accountId) {
      const i = bridge.accounts.findIndex((a) => a.id === accountId);
      if (i < 0) throw new Error('no such account');
      bridge.accounts.splice(i, 1);
      for (const [agent, id] of bridge.active) if (id === accountId) bridge.active.delete(agent);
    },

    async accountsSwitch(agentId, accountId) {
      const a = findAccount(accountId);
      if (a.agent_id !== agentId) throw new Error('no such account for this agent');
      bridge.active.set(agentId, accountId);
    },

    async accountsRefresh(accountId) {
      const a = findAccount(accountId);
      // The fake agent always reports a signed-in subscription.
      a.identity = a.identity ?? seededAccount(0).identity;
      return a.identity;
    },

    async accountsLoginCommand(accountId) {
      const a = findAccount(accountId);
      bridge.loginCommands.push(a.id);
      return `CLAUDE_CONFIG_DIR=${a.dir} claude auth login`;
    },

    /* ---- sessions ---- */

    async sessionsList(includeArchived) {
      return [...bridge.saved.values()]
        .map((s) => s.meta)
        .filter((m) => includeArchived || !m.archived)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
    },

    async sessionsSave(meta, lines) {
      bridge.saved.set(meta.id, { meta: { ...meta }, lines: [...lines] });
    },

    async sessionsLines(sessionId) {
      return bridge.saved.get(sessionId)?.lines ?? [];
    },

    async sessionsDelete(sessionId) {
      bridge.saved.delete(sessionId);
    },

    async sessionsRename(sessionId, name) {
      const entry = bridge.saved.get(sessionId);
      if (entry) entry.meta.name = name;
    },

    async sessionsSetFlags(sessionId, flags) {
      const entry = bridge.saved.get(sessionId);
      if (!entry) return;
      if (flags.pinned !== undefined) entry.meta.pinned = flags.pinned;
      if (flags.archived !== undefined) entry.meta.archived = flags.archived;
    },

    async sessionsExport(sessionId) {
      const entry = bridge.saved.get(sessionId);
      if (!entry) throw new Error('no such session');
      return JSON.stringify({ kora_session: 1, meta: entry.meta, lines: entry.lines });
    },

    async sessionsExportFile(sessionId, path) {
      await bridge.sessionsExport(sessionId);
      return path ?? `/data/exports/${sessionId}.kora.json`;
    },

    async sessionsImport(json) {
      const parsed = JSON.parse(json) as { meta: SessionMeta; lines: unknown[] };
      const meta = { ...parsed.meta, id: `imported-${bridge.saved.size + 1}` };
      bridge.saved.set(meta.id, { meta, lines: parsed.lines });
      return meta;
    },

    async sessionsImportFile(path) {
      const source = [...bridge.saved.values()][0];
      if (!source) throw new Error(`could not read ${path}`);
      return bridge.sessionsImport(
        JSON.stringify({ kora_session: 1, meta: source.meta, lines: source.lines }),
      );
    },

    /* ---- usage ---- */

    /* ---- files, search, capabilities ---- */

    async fileIngest(path) {
      const seeded = bridge.files.get(path);
      if (!seeded) throw new Error(`no such file: ${path}`);
      return seeded;
    },

    async fileIngestBytes(name, dataBase64, mediaType) {
      const isImage = (mediaType ?? '').startsWith('image/');
      // The real policy lives in Rust; this mirrors only its shape, which is
      // what the store is written against.
      return {
        path: '',
        name: name.trim() || 'pasted',
        kind: isImage ? 'image' : 'text',
        size: Math.floor((dataBase64.length * 3) / 4),
        media_type: mediaType ?? 'text/plain',
        text: isImage ? null : atob(dataBase64),
        data: isImage ? dataBase64 : null,
        truncated: false,
        note: null,
      };
    },

    async fileSave(path, contents) {
      bridge.saves.push([path, contents]);
      return path;
    },

    async fileOpenInEditor(path) {
      bridge.opened.push(path);
      return `vi ${path}`;
    },

    async agentCapabilities(agentId) {
      return bridge.capabilities.get(agentId) ?? [];
    },

    async sessionsSearch(query) {
      const needle = query.toLowerCase();
      const hits: SearchHit[] = [];
      for (const { meta, lines } of bridge.saved.values()) {
        lines.forEach((line, seq) => {
          const text = JSON.stringify(line);
          if (!text.toLowerCase().includes(needle)) return;
          hits.push({
            session_id: meta.id,
            session_name: meta.name,
            agent_id: meta.agent_id,
            seq,
            snippet: text,
            updated_at: meta.updated_at,
          });
        });
      }
      return hits;
    },

    async settingsGet() {
      return bridge.settings;
    },

    async settingsSet(value) {
      // The real store clamps; this mirrors the one rule a test would notice.
      bridge.settings = { ...value, fontSize: Math.min(Math.max(value.fontSize, 9), 24) };
      return bridge.settings;
    },

    async versionInfo() {
      return {
        version: '0.1.0',
        platform: 'darwin',
        releases_url: 'https://github.com/faithdevs/kora/releases',
        self_update: false,
      };
    },

    async usageWeek(accountId) {
      const totals = emptyTotals();
      for (const turn of bridge.recorded) {
        if (accountId && turn.accountId !== accountId) continue;
        totals.input_tokens += turn.usage.input_tokens;
        totals.output_tokens += turn.usage.output_tokens;
        totals.cache_read += turn.usage.cache_read_tokens;
        totals.cache_write += turn.usage.cache_creation_tokens;
        totals.turns += 1;
        if (turn.usage.total_cost_usd !== null) {
          totals.cost_usd = (totals.cost_usd ?? 0) + turn.usage.total_cost_usd;
        }
      }
      return totals;
    },

    async usageRecord({ accountId, model, usage: turn }) {
      const empty =
        turn.input_tokens === 0 &&
        turn.output_tokens === 0 &&
        turn.cache_read_tokens === 0 &&
        turn.cache_creation_tokens === 0;
      if (empty) return false;
      bridge.recorded.push({ accountId, model, usage: turn });
      return true;
    },
  };

  return bridge;
}
