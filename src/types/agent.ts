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

/** One credential/subscription for an agent. Phase 3 backs this with the keychain. */
export interface Account {
  id: string;
  name: string;
  plan: string;
  /** Masked credential reference. A raw secret must never reach this type. */
  key: string;
  /** Rolling usage Kora itself recorded — NOT authoritative plan quota. */
  wUsed: number;
  wLim: number;
  unit: string;
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

export type ListKind = 'agents' | 'accounts' | 'models';

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
  /** Real quota utilization 0–1, or `null` when the agent exposes none. */
  utilization: number | null;
  /** Which window the utilization covers, e.g. "seven_day". */
  window: string | null;
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
  accountId: string;
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
}

export type Density = 'comfortable' | 'compact';
