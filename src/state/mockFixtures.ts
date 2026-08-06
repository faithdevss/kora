/**
 * Agent / account / command catalogue.
 *
 * Phase 2 removed the canned response fixtures — transcript content now comes
 * from a real agent process. What remains is the static catalogue the UI needs
 * before any process exists. Accounts stay mock until Phase 3 backs them with
 * the keychain.
 *
 * Originally ported 1:1 from the design prototype
 * (`docs/design/Kora Terminal.dc.html`: AGENTS / ACCT / CMD_DESC / COMMON).
 *
 * This module is the ONLY place mock data lives, so Phase 2/3 have a single
 * swap point. Static catalogue data (`AGENTS`, `ACCOUNTS`, `CMD_DESC`, `COMMON`)
 * is still imported directly by the state layer — the shapes are the contract,
 * not the import path. What must NOT be reached into directly is anything that
 * becomes live/asynchronous later: those go through `DataSource` below.
 */

import type { Account, Agent } from '../types/agent';

export const AGENTS: Agent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    accent: '#d97757',
    vendor: 'Anthropic',
    models: [
      { id: 'opus', name: 'claude-opus-4.1', win: 200000 },
      { id: 'sonnet', name: 'claude-sonnet-4.5', win: 200000 },
      { id: 'haiku', name: 'claude-haiku-4', win: 200000 },
    ],
    extra: ['/cost', '/review', '/memory', '/init'],
  },
  {
    id: 'codex',
    name: 'Codex',
    accent: '#19c37d',
    vendor: 'OpenAI',
    models: [
      { id: 'gpt5c', name: 'gpt-5-codex', win: 272000 },
      { id: 'gpt5', name: 'gpt-5', win: 272000 },
      { id: 'o4', name: 'o4-mini', win: 128000 },
    ],
    extra: ['/model', '/approvals', '/diff'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    accent: '#4587f5',
    vendor: 'Google',
    models: [
      { id: 'pro', name: 'gemini-2.5-pro', win: 1000000 },
      { id: 'flash', name: 'gemini-2.5-flash', win: 1000000 },
    ],
    extra: ['/tools', '/mcp', '/memory'],
  },
  {
    // Permanently UI-stub — see master plan "Scope Adjustments". Selectable so the
    // adapter list stays future-proof, but no real integration is planned.
    id: 'cursor',
    name: 'Cursor Agent',
    accent: '#9b8cff',
    vendor: 'Anysphere',
    models: [
      { id: 'composer', name: 'composer-1', win: 200000 },
      { id: 'sonnet', name: 'claude-sonnet-4.5', win: 200000 },
      { id: 'gpt5', name: 'gpt-5', win: 272000 },
    ],
    extra: ['/edit', '/apply', '/rules'],
  },
  {
    id: 'aider',
    name: 'Aider',
    accent: '#e8a33d',
    vendor: 'open source',
    models: [
      { id: 'sonnet', name: 'claude-sonnet-4.5', win: 200000 },
      { id: 'gpt5', name: 'gpt-5', win: 272000 },
      { id: 'ds', name: 'deepseek-v3', win: 128000 },
    ],
    extra: ['/add', '/drop', '/diff', '/architect'],
  },
  {
    id: 'generic',
    name: 'Custom Agent',
    accent: '#8a94a6',
    vendor: 'user-defined',
    models: [{ id: 'm', name: 'custom-model', win: 128000 }],
    extra: [],
  },
];

export const ACCOUNTS: Record<string, Account[]> = {
  claude: [
    { id: 'c1', name: 'personal', plan: 'Claude Max 20×', key: 'sk-ant-••••7f2a', wUsed: 3.2, wLim: 10, unit: 'M tok' },
    { id: 'c2', name: 'work', plan: 'Team seat', key: 'sk-ant-••••c19d', wUsed: 22.6, wLim: 40, unit: 'M tok' },
  ],
  codex: [
    { id: 'o1', name: 'personal', plan: 'ChatGPT Pro', key: 'sk-••••9a1', wUsed: 1.1, wLim: 5, unit: 'M tok' },
    { id: 'o2', name: 'startup', plan: 'API pay-go', key: 'sk-••••4d2', wUsed: 0.4, wLim: 2, unit: 'M tok' },
  ],
  gemini: [
    { id: 'g1', name: 'gmail', plan: 'AI Pro', key: 'AIza••••k29', wUsed: 0.8, wLim: 3, unit: 'M tok' },
    { id: 'g2', name: 'workspace', plan: 'Enterprise', key: 'AIza••••p57', wUsed: 5.3, wLim: 25, unit: 'M tok' },
  ],
  cursor: [
    { id: 'u1', name: 'pro', plan: 'Cursor Pro', key: 'cur_••••8823', wUsed: 410, wLim: 500, unit: 'req' },
    { id: 'u2', name: 'business', plan: 'Business seat', key: 'cur_••••1f04', wUsed: 120, wLim: 1000, unit: 'req' },
  ],
  aider: [
    { id: 'a1', name: 'byo-anthropic', plan: 'API key', key: 'sk-ant-••••aa0', wUsed: 1.9, wLim: 10, unit: 'M tok' },
  ],
  generic: [
    { id: 'x1', name: 'default', plan: 'env credential', key: 'env:API_KEY', wUsed: 0, wLim: 1, unit: 'M tok' },
  ],
};

export const CMD_DESC: Record<string, string> = {
  '/help': 'list every command',
  '/agents': 'switch coding agent',
  '/users': 'switch account',
  '/accounts': 'switch account',
  '/models': 'switch model',
  '/usage': 'session & weekly usage',
  '/statistics': 'session statistics',
  '/clear': 'clear the context',
  '/compact': 'summarize & shrink context',
  '/search': 'search the scrollback',
  '/split': 'toggle split view',
  '/tab': 'open a new session',
  '/cost': 'estimated cost this session',
  '/review': 'review the pending diff',
  '/memory': 'view project memory',
  '/init': 'scan & initialise project',
  '/model': 'switch model',
  '/approvals': 'set approval mode',
  '/diff': 'show the working diff',
  '/tools': 'list available tools',
  '/mcp': 'connected MCP servers',
  '/edit': 'edit a file',
  '/apply': 'apply suggested edits',
  '/rules': 'project rules',
  '/add': 'add a file to context',
  '/drop': 'drop a file from context',
  '/architect': 'architect (plan) mode',
};

/** Universal commands available under every agent. */
export const COMMON = [
  '/help',
  '/agents',
  '/users',
  '/accounts',
  '/models',
  '/usage',
  '/statistics',
  '/compact',
  '/clear',
  '/search',
  '/split',
  '/tab',
];

/** Workspace shown in the title bar. Phase 2 replaces this with the real cwd. */
export const WORKSPACE = '~/workspace/api-gateway';

/**
 * The live-data seam. Every member here is backed by something real in a later
 * phase (agent process output, keychain-stored accounts, the actual cwd), so no
 * call site may bypass it. Phase 2/3 provide a real implementation.
 */
export interface DataSource {
  agents(): Agent[];
  accountsFor(agentId: string): Account[];
  /** Fallback workspace label, replaced by the real cwd once an agent spawns. */
  workspace(): string;
}

export const mockDataSource: DataSource = {
  agents: () => AGENTS,
  accountsFor: (agentId) => ACCOUNTS[agentId] ?? [],
  workspace: () => WORKSPACE,
};
