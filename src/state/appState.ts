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

/** Universal commands plus whatever this session's agent adds, de-duplicated. */
export function availCmds(s: Session): string[] {
  return [...new Set([...COMMON, ...agentOf(s).extra])];
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
    msgs: 0,
    history: [],
    suggested: false,
    lines: [{ key: nextLineKey(), t: 'banner' }],
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

/* ---------------- initial (Phase 1 seeded) state ---------------- */

/**
 * Seeded two-session state matching the design mockup screenshot. Phase 3 loads
 * real persisted sessions here instead.
 */
export function initialState(): AppState {
  const s1 = mkSession('claude');
  const s2 = mkSession('codex');

  s1.lines = [
    { key: nextLineKey(), t: 'banner' },
    { key: nextLineKey(), t: 'cmd', text: 'why do my sessions never log out?' },
    {
      key: nextLineKey(),
      t: 'resp',
      text: 'Traced it to src/auth/session.ts:88 — the refresh timer is never cleared on logout, so tokens keep minting after sign-out. Cleanup below.',
      block:
        '  useEffect(() => {\n    const id = setInterval(refresh, 5*60_000)\n-   return\n+   return () => clearInterval(id)\n  }, [session.id])',
      lang: 'diff',
      tool: 'edited src/auth/session.ts · +1 −1',
    },
    { key: nextLineKey(), t: 'cmd', text: 'fix it and run the auth tests' },
    {
      key: nextLineKey(),
      t: 'resp',
      text: 'Applied the cleanup and re-ran the auth suite — 41 passed, 0 failed. Logout now revokes the timer and clears the refresh token.',
      tool: 'bash · npm test src/auth — 41 passing',
    },
    {
      key: nextLineKey(),
      t: 'warn',
      text: 'Context is at 76% of the 200k window. Older turns are inflating every request. Run /compact to summarize, or /clear to start fresh.',
      chips: [
        { label: '/compact', cmd: '/compact' },
        { label: '/clear', cmd: '/clear' },
      ],
    },
  ];
  s1.ctxUsed = 152000;
  s1.sessIn = 119000;
  s1.sessOut = 33000;
  s1.msgs = 6;
  s1.suggested = true;

  s2.lines = [
    { key: nextLineKey(), t: 'banner' },
    { key: nextLineKey(), t: 'cmd', text: 'add rate-limit headers to the gateway' },
    {
      key: nextLineKey(),
      t: 'resp',
      text: 'Done. Pulled the duplicated pagination into usePaginated() and updated all three call sites. Types check clean.',
      block:
        'export function usePaginated<T>(rows: T[], size = 20) {\n  const [page, setPage] = useState(0)\n  const slice = rows.slice(page*size, page*size+size)\n  return { page, setPage, slice }\n}',
      lang: 'ts',
      tool: 'created src/hooks/usePaginated.ts',
    },
  ];
  s2.ctxUsed = 41000;
  s2.sessIn = 32000;
  s2.sessOut = 9000;
  s2.msgs = 2;

  return {
    sessions: [s1, s2],
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
