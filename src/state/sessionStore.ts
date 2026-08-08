/**
 * Session/tab/pane store.
 *
 * Phase 2 replaced the simulated agent with a real one: prompts go out through
 * the [`AgentBridge`] to a live CLI process, and transcript lines are built from
 * the events that come back. The pure reducers in `commandRouter` are unchanged
 * — only the source of `resp` content moved.
 */

import type { AppState } from './appState';
import {
  accountsFor,
  agentOf,
  availCmds,
  focusedSession,
  initialState,
  mkSession,
  modelOf,
  nextAttachmentId,
  nextToastId,
  pushLine,
  reserveSessionIds,
  sessionById,
  updateSession,
  withKey,
} from './appState';
import {
  checkContext,
  closeTab as closeTabFn,
  isLocalCommand,
  matchAcct,
  newTab as newTabFn,
  runCommand,
  selectAccount,
  selectAgent,
  selectModel,
  toggleSplit as toggleSplitFn,
} from './commandRouter';
import { accountSubtitle } from './accounts';
import { fmt } from './format';
import type { ActionId } from './keymap';
import { findMatches, wrapIndex, type SearchMode } from './search';
import { CTX_URGENT } from './format';
import { mockDataSource, type DataSource } from './mockFixtures';
import {
  defaultBridge,
  type AgentBridge,
  type AgentEvent,
  type AgentUsage,
  type Capability,
  type IngestedFile,
  type SearchHit,
  type SessionMeta,
  type WireAttachment,
} from './agentBridge';
import type {
  Account,
  Attachment as AttachmentType,
  Density,
  ListKind,
  PermissionDecision,
  Session,
  Settings,
  Toast,
  TranscriptLine,
} from '../types/agent';

type Listener = () => void;

/**
 * How many saved sessions come back as tabs on start.
 *
 * They are ordered pinned-first, most recent next, so this keeps the long tail
 * of old conversations out of the tab bar — `/session list` reaches the rest.
 */
const MAX_RESTORED_TABS = 8;

/** How long a notification stays on screen. */
const TOAST_MS = 8000;

/** What `/session` on its own explains. */
const SESSION_HELP = [
  { c: '/session list', d: 'saved sessions (add "all" for archived)' },
  { c: '/session save [name]', d: 'write this session now' },
  { c: '/session open <name>', d: 'bring a saved session back as a tab' },
  { c: '/session rename <name>', d: 'rename this session' },
  { c: '/session pin | unpin', d: 'keep it at the top of the list' },
  { c: '/session archive', d: 'hide it without deleting it' },
  { c: '/session delete [name]', d: 'delete a saved session' },
  { c: '/session export [path]', d: 'write a portable JSON file' },
  { c: '/session import <path>', d: 'read one back in' },
];

export class SessionStore {
  private state: AppState;
  private listeners = new Set<Listener>();
  private data: DataSource;
  private bridge: AgentBridge;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  /** Resolved workspace path, learned from the backend on first spawn. */
  private cwd: string | null = null;
  /** Sessions whose resume has not yet proved itself by producing output. */
  private resumePending = new Set<string>();
  /** Sessions that sent `/clear` and are waiting for the CLI to confirm it. */
  private pendingClear = new Set<string>();
  private disposed = false;
  /** Pending transcript writes, one timer per session (auto-save is debounced). */
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** How long a session sits idle before its transcript is written. */
  saveDelay = 400;
  /** True while saved sessions are being read back in, which must not re-save. */
  private restoring = false;
  /** What each agent can do, asked once per agent (`vision` gates images). */
  private capabilities = new Map<string, Capability[]>();
  /** Auto-dismiss timers, one per visible notification. */
  private toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `kind:session` for notifications on screen, so a condition warns once. */
  private liveToasts = new Set<string>();

  constructor(
    initial: AppState = initialState(),
    data: DataSource = mockDataSource,
    bridge: AgentBridge = defaultBridge(),
  ) {
    this.state = initial;
    this.data = data;
    this.bridge = bridge;
  }

  /* ---- external-store plumbing ---- */

  getState = (): AppState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(next: AppState): void {
    if (next === this.state) return;
    const before = this.state;
    this.state = next;
    // Anything that changed a transcript is worth persisting, so a crash or a
    // quit never loses more than the debounce window.
    for (const s of next.sessions) {
      const old = before.sessions.find((p) => p.id === s.id);
      if (!old || old.lines !== s.lines || old.name !== s.name || old.account !== s.account) {
        this.queueSave(s.id);
      }
    }
    this.listeners.forEach((l) => l());
  }

  /* ---- lifecycle ---- */

  /**
   * Connects to the backend and starts the focused session's agent.
   * Safe to call once per app mount.
   */
  start = async (): Promise<void> => {
    // Set synchronously: React StrictMode fires the mount effect twice before
    // the first await resolves, which would otherwise subscribe and spawn twice.
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribe = await this.bridge.subscribe(this.handleEvent);
    try {
      this.cwd = await this.bridge.workspaceDir();
    } catch {
      this.cwd = null;
    }
    await this.loadSettings();
    await this.loadAccounts();
    await this.restoreSessions();
    await this.ensureAgent(this.state.focusedId);
  };

  /** Stops listening and kills every agent process. */
  dispose = async (): Promise<void> => {
    this.disposed = true;
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const ids = this.state.sessions.map((s) => s.id);
    this.listeners.clear();
    // Write out anything still sitting in the debounce window before going.
    await Promise.all(ids.map((id) => this.flushSave(id)));
    await Promise.all(ids.map((id) => this.bridge.kill(id).catch(() => {})));
  };

  /** Reads persisted settings, falling back to defaults if the store is gone. */
  private async loadSettings(): Promise<void> {
    try {
      this.set(this.withSettings(this.state, await this.bridge.settingsGet()));
    } catch {
      /* defaults are already in state; a missing settings file is not an error */
    }
    try {
      const info = await this.bridge.versionInfo();
      this.set({ ...this.state, version: info.version });
    } catch {
      /* the version is decoration until /version is asked for */
    }
  }

  /* ---- accounts ---- */

  /** Loads every agent's accounts from the backend store. */
  private async loadAccounts(): Promise<void> {
    const lists = await Promise.all(
      this.data.agents().map((a) => this.bridge.accountsList(a.id).catch(() => [] as Account[])),
    );
    const accounts = lists.flat();
    this.set({ ...this.state, accounts });

    // Point sessions with no account yet at their agent's active one.
    for (const s of this.state.sessions) {
      if (s.account) continue;
      const active = await this.bridge.accountsActive(s.agentId).catch(() => null);
      if (active) this.set(updateSession(this.state, s.id, (sess) => ({ ...sess, account: active })));
    }
    await Promise.all(accounts.map((a) => this.refreshWeek(a.id)));
  }

  /** Re-reads Kora's own rolling seven-day record for one account. */
  private async refreshWeek(accountId: string): Promise<void> {
    try {
      const week = await this.bridge.usageWeek(accountId);
      this.set({ ...this.state, week: { ...this.state.week, [accountId]: week } });
    } catch {
      /* usage history is a convenience; its absence is not worth a line */
    }
  }

  /* ---- persistence ---- */

