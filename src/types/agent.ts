/**
 * Core data contract for Kora.
 *
 * These shapes are a *contract*, not mock-only conveniences: the Phase 2 Rust
 * adapter layer and the Phase 3 accounts/usage layer must emit exactly these.
 * Never widen a type just to make a mock fixture fit — change the fixture.
 */

/** A model exposed by an agent. */
export interface Model {
  id: string;
  name: string;
  /** Context window size in tokens. */
  win: number;
  /** The agent's own one-line description, when it reports one. */
  desc?: string;
}

/** A coding agent CLI that Kora can wrap. */
export interface Agent {
  id: string;
  name: string;
  vendor: string;
  /** Hex accent color, drives --ac / --glow when this agent is focused. */
  accent: string;
  models: Model[];
  /** Commands this agent adds on top of the universal set. */
  extra: string[];
}

/**
 * Who is signed in to an account, as the agent itself reported it.
 *
 * Mirrors `AccountIdentity` in `src-tauri/src/adapters/mod.rs`. Deliberately
 * carries nothing secret: Kora never holds a credential, so there is no key to
 * mask here — the Phase 3 spike replaced the mockup's masked-key field with
 * real identity.
 */
export interface AccountIdentity {
  logged_in: boolean;
  /** e.g. `"claude.ai"` for a subscription login, `"apiKey"` for a key. */
  auth_method: string;
  email: string | null;
  org_name: string | null;
  /** e.g. `"pro"`, `"max"`. Absent for API-key auth. */
  subscription: string | null;
}

/**
 * One account for an agent: a profile directory the agent authenticates into.
 *
 * Mirrors `Account` in `src-tauri/src/accounts/mod.rs`, field for field, so the
 * Tauri payload needs no translation.
 */
export interface Account {
  id: string;
  agent_id: string;
  name: string;
  /** Profile directory. A path, never a secret. */
  dir: string;
  identity: AccountIdentity | null;
}

/** Rolling usage Kora itself recorded — NOT an authoritative plan quota. */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  /** What the agent said it cost, summed. `null` when it reported none. */
  cost_usd: number | null;
  /** List-price equivalent for these tokens; not spend on a subscription. */
  estimated_cost_usd: number | null;
  turns: number;
}

/* ---------------- transcript lines ---------------- */

export type LineType =
  | 'banner'
  | 'cmd'
  | 'resp'
  | 'out'
  | 'dim'
  | 'ok'
  | 'err'
  | 'think'
  | 'warn'
  | 'list'
  | 'help'
  | 'panel'
  /** Added in Phase 2: the agent is asking to use a tool. */
  | 'perm';

/** How the user answered a tool-permission request. */
export type PermissionDecision = 'allow' | 'deny';

/**
 * What approving a permission actually grants.
 *
 * Agents differ in how narrowly they can grant, so the UI labels the approve
 * button from this rather than promising something the agent cannot deliver.
 */
export type PermissionScope = 'once' | 'session_edits' | 'session_all';

export interface QuickChip {
  label: string;
  cmd: string;
}

export interface ListItem {
  id: string;
  label: string;
  sub: string;
  /** Right-aligned meta text. */
  right?: string;
  active: boolean;
  /** Hex dot color; falls back to a plain accent/idle dot when absent. */
  dot?: string;
}

export type ListKind = 'agents' | 'accounts' | 'models' | 'sessions';

export interface HelpEntry {
  c: string;
  d: string;
}

/** `cost` is deliberately absent: `/cost` is the agent's own command. */
export type PanelKind = 'usage' | 'stats';

export interface PanelData {
  ctxUsed: number;
  ctxWin: number;
  ctxPct: number;
  sessIn: number;
  sessOut: number;
  msgs: number;
  cacheRead: number;
  /** Real cost reported by the agent; `null` when it reports none. */
  cost: number | null;
  acctName: string;
  plan: string;
  /**
   * Whether `cost` is an API-equivalent estimate rather than spend.
   *
   * True for subscription accounts, which are billed a flat fee — the panel
   * must never present a per-token figure as what they actually pay.
   */
  costEstimated: boolean;
  /** Real quota utilization 0–1, or `null` when the agent exposes none. */
  utilization: number | null;
  /** Which window the utilization covers, e.g. "seven_day". */
  window: string | null;
  /** Kora's own rolling 7-day record for this account, or `null` if untracked. */
  week: UsageTotals | null;
  model: string;
  avgIn?: number;
  avgOut?: number;
}

interface LineBase {
  /** Stable key for React; assigned at push time. */
  key: string;
}

