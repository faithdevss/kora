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
  TranscriptLine,
} from '../types/agent';
import { ACCOUNTS, AGENTS, COMMON } from './mockFixtures';

export interface AppState {
  sessions: Session[];
  focusedId: string;
  splitOn: boolean;
  input: string;
  attachments: Attachment[];
  searchOpen: boolean;
  searchQuery: string;
  /** Position in the focused session's history while arrowing through it. */
  histIdx: number | null;
  /** Bumped whenever focus should return to the command input (search closed). */
  focusNonce: number;
  density: Density;
  glow: boolean;
}

/* ---------------- id generation ---------------- */

let sid = 0;
let pid = 4820;
let lineKey = 0;
let attKey = 0;

/** Test-only: makes id sequences deterministic across cases. */
export function __resetIds(): void {
  sid = 0;
  pid = 4820;
  lineKey = 0;
  attKey = 0;
}

export function nextLineKey(): string {
  return 'l' + ++lineKey;
}

export function nextAttachmentId(): string {
  return 'a' + ++attKey;
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

export function acctOf(s: Session): Account {
  const list = ACCOUNTS[s.agentId] ?? [];
  return list.find((a) => a.id === s.accountId) ?? list[0];
}

export function modelOf(s: Session): Model {
  const models = agentOf(s).models;
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
 * New session. `inheritFrom` carries the focused tab's agent + account onto the
 * new tab (deliberate deviation from the prototype, which always used Claude —
 * see phase-1 scope notes).
 */
export function mkSession(agentId: string, accountId?: string): Session {
  const ag = agentById(agentId);
  const m = ag.models[0];
  const accounts = ACCOUNTS[agentId] ?? [];
  const acct = accounts.find((a) => a.id === accountId) ?? accounts[0];
  return {
    id: 's' + ++sid,
    pid: '#' + ++pid,
    name: ag.name.split(' ')[0].toLowerCase(),
    agentId,
    accountId: acct?.id ?? '',
    modelId: m.id,
    ctxWin: m.win,
    ctxUsed: 1400,
    sessIn: 0,
    sessOut: 0,
    cacheRead: 0,
    msgs: 0,
    history: [],
    suggested: false,
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
 * A single empty Claude session. Phase 1's seeded fake transcript is gone —
 * from Phase 2 on, every line in a session came from a real agent process.
 * Phase 3 restores persisted sessions here instead.
 */
export function initialState(): AppState {
  const s1 = mkSession('claude');
  return {
    sessions: [s1],
    focusedId: s1.id,
    splitOn: false,
    input: '',
    attachments: [],
    searchOpen: false,
    searchQuery: '',
    histIdx: null,
    focusNonce: 0,
    density: 'comfortable',
    glow: true,
  };
}
