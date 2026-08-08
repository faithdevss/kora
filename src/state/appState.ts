/**
 * App state shape + pure helpers. Everything here is immutable: helpers return
 * new state, never mutate. Keeps the command router unit-testable without React.
 */

import type {
  Account,
  Agent,
  Attachment,
  Density,
  Model,
  NewLine,
  Session,
  Settings,
  Toast,
  TranscriptLine,
  UsageTotals,
} from '../types/agent';
import { AGENTS, COMMON } from './mockFixtures';
import type { SearchHit } from './agentBridge';
import type { SearchMode } from './search';

export interface AppState {
  sessions: Session[];
  focusedId: string;
  splitOn: boolean;
  input: string;
  attachments: Attachment[];
  searchOpen: boolean;
  searchQuery: string;
  /** How `searchQuery` is interpreted. */
  searchMode: SearchMode;
  /** Which match the viewport is parked on, for next/prev. */
  searchIndex: number;
  /** Hits from other saved sessions, when the search was widened to all. */
  searchAll: SearchHit[];
  /** True while a cross-session search is in flight. */
  searchingAll: boolean;
  /** Position in the focused session's history while arrowing through it. */
  histIdx: number | null;
  /** Bumped whenever focus should return to the command input (search closed). */
  focusNonce: number;
  density: Density;
  glow: boolean;

  /* ---- Phase 3 ---- */

  /** Every account Kora knows about, across agents. Loaded from the backend. */
  accounts: Account[];
  /** Kora's own rolling seven-day record, keyed by account id. */
  week: Record<string, UsageTotals>;

  /* ---- Phase 6 ---- */

  /** User settings, loaded from the backend on start. */
  settings: Settings;
  /** Notifications currently on screen, newest last. */
  toasts: Toast[];
  /** Whether the global command palette is open. */
  paletteOpen: boolean;
  /** Whether the settings panel is open. */
  settingsOpen: boolean;
  /** Running version, read from the backend on start. */
  version: string;
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

/* ---------------- id generation ---------------- */

let sid = 0;
let pid = 4820;
let lineKey = 0;
let attKey = 0;
let toastKey = 0;

/** Test-only: makes id sequences deterministic across cases. */
export function __resetIds(): void {
  sid = 0;
  pid = 4820;
  lineKey = 0;
  attKey = 0;
  toastKey = 0;
}

/**
 * Moves the session-id counter past ids that already exist.
 *
 * Ids are minted per app run (`s1`, `s2`, …) but persisted sessions outlive the
 * run, so without this a restored `s2` and a freshly opened tab would collide
 * and overwrite each other in the local store.
 */
export function reserveSessionIds(ids: string[]): void {
  for (const id of ids) {
    const n = /^s(\d+)$/.exec(id);
    if (n) sid = Math.max(sid, Number(n[1]));
  }
}

export function nextLineKey(): string {
  return 'l' + ++lineKey;
}

export function nextAttachmentId(): string {
  return 'a' + ++attKey;
}

export function nextToastId(): string {
  return 'n' + ++toastKey;
}

/* ---------------- lookups ---------------- */

export function agentById(id: string): Agent {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent: ${id}`);
  return a;
}

export function agentOf(s: Session): Agent {
  return agentById(s.agentId);
}

/** The account this session runs under, if one is configured. */
export function acctOf(s: Session): Account | undefined {
  return s.account;
}

/** Accounts configured for a session's agent. */
export function accountsFor(state: AppState, agentId: string): Account[] {
  return state.accounts.filter((a) => a.agent_id === agentId);
}

/**
 * Models this session can switch to.
 *
 * A live CLI reports its real list at handshake, which is what we use. The
 * static catalogue is only a placeholder for agents with no process yet — the
 * Phase 3 spike found the fixture two model generations out of date.
 */
export function modelsOf(s: Session): Model[] {
  return s.models?.length ? s.models : agentOf(s).models;
}

export function modelOf(s: Session): Model {
  const models = modelsOf(s);
  return models.find((m) => m.id === s.modelId) ?? models[0];
}

/**
 * Universal commands plus whatever this session's agent adds, de-duplicated.
 *
 * Once a live agent has reported its real command list at handshake, that wins
 * over the static fixture — so the palette, tab-complete and `/help` all agree
 * with what the agent will actually accept.
 */
export function availCmds(s: Session): string[] {
  const fromAgent = s.agentCommands?.length
    ? s.agentCommands.map((c) => c.c)
    : agentOf(s).extra;
  return [...new Set([...COMMON, ...fromAgent])];
}

export function sessionById(state: AppState, id: string): Session | undefined {
  return state.sessions.find((s) => s.id === id);
}

export function focusedSession(state: AppState): Session {
  return sessionById(state, state.focusedId) ?? state.sessions[0];
}

/* ---------------- construction ---------------- */

/**
 * New session. `account` carries the focused tab's account onto the new tab
 * (deliberate deviation from the prototype, which always used Claude — see
 * phase-1 scope notes); the store corrects it from the spawn result if the
 * backend's active account differs.
 */
export function mkSession(agentId: string, account?: Account): Session {
  const ag = agentById(agentId);
  const m = ag.models[0];
  return {
    id: 's' + ++sid,
    pid: '#' + ++pid,
    name: ag.name.split(' ')[0].toLowerCase(),
    agentId,
    account: account?.agent_id === agentId ? account : undefined,
    modelId: m.id,
    ctxWin: m.win,
    // Nothing has been sent yet, so nothing is in context. The agent's first
    // turn reports the real figure, system prompt and all.
    ctxUsed: 0,
    sessIn: 0,
    sessOut: 0,
    cacheRead: 0,
    msgs: 0,
    history: [],
    lines: [{ key: nextLineKey(), t: 'banner' }],
    // No process until the store spawns one; agents without a real adapter
    // stay here permanently.
    status: 'offline',
  };
}

export function withKey(line: NewLine): TranscriptLine {
  return { ...line, key: nextLineKey() } as TranscriptLine;
}

/* ---------------- immutable updates ---------------- */

export function updateSession(
  state: AppState,
  id: string,
  fn: (s: Session) => Session,
): AppState {
  return {
    ...state,
    sessions: state.sessions.map((s) => (s.id === id ? fn(s) : s)),
  };
}

/** Append one line to a session's transcript. */
export function pushLine(state: AppState, id: string, line: NewLine): AppState {
  return updateSession(state, id, (s) => ({ ...s, lines: [...s.lines, withKey(line)] }));
}

/* ---------------- initial state ---------------- */

/**
 * A single empty Claude session.
 *
 * Accounts and any persisted sessions are loaded asynchronously by the store on
 * start, so this is what Kora shows for the moment before that lands.
 */
export function initialState(): AppState {
  const s1 = mkSession('claude');
  return {
    sessions: [s1],
    accounts: [],
    week: {},
    settings: defaultSettings(),
    toasts: [],
    paletteOpen: false,
    settingsOpen: false,
    version: '',
    focusedId: s1.id,
    splitOn: false,
    input: '',
    attachments: [],
    searchOpen: false,
    searchQuery: '',
    searchMode: 'plain',
    searchIndex: 0,
    searchAll: [],
    searchingAll: false,
    histIdx: null,
    focusNonce: 0,
    density: 'comfortable',
    glow: true,
  };
}