export interface BannerLine extends LineBase {
  t: 'banner';
}
export interface CmdLine extends LineBase {
  t: 'cmd';
  text: string;
  /** Number of attachments sent with this prompt. */
  atts?: number;
}
export interface RespLine extends LineBase {
  t: 'resp';
  text: string;
  block?: string;
  lang?: string;
  tool?: string;
  /** Tool calls made while producing this response. */
  tools?: string[];
  /** True while text is still streaming in, so the UI can show a caret. */
  streaming?: boolean;
}
export interface OutLine extends LineBase {
  t: 'out';
  text: string;
}
export interface DimLine extends LineBase {
  t: 'dim';
  text: string;
}
export interface OkLine extends LineBase {
  t: 'ok';
  text: string;
}
export interface ErrLine extends LineBase {
  t: 'err';
  text: string;
  /** "did you mean" suggestion. */
  hint?: string | null;
  /** A one-click recovery, e.g. respawning a crashed agent. */
  action?: { label: string; cmd: string };
}
export interface ThinkLine extends LineBase {
  t: 'think';
  /** Request id, so the matching response can remove this exact spinner. */
  rid: number;
}
export interface WarnLine extends LineBase {
  t: 'warn';
  text: string;
  chips: QuickChip[];
}
export interface ListLine extends LineBase {
  t: 'list';
  kind: ListKind;
  title: string;
  items: ListItem[];
}
export interface HelpLine extends LineBase {
  t: 'help';
  agent: string;
  common: HelpEntry[];
  extra: HelpEntry[];
}
export interface PanelLine extends LineBase {
  t: 'panel';
  kind: PanelKind;
  data: PanelData;
}
export interface PermLine extends LineBase {
  t: 'perm';
  /** The agent's id for the tool call being asked about. */
  requestId: string;
  tool: string;
  detail: string;
  /** What approving would cover. */
  scope: PermissionScope;
  /** Set once answered, which freezes the chips into a record of the answer. */
  resolved?: PermissionDecision;
}

export type TranscriptLine =
  | BannerLine
  | CmdLine
  | RespLine
  | OutLine
  | DimLine
  | OkLine
  | ErrLine
  | ThinkLine
  | WarnLine
  | ListLine
  | HelpLine
  | PanelLine
  | PermLine;

/** A line before it gets its React key — what command handlers construct. */
export type NewLine =
  | Omit<BannerLine, 'key'>
  | Omit<CmdLine, 'key'>
  | Omit<RespLine, 'key'>
  | Omit<OutLine, 'key'>
  | Omit<DimLine, 'key'>
  | Omit<OkLine, 'key'>
  | Omit<ErrLine, 'key'>
  | Omit<ThinkLine, 'key'>
  | Omit<WarnLine, 'key'>
  | Omit<ListLine, 'key'>
  | Omit<HelpLine, 'key'>
  | Omit<PanelLine, 'key'>
  | Omit<PermLine, 'key'>;

/* ---------------- session ---------------- */

export interface Attachment {
  id: string;
  name: string;
}

/** Whether a session's agent process is up, and what it is doing. */
export type SessionStatus =
  /** No process, and none attempted (agent has no real adapter). */
  | 'offline'
  /** Spawn in flight. */
  | 'starting'
  /** Process up, waiting for input. */
  | 'idle'
  /** Process up, generating. */
  | 'busy'
  /** Process died unexpectedly; a respawn is offered. */
  | 'dead';

/** Config the wrapped CLI picks up from the workspace on its own. */
export interface WorkspaceInfo {
  /** Ready-to-print labels for config files found, supplied by the adapter. */
  labels: string[];
  mcpServers: number;
}

/** Rolling quota the agent reports, when it exposes one. */
export interface RateLimit {
  window: string;
  /** 0–1. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number | null;
}

/** One tab, and the agent process behind it. */
export interface Session {
  id: string;
  /** Display-only process id. Phase 2 replaces this with the real pid. */
  pid: string;
  name: string;
  agentId: string;
  /** The account this session runs under. Absent until one is configured. */
  account?: Account;
  modelId: string;
  ctxWin: number;
  ctxUsed: number;
  sessIn: number;
  sessOut: number;
  /** Cache-read tokens the agent reported, accumulated. */
  cacheRead: number;
  msgs: number;
  history: string[];
  /** True once the context warning has fired, so it fires only once per climb. */
  suggested: boolean;
  lines: TranscriptLine[];

  /* ---- Phase 2: the live process behind this tab ---- */

  status: SessionStatus;
  /** The agent's own conversation id, used to resume after a crash. */
  agentUuid?: string;
  /** Directory the agent process runs in. */
  cwd?: string;
  /** Key of the `resp` line currently being streamed into, if any. */
  streamKey?: string;
  /** Config the wrapped CLI inherited from the workspace. */
  workspace?: WorkspaceInfo;
  /** Real cumulative cost reported by the agent, in USD. */
  costUsd?: number;
  /** Real quota utilization reported by the agent. */
  rateLimit?: RateLimit;
  /** Slash commands the agent itself provides, learned at handshake. */
  agentCommands?: HelpEntry[];
  /** Models the live CLI reported at handshake. Beats any hardcoded list. */
  models?: Model[];

  /* ---- Phase 3: the persisted record behind this tab ---- */

  /** Kept out of the way of the archive sweep, and listed first. */
  pinned?: boolean;
  archived?: boolean;
  /** Unix seconds; set when the session was first persisted. */
  createdAt?: number;
  /**
   * Set when the user deleted this session's saved record while its tab stayed
   * open: the transcript is still on screen, but auto-save stops until they ask
   * for it again with `/session save`.
   */
  unsaved?: boolean;
}

export type Density = 'comfortable' | 'compact';
