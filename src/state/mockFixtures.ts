/**
 * Agent / command catalogue.
 *
 * Phase 2 removed the canned response fixtures; Phase 3 removed the mock
 * accounts, which are now real profile directories held by the backend, and the
 * per-agent model lists are only a placeholder for agents with no live process
 * (a running CLI reports its own — the fixture below is two model generations
 * stale for Claude, which is exactly why it is not trusted).
 *
 * Originally ported 1:1 from the design prototype
 * (`docs/design/Kora Terminal.dc.html`: AGENTS / ACCT / CMD_DESC / COMMON).
 */

import type { Agent } from '../types/agent';

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

export const CMD_DESC: Record<string, string> = {
  '/help': 'list every command',
  '/agents': 'switch coding agent',
  '/users': 'switch account',
  '/accounts': 'switch account',
  '/models': 'switch model',
  '/usage': 'session & weekly usage',
  '/statistics': 'session statistics',
  '/session': 'save, list & restore sessions',
  '/settings': 'open settings',
  '/theme': 'switch theme',
  '/version': 'which Kora this is',
  '/update': 'check for a newer Kora',
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
  '/session',
  '/settings',
  '/version',
  '/compact',
  '/clear',
  '/search',
  '/split',
  '/tab',
];

/** Workspace shown in the title bar. Phase 2 replaces this with the real cwd. */
export const WORKSPACE = '~/workspace/api-gateway';

/**
 * The live-data seam.
 *
 * Phase 3 emptied most of it: accounts now come from the backend account store
 * and models from the running CLI, so only the catalogue of agents Kora can
 * offer and the pre-spawn workspace label are still local.
 */
export interface DataSource {
  agents(): Agent[];
  /** Fallback workspace label, replaced by the real cwd once an agent spawns. */
  workspace(): string;
}

export const mockDataSource: DataSource = {
  agents: () => AGENTS,
  workspace: () => WORKSPACE,
};
