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
  | 'panel';

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

export type PanelKind = 'usage' | 'stats' | 'cost';

export interface PanelData {
  ctxUsed: number;
  ctxWin: number;
  ctxPct: number;
  sessIn: number;
  sessOut: number;
  msgs: number;
  cacheRead: number;
  cost: number;
  acctName: string;
  plan: string;
  wUsed: number;
  wLim: number;
  unit: string;
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
  | PanelLine;

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
  | Omit<PanelLine, 'key'>;

/* ---------------- session ---------------- */

export interface Attachment {
  id: string;
  name: string;
}

/** One tab. In Phase 2 this gains a live PTY handle; the shape here stays. */
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
  msgs: number;
  history: string[];
  /** True once the context warning has fired, so it fires only once per climb. */
  suggested: boolean;
  lines: TranscriptLine[];
}

export type Density = 'comfortable' | 'compact';
