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
  agentOf,
  availCmds,
  focusedSession,
  initialState,
  modelOf,
  nextAttachmentId,
  pushLine,
  sessionById,
  updateSession,
} from './appState';
import {
  checkContext,
  closeTab as closeTabFn,
  isLocalCommand,
  newTab as newTabFn,
  runCommand,
  selectAccount,
  selectAgent,
  selectModel,
  toggleSplit as toggleSplitFn,
} from './commandRouter';
import { mockDataSource, type DataSource } from './mockFixtures';
import { defaultBridge, type AgentBridge, type AgentEvent } from './agentBridge';
import type {
  Density,
  ListKind,
  PermissionDecision,
  Session,
  TranscriptLine,
} from '../types/agent';

type Listener = () => void;

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
  private disposed = false;

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
    this.state = next;
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
    await this.ensureAgent(this.state.focusedId);
  };

  /** Stops listening and kills every agent process. */
  dispose = async (): Promise<void> => {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const ids = this.state.sessions.map((s) => s.id);
    this.listeners.clear();
    await Promise.all(ids.map((id) => this.bridge.kill(id).catch(() => {})));
  };

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
    const resumeUuid = session.status === 'dead' ? session.agentUuid : undefined;

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
        this.attachTool(sessionId, event.detail);
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
        this.set(
          pushLine(this.state, sessionId, {
            t: 'ok',
            text: 'Context compacted by the agent — earlier turns were summarized.',
          }),
        );
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

  /** Records a tool call against the response it belongs to. */
  private attachTool(sessionId: string, detail: string): void {
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
            ? { ...l, tools: [...(l.tools ?? []), detail] }
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
        costUsd: usage.total_cost_usd && usage.total_cost_usd > 0 ? usage.total_cost_usd : s.costUsd,
      };
    });

    this.set(checkContext(next, sessionId));
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

  /** Runs a command without the user typing it (chips, list clicks, hints). */
  runQuick = (cmd: string, sessionId: string = this.state.focusedId): void => {
    if (this.handleProcessCommand(this.state, sessionId, cmd)) return;
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

    const atts = this.state.attachments.length;
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

    next = pushLine(next, sessionId, { t: 'think', rid: 0 });
    next = updateSession(next, sessionId, (s) => ({
      ...s,
      status: 'busy',
      streamKey: undefined,
    }));
    this.set(next);

    try {
      await this.bridge.write(sessionId, text);
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
    this.set({ ...this.state, searchOpen: false, focusNonce: this.state.focusNonce + 1 });
  };

  setSearchQuery = (searchQuery: string): void => {
    this.set({ ...this.state, searchQuery });
  };

  /* ---- attachments (Phase 5 makes these real files) ---- */

  addAttachment = (name: string): void => {
    this.set({
      ...this.state,
      attachments: [...this.state.attachments, { id: nextAttachmentId(), name }],
    });
  };

  addPlaceholderAttachment = (prefix: 'screenshot' | 'pasted'): void => {
    this.addAttachment(`${prefix}-${this.state.attachments.length + 1}.png`);
  };

  removeAttachment = (id: string): void => {
    this.set({ ...this.state, attachments: this.state.attachments.filter((a) => a.id !== id) });
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
      this.set(selectAccount(this.state, sessionId, itemId));
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
}

/** Text a line contributes to scrollback search. */
export function lineText(l: TranscriptLine): string {
  return 'text' in l && typeof l.text === 'string' ? l.text : '';
}

export const store = new SessionStore();