  /** The row the local store keeps for a session. */
  private metaOf(s: Session): SessionMeta {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: s.id,
      name: s.name,
      agent_id: s.agentId,
      account_id: s.account?.id ?? null,
      model_id: s.modelId,
      cwd: s.cwd ?? this.cwd,
      agent_uuid: s.agentUuid ?? null,
      pinned: s.pinned ?? false,
      archived: s.archived ?? false,
      created_at: s.createdAt ?? now,
      updated_at: now,
    };
  }

  /** Schedules a transcript write, coalescing bursts of streaming deltas. */
  private queueSave(sessionId: string): void {
    // Loading a session back is not a change to it: without this, every launch
    // would rewrite every restored transcript and flatten the recency order.
    if (this.disposed || this.restoring) return;
    // A session whose record the user deleted stays on screen but stops being
    // written, so `/session delete` does not immediately undo itself.
    if (sessionById(this.state, sessionId)?.unsaved) return;
    const pending = this.saveTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    this.saveTimers.set(
      sessionId,
      setTimeout(() => {
        this.saveTimers.delete(sessionId);
        void this.saveSession(sessionId);
      }, this.saveDelay),
    );
  }

  /** Writes a session now, cancelling any pending debounce for it. */
  private async flushSave(sessionId: string): Promise<void> {
    const pending = this.saveTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    this.saveTimers.delete(sessionId);
    await this.saveSession(sessionId);
  }

  private async saveSession(sessionId: string): Promise<void> {
    const s = sessionById(this.state, sessionId);
    if (!s || s.unsaved) return;
    try {
      await this.bridge.sessionsSave(this.metaOf(s), s.lines);
      if (!s.createdAt) {
        this.set(
          updateSession(this.state, sessionId, (sess) => ({
            ...sess,
            createdAt: sess.createdAt ?? Math.floor(Date.now() / 1000),
          })),
        );
      }
    } catch {
      /* A failed write must not interrupt the conversation; the next append
         retries, and `/session save` reports the error out loud. */
    }
  }

  /** Rebuilds the tabs that were open when Kora last quit. */
  private async restoreSessions(): Promise<void> {
    let metas: SessionMeta[];
    try {
      metas = await this.bridge.sessionsList(false);
    } catch {
      return;
    }
    if (!metas.length) return;
    reserveSessionIds(metas.map((m) => m.id));

    this.restoring = true;
    try {
      const restored: Session[] = [];
      for (const meta of metas.slice(0, MAX_RESTORED_TABS)) {
        const session = await this.sessionFromMeta(meta);
        if (session) restored.push(session);
      }
      if (!restored.length) return;

      // The blank starter tab has nothing in it worth keeping once real
      // sessions come back; a used one (the store started before this resolved)
      // stays.
      const starters = this.state.sessions.filter((s) => s.lines.length > 1 || s.history.length);
      const sessions = [...restored, ...starters];
      this.set({
        ...this.state,
        sessions,
        focusedId: sessions[0].id,
      });
    } finally {
      this.restoring = false;
    }
  }

  /** Turns a persisted row plus its transcript back into a tab. */
  private async sessionFromMeta(meta: SessionMeta): Promise<Session | null> {
    if (!this.data.agents().some((a) => a.id === meta.agent_id)) return null;
    const base = mkSession(meta.agent_id);
    let lines: TranscriptLine[] = [];
    try {
      // Re-key: line keys are minted per run, so a restored `l4` would collide
      // with a `l4` created later in this one.
      lines = (await this.bridge.sessionsLines(meta.id)).map((l) =>
        withKey(l as Parameters<typeof withKey>[0]),
      );
    } catch {
      return null;
    }
    return {
      ...base,
      id: meta.id,
      name: meta.name,
      agentId: meta.agent_id,
      account: this.state.accounts.find((a) => a.id === meta.account_id),
      modelId: meta.model_id ?? base.modelId,
      cwd: meta.cwd ?? undefined,
      agentUuid: meta.agent_uuid ?? undefined,
      pinned: meta.pinned,
      archived: meta.archived,
      createdAt: meta.created_at,
      lines: lines.length ? lines : base.lines,
      // No process yet. `ensureAgent` resumes the conversation when the tab is
      // focused, so restoring many tabs does not start many CLIs.
      status: 'offline',
    };
  }

  /**
   * Spawns the agent for a session if it is not already running.
   *
   * Agents with no real adapter are left `offline` with an explanatory line
   * rather than silently behaving like a connected one.
   */
  ensureAgent = async (sessionId: string): Promise<void> => {
    const session = sessionById(this.state, sessionId);
    if (!session) return;
    if (session.status !== 'offline' && session.status !== 'dead') return;

    const agent = agentOf(session);
    if (!(await this.bridge.isConnected(agent.id).catch(() => false))) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'dim',
          text: `${agent.name} is not connected yet — Kora can select it, but it has no adapter in this build. Use /agents to switch back to one that runs.`,
        }),
      );
      return;
    }

    this.setStatus(sessionId, 'starting');
    // Any session that already has an agent conversation id and no process is
    // one to resume — a crash, or a tab restored from the local store.
    const resumeUuid = session.agentUuid;

    try {
      const result = resumeUuid
        ? await this.bridge.respawn({
            sessionId,
            agentId: agent.id,
            cwd: this.cwd ?? this.data.workspace(),
            model: modelOf(session).id,
            resumeUuid,
          })
        : await this.bridge.spawn({
            sessionId,
            agentId: agent.id,
            cwd: this.cwd ?? this.data.workspace(),
            model: modelOf(session).id,
          });

      this.cwd = result.cwd;

      this.set(
        updateSession(this.state, sessionId, (s) => ({
          ...s,
          status: 'idle',
          agentUuid: result.agent_uuid,
          cwd: result.cwd,
          // The backend chose the credentials, so its answer is the truth about
          // which account this process is actually running under.
          account: result.account ?? s.account,
          workspace: {
            labels: result.workspace.labels,
            mcpServers: s.workspace?.mcpServers ?? 0,
          },
        })),
      );

      if (resumeUuid) {
        // Spawning successfully is not proof the conversation came back — the
        // agent may reject the id and exit a moment later. So this says what we
        // asked for, and `handleExit` corrects the record if it did not hold.
        this.resumePending.add(sessionId);
        this.set(
          pushLine(this.state, sessionId, {
            t: 'ok',
            text: 'Agent restarted, resuming the previous conversation.',
          }),
        );
      }
    } catch (e) {
      this.setStatus(sessionId, 'offline');
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  private setStatus(sessionId: string, status: Session['status']): void {
    this.set(updateSession(this.state, sessionId, (s) => ({ ...s, status })));
  }

  /* ---- agent events ---- */

  /** Applies one backend event to the session it belongs to. */
  handleEvent = (sessionId: string, event: AgentEvent): void => {
    if (!sessionById(this.state, sessionId)) return;

    switch (event.kind) {
      case 'ready':
        // The agent accepted the conversation id and reported for duty; any
        // later exit is a genuine crash, not a failed resume.
        if (event.agent_session_id) this.resumePending.delete(sessionId);
        this.set(
          updateSession(this.state, sessionId, (s) => ({
            ...s,
            status: s.status === 'busy' ? 'busy' : 'idle',
            agentUuid: event.agent_session_id ?? s.agentUuid,
            workspace: {
              labels: s.workspace?.labels ?? [],
              // `null` means this event did not know, so keep what we had.
              mcpServers: event.mcp_servers ?? s.workspace?.mcpServers ?? 0,
            },
            agentCommands: event.commands.length
              ? event.commands.map((c) => ({ c: c.name, d: c.description }))
              : s.agentCommands,
          })),
        );
        break;

      case 'delta':
        this.resumePending.delete(sessionId);
        this.appendDelta(sessionId, event.text);
        break;

      case 'message_done':
        this.set(
          updateSession(this.state, sessionId, (s) => ({
            ...s,
            lines: s.lines.map((l) =>
              l.key === s.streamKey && l.t === 'resp' ? { ...l, streaming: false } : l,
            ),
          })),
        );
        break;

      case 'tool':
        this.attachTool(sessionId, event.detail, event.path);
        break;

      case 'permission':
        this.set(
          pushLine(this.state, sessionId, {
            t: 'perm',
            requestId: event.request_id,
            tool: event.tool,
            detail: event.detail,
            scope: event.scope,
          }),
        );
        break;

      case 'turn_end':
        this.resumePending.delete(sessionId);
        this.finishTurn(sessionId, event);
        break;

      case 'models':
        // The live CLI's own list, which replaces the static catalogue for this
        // session — the fixture is stale by two model generations.
        this.set(
          updateSession(this.state, sessionId, (s) => ({
            ...s,
            models: event.models.map((m) => ({
              id: m.id,
              name: m.display_name || m.id,
              desc: m.description || undefined,
              // The agent reports no window here; keep what usage told us.
              win: s.ctxWin,
            })),
          })),
        );
        break;

      case 'rate_limit':
        this.set(
          updateSession(this.state, sessionId, (s) => ({
            ...s,
            rateLimit: {
              window: event.window,
              utilization: event.utilization,
              resetsAt: event.resets_at,
            },
          })),
        );
        break;

      case 'compacted':
        this.compacted(sessionId, event.pre_tokens, event.trigger);
        break;

      case 'notice':
        this.set(pushLine(this.state, sessionId, { t: 'out', text: event.text }));
        break;

      case 'error':
        this.set(
          pushLine(this.dropThinking(this.state, sessionId), sessionId, {
            t: 'err',
            text: event.message,
          }),
        );
        // Named, not quoted: the message can carry prompt fragments.
        this.notify({
          kind: this.looksLikeAuth(event.message) ? 'auth' : 'errors',
          text: this.looksLikeAuth(event.message)
            ? `"${sessionById(this.state, sessionId)?.name}" is no longer signed in.`
            : `A turn failed in "${sessionById(this.state, sessionId)?.name}".`,
          sessionId,
        });
        break;

      case 'exited':
        this.handleExit(sessionId, event.code, event.recoverable);
        break;
    }
  };

  /** Removes the "working…" spinner, if one is showing. */
  private dropThinking(state: AppState, sessionId: string): AppState {
    return updateSession(state, sessionId, (s) => ({
      ...s,
      lines: s.lines.filter((l) => l.t !== 'think'),
    }));
  }

  /** Appends streamed text to the open response line, opening one if needed. */
  private appendDelta(sessionId: string, text: string): void {
    let next = this.dropThinking(this.state, sessionId);
    const session = sessionById(next, sessionId)!;
    const open = session.lines.find((l) => l.key === session.streamKey && l.t === 'resp');

    if (open) {
      next = updateSession(next, sessionId, (s) => ({
        ...s,
        lines: s.lines.map((l) =>
          l.key === s.streamKey && l.t === 'resp' ? { ...l, text: l.text + text } : l,
        ),
      }));
    } else {
      next = pushLine(next, sessionId, { t: 'resp', text, streaming: true });
      const created = sessionById(next, sessionId)!;
      const key = created.lines[created.lines.length - 1].key;
      next = updateSession(next, sessionId, (s) => ({ ...s, streamKey: key }));
    }
    this.set(next);
  }

  /**
   * Records a tool call against the response it belongs to.
   *
   * A call that named a file also gives the response a path, which is what
   * makes "open in editor" on its code block point somewhere real.
   */
  private attachTool(sessionId: string, detail: string, path?: string | null): void {
    const session = sessionById(this.state, sessionId)!;
    const hasOpen = session.lines.some((l) => l.key === session.streamKey && l.t === 'resp');

    if (!hasOpen) {
      // A tool ran before any prose — show it on its own so it is not lost.
      this.set(
        pushLine(this.dropThinking(this.state, sessionId), sessionId, {
          t: 'dim',
          text: detail,
        }),
      );
      return;
    }
    this.set(
      updateSession(this.state, sessionId, (s) => ({
        ...s,
        lines: s.lines.map((l) =>
          l.key === s.streamKey && l.t === 'resp'
            ? { ...l, tools: [...(l.tools ?? []), detail], path: path ?? l.path }
            : l,
        ),
      })),
    );
  }

  /** Closes out a turn and folds in the agent's real usage numbers. */
  private finishTurn(sessionId: string, event: Extract<AgentEvent, { kind: 'turn_end' }>): void {
    let next = this.dropThinking(this.state, sessionId);
    const session = sessionById(next, sessionId)!;
    const hadText = session.lines.some((l) => l.key === session.streamKey && l.t === 'resp');

    // Slash commands answered by the CLI arrive only as result text.
    if (!hadText && event.text.trim()) {
      next = pushLine(next, sessionId, { t: 'out', text: event.text.trim() });
    }
    if (event.is_error && event.text.trim()) {
      next = pushLine(next, sessionId, { t: 'err', text: event.text.trim() });
    }

    const usage = event.usage;
    next = updateSession(next, sessionId, (s) => {
      const lines = s.lines.map((l) =>
        l.key === s.streamKey && l.t === 'resp' ? { ...l, streaming: false } : l,
      );
      if (!usage) {
        return { ...s, lines, status: 'idle', streamKey: undefined, msgs: s.msgs + 1 };
      }
      const contextUsed =
        usage.input_tokens +
        usage.cache_read_tokens +
        usage.cache_creation_tokens +
        usage.output_tokens;
      // Commands the CLI answers itself report a turn with no tokens and no
      // cost. Those must not zero the running totals or inflate the count.
      const billed = usage.output_tokens > 0;
      return {
        ...s,
        lines,
        status: 'idle',
        streamKey: undefined,
        msgs: billed ? s.msgs + 1 : s.msgs,
        // Real numbers from the agent, replacing Phase 1's estimates.
        sessIn: s.sessIn + usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens,
        sessOut: s.sessOut + usage.output_tokens,
        cacheRead: s.cacheRead + usage.cache_read_tokens,
        ctxUsed: contextUsed || s.ctxUsed,
        ctxWin: usage.context_window ?? s.ctxWin,
        // A real measurement supersedes the "approximate since compaction" mark.
        ctxStale: contextUsed ? false : s.ctxStale,
        costUsd: usage.total_cost_usd && usage.total_cost_usd > 0 ? usage.total_cost_usd : s.costUsd,
      };
    });

    // A `/clear` the CLI accepted means its context is empty; Kora's count
    // follows rather than waiting a turn to notice.
    if (this.pendingClear.delete(sessionId) && !event.is_error) {
      next = updateSession(next, sessionId, (s) => ({
        ...s,
        ctxUsed: 0,
        ctxStale: false,
        warned: undefined,
      }));
    }

    this.set(checkContext(next, sessionId));
    this.afterMeasurement(sessionId);
    if (usage) void this.recordUsage(sessionId, usage);
  }

  /**
   * What happens when a turn tells us how full the context really is.
   *
   * The notification fires here rather than from the `/usage` panel, so a user
   * who never opens it still finds out (phase-6 acceptance criterion 3), and
   * auto-compact — off by default — asks the *agent* to compact rather than
   * doing anything to the conversation itself.
   */
  private afterMeasurement(sessionId: string): void {
    const s = sessionById(this.state, sessionId);
    if (!s || s.ctxWin <= 0) return;
    const pct = s.ctxUsed / s.ctxWin;

    if (pct >= CTX_URGENT) {
      if (this.state.settings.autoCompact && s.status === 'idle') {
        this.set(
          pushLine(this.state, sessionId, {
            t: 'dim',
            text: 'Context is over 90% — asking the agent to compact (auto-compact is on).',
          }),
        );
        void this.sendToAgent(sessionId, '/compact');
      } else {
        this.notify({
          kind: 'context',
          // Names the session and the condition. No conversation content: this
          // can surface on a locked screen.
          text: `Context is ${Math.round(pct * 100)}% full in "${s.name}".`,
          sessionId,
          action: { label: '/compact', cmd: '/compact' },
        });
      }
    }

    const quota = s.rateLimit;
    if (quota && quota.utilization >= 0.9) {
      this.notify({
        kind: 'usage',
        text: `${quota.window.replace('_', '-')} usage is at ${Math.round(
          quota.utilization * 100,
        )}% on "${s.name}".`,
        sessionId,
        action: { label: '/accounts', cmd: '/accounts' },
      });
    }
  }

  /**
   * Files one turn's real token counts with the local store.
   *
   * These are the agent's own numbers, so the weekly figure survives a restart
   * without Kora ever estimating anything.
   */
  private async recordUsage(sessionId: string, usage: AgentUsage): Promise<void> {
    const s = sessionById(this.state, sessionId);
    if (!s) return;
    try {
      const recorded = await this.bridge.usageRecord({
        agentId: s.agentId,
        accountId: s.account?.id ?? null,
        model: modelOf(s).id,
        usage,
      });
      if (recorded && s.account) await this.refreshWeek(s.account.id);
    } catch {
      /* the conversation matters more than the bookkeeping */
    }
  }

  /**
   * The agent compacted its own context.
   *
   * It reports what the context held *before* compacting, which is the only
   * number it has at that moment — the new size is not known until the next
   * turn reports usage. So Kora says what was freed from, marks its own figure
   * approximate, and waits rather than inventing a post-compaction total.
   * Kora never produces the summary itself (phase 4, acceptance criterion 5).
   */
  private compacted(
    sessionId: string,
    preTokens: number | null,
    trigger: string | null,
  ): void {
    const by = trigger === 'auto' ? 'automatically' : '';
    const from = preTokens ? ` It was ${fmt(preTokens)} tokens before.` : '';
    let next = updateSession(this.state, sessionId, (s) => ({
      ...s,
      ctxStale: true,
      // A compaction is a fresh start for the warnings: the next real
      // measurement decides whether they apply again.
      warned: undefined,
    }));
    next = pushLine(next, sessionId, {
      t: 'ok',
      text:
        `Context compacted ${by}by the agent — earlier turns were summarized.${from} ` +
        'The new size arrives with the next turn.',
    });
    this.set(next);
  }

  /** Turns an unexpected process exit into a respawn offer. */
  private handleExit(sessionId: string, code: number | null, recoverable: boolean): void {
    // A resume that died before producing anything did not take. Say so, and
    // start a fresh conversation rather than leaving a dead pane.
    if (this.resumePending.delete(sessionId)) {
      let failed = updateSession(this.state, sessionId, (s) => ({
        ...s,
        status: 'dead',
        streamKey: undefined,
        agentUuid: undefined,
      }));
      failed = pushLine(failed, sessionId, {
        t: 'err',
        text: 'The previous conversation could not be restored — starting a fresh session instead.',
      });
      this.set(failed);
      void this.ensureAgent(sessionId);
      return;
    }

    let next = this.dropThinking(this.state, sessionId);
    next = updateSession(next, sessionId, (s) => ({
      ...s,
      status: 'dead',
      streamKey: undefined,
    }));
    next = pushLine(next, sessionId, {
      t: 'err',
      text:
        `The agent process ended${code === null ? '' : ` (exit ${code})`}.` +
        (recoverable ? ' Its conversation can be restored.' : ''),
      action: recoverable ? { label: 'respawn agent', cmd: '/respawn' } : undefined,
    });
    this.set(next);
  }

  /* ---- input ---- */

  setInput = (v: string): void => {
    this.set({ ...this.state, input: v });
  };

  fillInput = (cmd: string): void => {
    this.set({ ...this.state, input: cmd + ' ', focusNonce: this.state.focusNonce + 1 });
  };

  setDensity = (density: Density): void => {
    this.set({ ...this.state, density });
  };

  setGlow = (glow: boolean): void => {
    this.set({ ...this.state, glow });
  };

  /**
   * Enter.
   *
   * Kora's own commands run locally; everything else — prose and the agent's
   * native slash commands alike — goes to the process, so `/compact`, `/cost`
   * and friends produce the real CLI's behavior rather than a reimplementation.
   */
  submit = (): void => {
    const text = this.state.input.trim();
    if (!text) return;
    const id = this.state.focusedId;

    let next = updateSession(this.state, id, (s) => ({ ...s, history: [...s.history, text] }));
    next = { ...next, input: '', histIdx: null };

    if (this.handleProcessCommand(next, id, text)) return;
    if (this.handleBackendCommand(next, id, text)) return;

    if (text.startsWith('/') && isLocalCommand(next, id, text)) {
      this.runLocal(next, id, text);
      return;
    }
    this.set(next);
    void this.sendToAgent(id, text);
  };

  /**
   * `/respawn` and `/stop` act on the process rather than the transcript, so
   * they are handled here instead of in the pure router. Returns whether the
   * command was consumed.
   */
  private handleProcessCommand(state: AppState, sessionId: string, raw: string): boolean {
    const cmd = raw.trim().split(/\s+/)[0].toLowerCase();
    const session = sessionById(state, sessionId);
    if (!session) return false;

    if (cmd === '/respawn' && (session.status === 'dead' || session.status === 'offline')) {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      void this.respawn(sessionId);
      return true;
    }
    if (cmd === '/stop' && session.status === 'busy') {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      void this.interrupt(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Commands that have to reach the backend before they mean anything:
   * everything that manages accounts or saved sessions.
   *
   * The pure router still renders the bare `/accounts` list, because that is
   * only a view of state already loaded. Returns whether the command was taken.
   */
  private handleBackendCommand(state: AppState, sessionId: string, raw: string): boolean {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    if (!sessionById(state, sessionId)) return false;

    if ((cmd === '/accounts' || cmd === '/users') && args.length) {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      void this.runAccountCommand(sessionId, args);
      return true;
    }
    if (cmd === '/session' || cmd === '/sessions') {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      void this.runSessionCommand(sessionId, args);
      return true;
    }
    if (cmd === '/settings') {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      this.openSettings();
      return true;
    }
    if (cmd === '/theme') {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      void this.setTheme(sessionId, args.join(' ').trim());
      return true;
    }
    if (cmd === '/version' || cmd === '/update') {
      this.set(pushLine(state, sessionId, { t: 'cmd', text: raw }));
      void this.showVersion(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Switches theme, or lists what there is.
   *
   * One theme ships; the command exists because the setting does, and saying
   * "that is the only one" is more useful than pretending otherwise.
   */
  private async setTheme(sessionId: string, name: string): Promise<void> {
    const themes = ['kora-dark'];
    if (!name) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'out',
          text: `Themes: ${themes.join(', ')} (current: ${this.state.settings.theme})`,
        }),
      );
      return;
    }
    if (!themes.includes(name)) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: `No theme called "${name}". This build ships ${themes.join(', ')}.`,
        }),
      );
      return;
    }
    await this.updateSettings({ theme: name });
    this.set(pushLine(this.state, sessionId, { t: 'ok', text: `Theme → ${name}.` }));
  }

  /* ---- /accounts ---- */

  private async runAccountCommand(sessionId: string, args: string[]): Promise<void> {
    const s = sessionById(this.state, sessionId);
    if (!s) return;
    const verb = args[0].toLowerCase();
    const rest = args.slice(1);

    try {
      switch (verb) {
        case 'add':
          return await this.accountAdd(sessionId, rest.join(' '));
        case 'login':
          return await this.accountLogin(sessionId, rest.join(' '));
        case 'refresh':
          return await this.accountRefresh(sessionId, rest.join(' '));
        case 'rename':
          return await this.accountRename(sessionId, rest[0] ?? '', rest.slice(1).join(' '));
        case 'remove':
        case 'delete':
          return await this.accountRemove(sessionId, rest.join(' '));
        case 'switch':
          return await this.switchAccount(sessionId, rest.join(' ').toLowerCase());
        default:
          // A bare name is a switch, which is what the mockup's /accounts <name>
          // did and what most uses of this command are.
          return await this.switchAccount(sessionId, args.join(' ').toLowerCase());
      }
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  /** Reloads the account list from the backend into state. */
  private async reloadAccounts(agentId: string): Promise<Account[]> {
    const accounts = await this.bridge.accountsList(agentId);
    this.set({
      ...this.state,
      accounts: [...this.state.accounts.filter((a) => a.agent_id !== agentId), ...accounts],
    });
    return accounts;
  }

  private async accountAdd(sessionId: string, name: string): Promise<void> {
    const s = sessionById(this.state, sessionId)!;
    if (!name.trim()) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'Usage: /accounts add <name>' }));
      return;
    }
    const account = await this.bridge.accountsAdd(s.agentId, name.trim());
    await this.reloadAccounts(s.agentId);
    this.set(
      pushLine(this.state, sessionId, {
        t: 'ok',
        text:
          `Account "${account.name}" created. It has its own profile directory and is not ` +
          `signed in yet — run \`/accounts login ${account.name}\` next.`,
      }),
    );
  }

  /**
   * Signing in is the agent's own interactive flow (it opens a browser), so
   * Kora hands over the exact command rather than driving it — which is also
   * why no credential ever passes through Kora.
   */
  private async accountLogin(sessionId: string, name: string): Promise<void> {
    const s = sessionById(this.state, sessionId)!;
    const account = matchAcct(this.state, s, name.trim().toLowerCase());
    if (!account) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'No such account.' }));
      return;
    }
    const command = await this.bridge.accountsLoginCommand(account.id);
    this.set(
      pushLine(this.state, sessionId, {
        t: 'out',
        text:
          `Run this in a terminal to sign "${account.name}" in:\n\n    ${command}\n\n` +
          'It signs into that account\'s own profile directory — the credential stays with ' +
          `the agent, Kora never sees it. Then run \`/accounts refresh ${account.name}\`.`,
      }),
    );
  }

  private async accountRefresh(sessionId: string, name: string): Promise<void> {
    const s = sessionById(this.state, sessionId)!;
    const accounts = name.trim()
      ? [matchAcct(this.state, s, name.trim().toLowerCase())].filter(Boolean)
      : accountsFor(this.state, s.agentId);
    if (!accounts.length) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'No such account.' }));
      return;
    }

    for (const a of accounts) await this.bridge.accountsRefresh(a!.id);
    const reloaded = await this.reloadAccounts(s.agentId);
    // The session's copy is a snapshot; refresh it too.
    const mine = reloaded.find((a) => a.id === s.account?.id);
    if (mine) this.set(updateSession(this.state, sessionId, (sess) => ({ ...sess, account: mine })));

    this.set(
      pushLine(this.state, sessionId, {
        t: 'ok',
        text: reloaded
          .filter((a) => accounts.some((x) => x!.id === a.id))
          .map((a) => `${a.name} — ${accountSubtitle(a)}`)
          .join('\n'),
      }),
    );
  }

  private async accountRename(sessionId: string, from: string, to: string): Promise<void> {
    const s = sessionById(this.state, sessionId)!;
    const account = matchAcct(this.state, s, from.trim().toLowerCase());
    if (!account || !to.trim()) {
      this.set(
        pushLine(this.state, sessionId, { t: 'err', text: 'Usage: /accounts rename <name> <new name>' }),
      );
      return;
    }
    await this.bridge.accountsRename(account.id, to.trim());
    const reloaded = await this.reloadAccounts(s.agentId);
    const renamed = reloaded.find((a) => a.id === account.id);
    if (renamed) {
      this.set(
        updateSession(this.state, sessionId, (sess) =>
          sess.account?.id === renamed.id ? { ...sess, account: renamed } : sess,
        ),
      );
    }
    this.set(
      pushLine(this.state, sessionId, { t: 'ok', text: `Account renamed → ${to.trim()}.` }),
    );
  }

  /**
   * Removing an account deletes its profile directory, and with it the agent's
   * credentials for that account — so this says so plainly.
   */
  private async accountRemove(sessionId: string, name: string): Promise<void> {
    const s = sessionById(this.state, sessionId)!;
    const account = matchAcct(this.state, s, name.trim().toLowerCase());
    if (!account) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'No such account.' }));
      return;
    }
    await this.bridge.accountsRemove(account.id);
    const reloaded = await this.reloadAccounts(s.agentId);
    const fallback = reloaded[0];
    this.set(
      updateSession(this.state, sessionId, (sess) =>
        sess.account?.id === account.id ? { ...sess, account: fallback } : sess,
      ),
    );
    this.set(
      pushLine(this.state, sessionId, {
        t: 'ok',
        text:
          `Account "${account.name}" removed, along with the profile directory the agent ` +
          'kept its sign-in in. Kora held no credential of its own to delete.',
      }),
    );
  }

  /**
   * Points a session at another account and restarts the agent under it.
   *
   * The conversation cannot come with it: history lives inside the account's own
   * profile directory, so the agent under the new account has never seen it.
   * Kora's transcript stays on screen, and the warning says which is which.
   */
  switchAccount = async (sessionId: string, name: string): Promise<void> => {
    const s = sessionById(this.state, sessionId);
    if (!s) return;
    const account = matchAcct(this.state, s, name);
    if (!account) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'No such account.' }));
      return;
    }
    if (account.id === s.account?.id) {
      this.set(
        pushLine(this.state, sessionId, { t: 'dim', text: `Already on "${account.name}".` }),
      );
      return;
    }

    const hadConversation = Boolean(s.agentUuid) && s.msgs > 0;
    this.set(selectAccount(this.state, sessionId, account));
    await this.bridge.accountsSwitch(s.agentId, account.id).catch(() => {});
    await this.refreshWeek(account.id);

    if (s.status === 'offline') return;
    if (hadConversation) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'warn',
          text:
            'The agent restarts under the new account, and the conversation does not carry ' +
            "over — it lives in the previous account's own profile. This transcript stays here.",
          chips: [{ label: '/session save', cmd: '/session save' }],
        }),
      );
    }

    // A fresh process, with no resume: the new account has never seen the old
    // conversation id.
    await this.bridge.kill(sessionId).catch(() => {});
    this.set(
      updateSession(this.state, sessionId, (sess) => ({
        ...sess,
        status: 'offline',
        agentUuid: undefined,
      })),
    );
    await this.ensureAgent(sessionId);
  };

  /* ---- /session ---- */

  private async runSessionCommand(sessionId: string, args: string[]): Promise<void> {
    const verb = (args[0] ?? 'list').toLowerCase();
    const rest = args.slice(1).join(' ').trim();

    try {
      switch (verb) {
        case 'list':
        case 'all':
          return await this.sessionList(sessionId, verb === 'all' || rest === 'all');
        case 'save':
          return await this.sessionSave(sessionId, rest);
        case 'rename':
          return await this.sessionRename(sessionId, rest);
        case 'delete':
        case 'remove':
          return await this.sessionDelete(sessionId, rest);
        case 'pin':
        case 'unpin':
          return await this.sessionFlag(sessionId, { pinned: verb === 'pin' });
        case 'archive':
        case 'unarchive':
          return await this.sessionFlag(sessionId, { archived: verb === 'archive' });
        case 'export':
          return await this.sessionExport(sessionId, rest);
        case 'import':
          return await this.sessionImport(sessionId, rest);
        case 'open':
          return await this.sessionOpen(sessionId, rest);
        default:
          this.set(
            pushLine(this.state, sessionId, {
              t: 'help',
              agent: 'session',
              common: SESSION_HELP,
              extra: [],
            }),
          );
      }
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  private async sessionList(sessionId: string, includeArchived: boolean): Promise<void> {
    await this.flushSave(sessionId);
    const metas = await this.bridge.sessionsList(includeArchived);
    if (!metas.length) {
      this.set(pushLine(this.state, sessionId, { t: 'dim', text: 'No saved sessions yet.' }));
      return;
    }
    const open = new Set(this.state.sessions.map((s) => s.id));
    this.set(
      pushLine(this.state, sessionId, {
        t: 'list',
        kind: 'sessions',
        title: 'Saved sessions — /session open <name> to bring one back',
        items: metas.map((m) => ({
          id: m.id,
          label: (m.pinned ? '◆ ' : '') + m.name,
          sub: `${m.agent_id} · saved ${new Date(m.updated_at * 1000).toLocaleString()}` +
            (m.archived ? ' · archived' : ''),
          right: open.has(m.id) ? 'open' : '',
          active: m.id === sessionId,
        })),
      }),
    );
  }

  private async sessionSave(sessionId: string, name: string): Promise<void> {
    this.set(
      updateSession(this.state, sessionId, (s) => ({
        ...s,
        ...(name ? { name } : {}),
        // Saving on purpose puts a deleted session back under auto-save.
        unsaved: false,
      })),
    );
    await this.flushSave(sessionId);
    const s = sessionById(this.state, sessionId)!;
    this.set(
      pushLine(this.state, sessionId, {
        t: 'ok',
        text: `Saved "${s.name}" — ${s.lines.length} lines kept locally.`,
      }),
    );
  }

  private async sessionRename(sessionId: string, name: string): Promise<void> {
    if (!name) {
      this.set(
        pushLine(this.state, sessionId, { t: 'err', text: 'Usage: /session rename <name>' }),
      );
      return;
    }
    this.set(updateSession(this.state, sessionId, (s) => ({ ...s, name })));
    await this.flushSave(sessionId);
    this.set(pushLine(this.state, sessionId, { t: 'ok', text: `Session renamed → ${name}.` }));
  }

  private async sessionFlag(
    sessionId: string,
    flags: { pinned?: boolean; archived?: boolean },
  ): Promise<void> {
    this.set(updateSession(this.state, sessionId, (s) => ({ ...s, ...flags })));
    await this.flushSave(sessionId);
    await this.bridge.sessionsSetFlags(sessionId, flags);
    const what = flags.pinned !== undefined ? 'pinned' : 'archived';
    const on = flags.pinned ?? flags.archived;
    this.set(
      pushLine(this.state, sessionId, {
        t: 'ok',
        text: on ? `Session ${what}.` : `Session no longer ${what}.`,
      }),
    );
  }

  /** Deletes a saved session. Naming the open one closes its tab too. */
  private async sessionDelete(sessionId: string, target: string): Promise<void> {
    const metas = await this.bridge.sessionsList(true);
    const meta = target
      ? metas.find((m) => m.id === target || m.name.toLowerCase() === target.toLowerCase())
      : metas.find((m) => m.id === sessionId);
    if (!meta) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'No such saved session.' }));
      return;
    }

    // Stop the auto-save before deleting, or the next appended line writes the
    // record straight back.
    this.set(
      updateSession(this.state, meta.id, (s) => ({ ...s, unsaved: true, createdAt: undefined })),
    );
    await this.bridge.sessionsDelete(meta.id);

    const stillOpen = this.state.sessions.some((s) => s.id === meta.id);
    if (stillOpen && this.state.sessions.length > 1) this.closeTab(meta.id);

    const still = sessionById(this.state, sessionId) ? sessionId : this.state.focusedId;
    this.set(
      pushLine(this.state, still, {
        t: 'ok',
        text:
          `Deleted saved session "${meta.name}".` +
          (sessionById(this.state, meta.id)
            ? ' Its tab stays open but is no longer being saved — /session save keeps it again.'
            : ''),
      }),
    );
  }

  private async sessionExport(sessionId: string, path: string): Promise<void> {
    await this.flushSave(sessionId);
    const file = await this.bridge.sessionsExportFile(sessionId, path || undefined);
    this.set(pushLine(this.state, sessionId, { t: 'ok', text: `Exported to ${file}` }));
  }

  private async sessionImport(sessionId: string, path: string): Promise<void> {
    if (!path) {
      this.set(
        pushLine(this.state, sessionId, { t: 'err', text: 'Usage: /session import <path>' }),
      );
      return;
    }
    const meta = await this.bridge.sessionsImportFile(path);
    this.set(
      pushLine(this.state, sessionId, {
        t: 'ok',
        text: `Imported "${meta.name}". Open it with \`/session open ${meta.name}\`.`,
      }),
    );
  }

  /** Brings a saved session back as a tab, resuming its agent if it can. */
  private async sessionOpen(sessionId: string, target: string): Promise<void> {
    const metas = await this.bridge.sessionsList(true);
    const meta = metas.find(
      (m) => m.id === target || m.name.toLowerCase() === target.toLowerCase(),
    );
    if (!meta) {
      this.set(pushLine(this.state, sessionId, { t: 'err', text: 'No such saved session.' }));
      return;
    }
    if (this.state.sessions.some((s) => s.id === meta.id)) {
      this.focusPane(meta.id);
      return;
    }

    reserveSessionIds([meta.id]);
    const restored = await this.sessionFromMeta(meta);
    if (!restored) {
      this.set(
        pushLine(this.state, sessionId, { t: 'err', text: `Could not read "${meta.name}".` }),
      );
      return;
    }
    this.set({
      ...this.state,
      sessions: [...this.state.sessions, restored],
      focusedId: restored.id,
    });
    await this.ensureAgent(restored.id);
  }

  /** Runs a command without the user typing it (chips, list clicks, hints). */
  runQuick = (cmd: string, sessionId: string = this.state.focusedId): void => {
    if (this.handleProcessCommand(this.state, sessionId, cmd)) return;
    if (this.handleBackendCommand(this.state, sessionId, cmd)) return;
    if (isLocalCommand(this.state, sessionId, cmd)) {
      this.runLocal(this.state, sessionId, cmd);
      return;
    }
    void this.sendToAgent(sessionId, cmd);
  };

  /**
   * Applies a Kora-owned command, then starts an agent for any session it
   * created — `/tab` and `/split` both mint sessions that need a process.
   */
  private runLocal(state: AppState, sessionId: string, raw: string): void {
    const before = new Set(state.sessions.map((s) => s.id));
    this.set(runCommand(state, sessionId, raw));
    for (const s of this.state.sessions) {
      if (!before.has(s.id)) void this.ensureAgent(s.id);
    }
  }

  /** Sends one turn to the agent, echoing it and showing the spinner. */
  private async sendToAgent(sessionId: string, text: string): Promise<void> {
    const session = sessionById(this.state, sessionId);
    if (!session) return;

    const attachments = this.state.attachments;
    const atts = attachments.length;
    let next: AppState = { ...this.state, attachments: [] };
    next = pushLine(next, sessionId, atts ? { t: 'cmd', text, atts } : { t: 'cmd', text });

    if (session.status === 'offline' || session.status === 'dead') {
      this.set(
        pushLine(next, sessionId, {
          t: 'err',
          text:
            session.status === 'dead'
              ? 'The agent process is not running. Respawn it first.'
              : `${agentOf(session).name} is not connected — nothing was sent.`,
          action:
            session.status === 'dead' ? { label: 'respawn agent', cmd: '/respawn' } : undefined,
        }),
      );
      return;
    }

    // `/clear` is the CLI's own command; Kora only needs to know the answer so
    // it can follow with its own tracking (phase 4, acceptance criterion 3).
    if (text.trim().toLowerCase() === '/clear') this.pendingClear.add(sessionId);

    next = pushLine(next, sessionId, { t: 'think', rid: 0 });
    next = updateSession(next, sessionId, (s) => ({
      ...s,
      status: 'busy',
      streamKey: undefined,
    }));
    this.set(next);

    try {
      await this.bridge.write(sessionId, text, wireAttachments(attachments));
    } catch (e) {
      this.set(
        pushLine(this.dropThinking(this.state, sessionId), sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
      this.setStatus(sessionId, 'idle');
    }
  }

  /** Answers a pending tool-permission request. */
  answerPermission = async (
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> => {
    const line = sessionById(this.state, sessionId)?.lines.find(
      (l) => l.t === 'perm' && l.requestId === requestId,
    );
    const tool = line && line.t === 'perm' ? line.tool : '';
    this.set(
      updateSession(this.state, sessionId, (s) => ({
        ...s,
        lines: s.lines.map((l) =>
          l.t === 'perm' && l.requestId === requestId ? { ...l, resolved: decision } : l,
        ),
      })),
    );

    if (decision === 'deny') {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'dim',
          text: 'Denied — the agent was not given permission.',
        }),
      );
      return;
    }

    try {
      // Whatever granting takes — a mode change, a retry turn, or a single
      // control reply — is the adapter's business. The store only reports it.
      const sent = await this.bridge.answerPermission(sessionId, tool, requestId, decision);
      this.set(
        pushLine(this.state, sessionId, {
          t: 'dim',
          text: sent
            ? 'Granted — the agent was asked to continue.'
            : 'Granted.',
        }),
      );
      if (sent) {
        // The adapter sent a retry turn, so show that something is pending
        // rather than a bare "working" pill with an empty transcript.
        this.set(
          updateSession(pushLine(this.state, sessionId, { t: 'think', rid: 0 }), sessionId, (s) => ({
            ...s,
            status: 'busy',
            streamKey: undefined,
          })),
        );
      }
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /** Asks the agent to stop generating. */
  interrupt = async (sessionId: string = this.state.focusedId): Promise<void> => {
    try {
      await this.bridge.interrupt(sessionId);
    } catch {
      /* nothing useful to report; the spinner clears on the next event */
    }
  };

  /** Restarts a dead session, restoring its conversation where possible. */
  respawn = async (sessionId: string = this.state.focusedId): Promise<void> => {
    this.setStatus(sessionId, 'dead');
    await this.ensureAgent(sessionId);
  };

  /* ---- history & completion ---- */

  historyPrev = (): boolean => {
    const s = focusedSession(this.state);
    if (!s.history.length) return false;
    const histIdx =
      this.state.histIdx === null ? s.history.length - 1 : Math.max(0, this.state.histIdx - 1);
    this.set({ ...this.state, histIdx, input: s.history[histIdx] });
    return true;
  };

  historyNext = (): boolean => {
    if (this.state.histIdx === null) return false;
    const s = focusedSession(this.state);
    const idx = this.state.histIdx + 1;
    if (idx >= s.history.length) {
      this.set({ ...this.state, histIdx: null, input: '' });
    } else {
      this.set({ ...this.state, histIdx: idx, input: s.history[idx] });
    }
    return true;
  };

  tabComplete = (): boolean => {
    const { input } = this.state;
    if (!input.startsWith('/') || input.includes(' ')) return false;
    const match = availCmds(focusedSession(this.state)).find((c) =>
      c.startsWith(input.toLowerCase()),
    );
    if (!match) return false;
    this.set({ ...this.state, input: match + ' ' });
    return true;
  };

  escape = (): void => {
    if (this.state.searchOpen) this.closeSearch();
    else if (this.state.input) this.set({ ...this.state, input: '', histIdx: null });
  };

  /* ---- tabs / panes ---- */

  focusPane = (id: string): void => {
    if (this.state.focusedId === id) return;
    this.set({ ...this.state, focusedId: id, histIdx: null });
    // Sessions restored from the local store have no process until they are
    // looked at, so restoring eight tabs does not start eight CLIs.
    const session = sessionById(this.state, id);
    if (session?.status === 'offline' && session.agentUuid) void this.ensureAgent(id);
  };

  /** Opens a tab and starts its agent. */
  newTab = (): void => {
    this.set(newTabFn(this.state));
    void this.ensureAgent(this.state.focusedId);
  };

  /** Closes a tab and kills the process behind it. */
  closeTab = (id: string): void => {
    if (this.state.sessions.length <= 1) return;
    this.set(closeTabFn(this.state, id));
    void this.bridge.kill(id).catch(() => {});
  };

  toggleSplit = (): void => {
    const before = this.state.sessions.length;
    this.set(toggleSplitFn(this.state));
    // Splitting from a single tab creates one, which needs its own process.
    if (this.state.sessions.length > before) void this.ensureAgent(this.state.focusedId);
  };

  /* ---- search overlay ---- */

  toggleSearch = (): void => {
    if (this.state.searchOpen) this.closeSearch();
    else this.set({ ...this.state, searchOpen: true });
  };

  closeSearch = (): void => {
    this.set({
      ...this.state,
      searchOpen: false,
      searchAll: [],
      focusNonce: this.state.focusNonce + 1,
    });
  };

  setSearchQuery = (searchQuery: string): void => {
    // A changed query invalidates where we were, and any cross-session results.
    this.set({ ...this.state, searchQuery, searchIndex: 0, searchAll: [] });
  };

  setSearchMode = (searchMode: SearchMode): void => {
    this.set({ ...this.state, searchMode, searchIndex: 0 });
  };

  /** Moves to the next/previous match, wrapping at the ends. */
  stepSearch = (delta: number): void => {
    const count = findMatches(
      focusedSession(this.state),
      this.state.searchQuery,
      this.state.searchMode,
    ).length;
    if (!count) return;
    this.set({ ...this.state, searchIndex: wrapIndex(this.state.searchIndex + delta, count) });
  };

  /**
   * Widens the search to every saved session.
   *
   * The in-session search never leaves the frontend; this one has to ask the
   * store, because most of what it searches is not open in a tab.
   */
  searchAllSessions = async (): Promise<void> => {
    const query = this.state.searchQuery.trim();
    if (!query) return;
    this.set({ ...this.state, searchingAll: true });
    try {
      const hits = await this.bridge.sessionsSearch(query, 100);
      this.set({ ...this.state, searchAll: hits, searchingAll: false });
    } catch {
      this.set({ ...this.state, searchAll: [], searchingAll: false });
    }
  };

  /** Opens the session a cross-session hit belongs to. */
  openHit = (hit: SearchHit): void => {
    this.set({ ...this.state, searchOpen: false, searchAll: [] });
    void this.runSessionCommand(this.state.focusedId, ['open', hit.session_id]);
  };

  /* ---- attachments ---- */

  /**
   * Attaches a file by path — a drag-and-drop, or a path the user typed.
   *
   * The backend decides what the file is and how much of it may travel; this
   * only reports what came back, including a refusal.
   */
  attachPath = async (path: string, sessionId: string = this.state.focusedId): Promise<void> => {
    try {
      await this.attach(await this.bridge.fileIngest(path), sessionId);
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /**
   * Attaches bytes with no path: a pasted screenshot, or a file chosen through
   * the webview's own picker. Classified by the same backend policy.
   */
  attachBytes = async (
    name: string,
    dataBase64: string,
    mediaType?: string,
    sessionId: string = this.state.focusedId,
  ): Promise<void> => {
    try {
      await this.attach(await this.bridge.fileIngestBytes(name, dataBase64, mediaType), sessionId);
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /** Adds an ingested file to the next prompt, refusing what cannot be sent. */
  private async attach(file: IngestedFile, sessionId: string): Promise<void> {
    const session = sessionById(this.state, sessionId);
    if (!session) return;

    // An agent with no vision capability would simply reject the image, so say
    // so here rather than spending a turn finding out.
    if (file.kind === 'image' && !(await this.canSeeImages(session.agentId))) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: `${agentOf(session).name} does not accept images, so ${file.name} was not attached.`,
        }),
      );
      return;
    }

    const attachment: AttachmentType = {
      id: nextAttachmentId(),
      name: file.name,
      kind: file.kind,
      path: file.path,
      size: file.size,
      mediaType: file.media_type,
      text: file.text ?? undefined,
      data: file.data ?? undefined,
      truncated: file.truncated,
      note: file.note ?? undefined,
    };
    this.set({ ...this.state, attachments: [...this.state.attachments, attachment] });

    // A truncation or a binary is worth saying out loud before the turn goes.
    if (file.note) {
      this.set(pushLine(this.state, sessionId, { t: 'dim', text: file.note }));
    }
  }

  /** Whether this agent accepts images, asked once per agent and cached. */
  private async canSeeImages(agentId: string): Promise<boolean> {
    let caps = this.capabilities.get(agentId);
    if (!caps) {
      caps = await this.bridge.agentCapabilities(agentId).catch(() => [] as Capability[]);
      this.capabilities.set(agentId, caps);
    }
    return caps.includes('vision');
  }

  /** Whether the UI should offer image attachment for the focused session. */
  visionAvailable = (): boolean => {
    const agentId = focusedSession(this.state).agentId;
    const caps = this.capabilities.get(agentId);
    // Unknown until the answer arrives; ask now and assume yes meanwhile, since
    // `attach` re-checks before anything is actually sent.
    if (!caps) {
      void this.canSeeImages(agentId).then(() => this.listeners.forEach((l) => l()));
      return true;
    }
    return caps.includes('vision');
  };

  removeAttachment = (id: string): void => {
    this.set({ ...this.state, attachments: this.state.attachments.filter((a) => a.id !== id) });
  };

  /** Says why something the user offered was not taken. */
  reject = (sessionId: string, message: string): void => {
    this.set(pushLine(this.state, sessionId, { t: 'err', text: message }));
  };

  /* ---- code block actions ---- */

  /** Writes a code block to disk, reporting where it landed. */
  saveBlock = async (
    contents: string,
    path: string,
    sessionId: string = this.state.focusedId,
  ): Promise<void> => {
    try {
      const written = await this.bridge.fileSave(path, contents);
      this.set(pushLine(this.state, sessionId, { t: 'ok', text: `Saved to ${written}` }));
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /** Opens a file in the user's own editor. */
  openInEditor = async (path: string, sessionId: string = this.state.focusedId): Promise<void> => {
    try {
      const ran = await this.bridge.fileOpenInEditor(path);
      this.set(pushLine(this.state, sessionId, { t: 'dim', text: `Opened: ${ran}` }));
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /* ---- list-line clicks ---- */

  pickItem = (kind: ListKind, itemId: string, sessionId: string = this.state.focusedId): void => {
    const before = sessionById(this.state, sessionId);
    if (kind === 'agents') {
      this.set(selectAgent(this.state, sessionId, itemId));
      // A different agent needs a different process.
      if (before && before.agentId !== itemId) {
        void this.bridge.kill(sessionId).catch(() => {});
        this.setStatus(sessionId, 'offline');
        void this.ensureAgent(sessionId);
      }
    } else if (kind === 'accounts') {
      // Clicking an account is a switch, process restart and all.
      void this.switchAccount(sessionId, itemId);
    } else if (kind === 'sessions') {
      void this.runSessionCommand(sessionId, ['open', itemId]);
    } else {
      this.set(selectModel(this.state, sessionId, itemId));
      // The CLI owns model switching, so tell it rather than restarting.
      const after = sessionById(this.state, sessionId);
      if (after && after.status !== 'offline') {
        void this.sendToAgent(sessionId, `/model ${modelOf(after).id}`);
      }
    }
  };

  workspace = (): string => this.state.sessions[0]?.cwd ?? this.cwd ?? this.data.workspace();

  /* ---- settings ---- */

  /** Applies a settings change and persists it, rendering what was stored. */
  updateSettings = async (patch: Partial<Settings>): Promise<void> => {
    const merged = { ...this.state.settings, ...patch };
    // Optimistic, so the UI does not lag a checkbox; corrected below if the
    // backend clamped anything.
    this.set(this.withSettings(this.state, merged));
    try {
      const stored = await this.bridge.settingsSet(merged);
      this.set(this.withSettings(this.state, stored));
    } catch (e) {
      this.set(
        pushLine(this.state, this.state.focusedId, {
          t: 'err',
          text: `Settings could not be saved: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
    }
  };

  /** Mirrors the settings that also live as top-level UI state. */
  private withSettings(state: AppState, settings: Settings): AppState {
    return { ...state, settings, density: settings.density, glow: settings.glow };
  }

  openSettings = (): void => {
    this.set({ ...this.state, settingsOpen: true, paletteOpen: false });
  };

  closeSettings = (): void => {
    this.set({
      ...this.state,
      settingsOpen: false,
      focusNonce: this.state.focusNonce + 1,
    });
  };

  /* ---- command palette ---- */

  togglePalette = (): void => {
    this.set({ ...this.state, paletteOpen: !this.state.paletteOpen });
  };

  closePalette = (): void => {
    this.set({
      ...this.state,
      paletteOpen: false,
      focusNonce: this.state.focusNonce + 1,
    });
  };

  /* ---- notifications ---- */

  /**
   * Raises a notification.
   *
   * The text must be safe to read on a locked screen: it names the session and
   * the condition, never a line of the conversation (phase-6 Security). Kinds
   * the user has switched off never reach the screen at all.
   */
  notify = (toast: Omit<Toast, 'id'>): void => {
    if (!this.state.settings.notifications[toast.kind]) return;
    // One live notification per kind per session: a condition that persists
    // across turns should not stack up.
    const key = `${toast.kind}:${toast.sessionId ?? ''}`;
    if (this.liveToasts.has(key)) return;
    this.liveToasts.add(key);

    const id = nextToastId();
    this.set({ ...this.state, toasts: [...this.state.toasts, { ...toast, id }] });
    this.toastTimers.set(
      id,
      setTimeout(() => this.dismissToast(id), TOAST_MS),
    );
  };

  dismissToast = (id: string): void => {
    const timer = this.toastTimers.get(id);
    if (timer) clearTimeout(timer);
    this.toastTimers.delete(id);

    const toast = this.state.toasts.find((t) => t.id === id);
    if (toast) this.liveToasts.delete(`${toast.kind}:${toast.sessionId ?? ''}`);
    this.set({ ...this.state, toasts: this.state.toasts.filter((t) => t.id !== id) });
  };

  /* ---- version ---- */

  /** Reports the running version, and where a newer one would come from. */
  showVersion = async (sessionId: string = this.state.focusedId): Promise<void> => {
    try {
      const info = await this.bridge.versionInfo();
      this.set(
        pushLine(this.state, sessionId, {
          t: 'out',
          text:
            `Kora ${info.version} (${info.platform})\n` +
            (info.self_update
              ? 'Updates install themselves.'
              : `This build does not update itself — releases are at ${info.releases_url}`),
        }),
      );
    } catch (e) {
      this.set(
        pushLine(this.state, sessionId, {
          t: 'err',
          text: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /* ---- keyboard ---- */

  /**
   * Runs one keymap action.
   *
   * The bindings live in `state/keymap.ts` and the behaviour lives here, so a
   * remap changes one table and nothing else.
   */
  runAction = (id: ActionId): void => {
    const sessionId = this.state.focusedId;
    switch (id) {
      case 'search':
        this.toggleSearch();
        return;
      case 'palette':
        this.togglePalette();
        return;
      case 'settings':
        if (this.state.settingsOpen) this.closeSettings();
        else this.openSettings();
        return;
      case 'clear':
        // The agent's own /clear, like typing it (Phase 4 follows the answer).
        this.runQuick('/clear', sessionId);
        return;
      case 'history':
        this.historyPrev();
        return;
      case 'copy':
        void this.copyLastResponse(sessionId);
        return;
      case 'paste':
        void this.pasteIntoInput();
        return;
      case 'newTab':
        this.newTab();
        return;
      case 'closeTab':
        this.closeTab(sessionId);
        return;
      case 'nextTab':
        this.cycleTab(1);
        return;
      case 'prevTab':
        this.cycleTab(-1);
        return;
      case 'split':
        this.toggleSplit();
        return;
      case 'interrupt':
        void this.interrupt(sessionId);
        return;
      case 'help':
        this.runQuick('/help', sessionId);
    }
  };

  /**
   * Whether an agent error is really an expired sign-in.
   *
   * Matched on the shape of the message because that is all the CLI gives us;
   * being wrong costs a differently-worded notification, nothing more.
   */
  private looksLikeAuth(message: string): boolean {
    return /auth|unauthor|401|credential|logged out|log in|sign in/i.test(message);
  }

  private cycleTab(delta: number): void {
    const { sessions, focusedId } = this.state;
    if (sessions.length < 2) return;
    const i = sessions.findIndex((s) => s.id === focusedId);
    const next = sessions[(i + delta + sessions.length) % sessions.length];
    this.focusPane(next.id);
  }

  /** Copies the most recent response, so the keyboard can reach it. */
  private async copyLastResponse(sessionId: string): Promise<void> {
    const session = sessionById(this.state, sessionId);
    const last = [...(session?.lines ?? [])].reverse().find((l) => l.t === 'resp');
    if (!last || last.t !== 'resp') return;
    const text = [last.text, last.block].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      this.set(pushLine(this.state, sessionId, { t: 'dim', text: 'Copied the last response.' }));
    } catch {
      /* a denied clipboard is not worth an error line */
    }
  }

  private async pasteIntoInput(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.setInput(this.state.input + text);
    } catch {
      /* the OS paste shortcut still works; this is the explicit one */
    }
  }
}

/** Text a line contributes to scrollback search. */
export function lineText(l: TranscriptLine): string {
  const parts: string[] = [];
  if ('text' in l && typeof l.text === 'string') parts.push(l.text);
  // A fenced block is part of the conversation, and is exactly the kind of
  // thing people search for — Phase 1 searched only the prose above it.
  if (l.t === 'resp' && l.block) parts.push(l.block);
  if (l.t === 'out' || l.t === 'err') return parts.join('\n');
  return parts.join('\n');
}

/**
 * Attachments in the shape the backend expects.
 *
 * A binary is sent as a line of text naming it: the agent can read it with its
 * own tools, and Kora does not pretend to have decoded something it cannot.
 */
export function wireAttachments(attachments: AttachmentType[]): WireAttachment[] {
  return attachments.map((a) => {
    if (a.kind === 'image' && a.data) {
      return { kind: 'image', name: a.name, media_type: a.mediaType, data: a.data };
    }
    return {
      kind: 'text',
      name: a.name,
      path: a.path,
      text: a.text ?? `(binary file, ${a.size} bytes — read it from disk if you need it)`,
      truncated: a.truncated,
    };
  });
}

export const store = new SessionStore();
