/**
 * Session/tab/pane store.
 *
 * Holds `AppState`, applies the pure reducers in `commandRouter`, and owns the
 * only impure parts of Phase 1: timers for the simulated agent round-trip and
 * random canned responses. Phase 2 replaces `runPrompt` with real PTY writes +
 * streamed output events; nothing else in this file should need to change.
 */

import type { AppState } from './appState';
import {
  availCmds,
  focusedSession,
  initialState,
  nextAttachmentId,
  pushLine,
  sessionById,
  updateSession,
} from './appState';
import {
  checkContext,
  closeTab as closeTabFn,
  newTab as newTabFn,
  runCommand,
  selectAccount,
  selectAgent,
  selectModel,
  toggleSplit as toggleSplitFn,
} from './commandRouter';
import { estTok } from './format';
import { mockDataSource, type DataSource } from './mockFixtures';
import type { Density, ListKind } from '../types/agent';

type Listener = () => void;

export class SessionStore {
  private state: AppState;
  private listeners = new Set<Listener>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private rid = 0;
  private data: DataSource;

  constructor(initial: AppState = initialState(), data: DataSource = mockDataSource) {
    this.state = initial;
    this.data = data;
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

  /** Cancels pending simulated responses — call on teardown. */
  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.listeners.clear();
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /* ---- input ---- */

  setInput = (v: string): void => {
    this.set({ ...this.state, input: v });
  };

  /** Drops a command into the input and returns focus there (help rows, palette). */
  fillInput = (cmd: string): void => {
    this.set({ ...this.state, input: cmd + ' ', focusNonce: this.state.focusNonce + 1 });
  };

  setDensity = (density: Density): void => {
    this.set({ ...this.state, density });
  };

  setGlow = (glow: boolean): void => {
    this.set({ ...this.state, glow });
  };

  /** Enter. Slash commands route synchronously; prose starts a mock round-trip. */
  submit = (): void => {
    const text = this.state.input.trim();
    if (!text) return;
    const id = this.state.focusedId;

    let next = updateSession(this.state, id, (s) => ({ ...s, history: [...s.history, text] }));
    next = { ...next, input: '', histIdx: null };

    if (text.startsWith('/')) {
      this.set(runCommand(next, id, text));
    } else {
      this.set(this.startPrompt(next, id, text));
    }
  };

  /**
   * Runs a command without the user typing it (chips, list clicks, suggestion).
   * `sessionId` is the pane the control lives in — in split view that is not
   * necessarily the focused pane, and the result must land where it was clicked.
   */
  runQuick = (cmd: string, sessionId: string = this.state.focusedId): void => {
    this.set(runCommand(this.state, sessionId, cmd));
  };

  private startPrompt(state: AppState, id: string, text: string): AppState {
    const atts = state.attachments.length;
    let next: AppState = { ...state, attachments: [] };
    next = pushLine(next, id, atts ? { t: 'cmd', text, atts } : { t: 'cmd', text });

    const rid = ++this.rid;
    next = pushLine(next, id, { t: 'think', rid });

    // Phase 1 estimate only — Phase 3 uses usage reported by the agent process.
    const inTok = estTok(text) + atts * 1180 + 420;

    this.later(() => this.finishPrompt(id, rid, inTok), 650 + Math.random() * 900);
    return next;
  }

  private finishPrompt(id: string, rid: number, inTok: number): void {
    const s = sessionById(this.state, id);
    if (!s) return;

    const r = this.data.sampleResponse();
    const outTok = 220 + Math.floor(Math.random() * 470);

    let next = updateSession(this.state, id, (sess) => ({
      ...sess,
      lines: sess.lines.filter((l) => !(l.t === 'think' && l.rid === rid)),
      sessIn: sess.sessIn + inTok,
      sessOut: sess.sessOut + outTok,
      ctxUsed: sess.ctxUsed + inTok + outTok,
      msgs: sess.msgs + 1,
    }));
    next = pushLine(next, id, { t: 'resp', ...r });
    this.set(checkContext(next, id));
  }

  /* ---- history & completion ---- */

  /** Returns whether history moved, so the caller knows to swallow the key. */
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

  /** Tab-completes a partial `/cmd` to the first match. */
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

  /** Escape: closes search first, then clears a non-empty input. */
  escape = (): void => {
    if (this.state.searchOpen) this.closeSearch();
    else if (this.state.input) this.set({ ...this.state, input: '', histIdx: null });
  };

  /* ---- tabs / panes ---- */

  focusPane = (id: string): void => {
    if (this.state.focusedId === id) return;
    this.set({ ...this.state, focusedId: id, histIdx: null });
  };

  newTab = (): void => {
    this.set(newTabFn(this.state));
  };

  closeTab = (id: string): void => {
    this.set(closeTabFn(this.state, id));
  };

  toggleSplit = (): void => {
    this.set(toggleSplitFn(this.state));
  };

  /* ---- search overlay ---- */

  toggleSearch = (): void => {
    if (this.state.searchOpen) this.closeSearch();
    else this.set({ ...this.state, searchOpen: true });
  };

  /** Closing hands focus back to the command input via `focusNonce`. */
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
    const id = sessionId;
    if (kind === 'agents') this.set(selectAgent(this.state, id, itemId));
    else if (kind === 'accounts') this.set(selectAccount(this.state, id, itemId));
    else this.set(selectModel(this.state, id, itemId));
  };

  workspace = (): string => this.data.workspace();
}

export const store = new SessionStore();
