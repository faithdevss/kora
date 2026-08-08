/**
 * How an account reads in the UI.
 *
 * The mockup showed a masked key (`sk-ant-••••7f2a`) here. There is no key to
 * mask: an account is a profile directory the agent authenticates into, and the
 * only thing Kora knows about it is the identity the agent reported back. These
 * helpers mirror `Account::subtitle`/`plan` in `src-tauri/src/accounts/mod.rs`.
 */

import type { Account, UsageTotals } from '../types/agent';

/** Whether a per-token dollar figure would misrepresent what this account pays. */
export function isSubscription(a: Account | undefined): boolean {
  const id = a?.identity;
  if (!id) return false;
  return id.subscription !== null || id.auth_method === 'claude.ai';
}

/** The plan label the UI shows, and cost honesty depends on. */
export function accountPlan(a: Account | undefined): string {
  const id = a?.identity;
  if (!id) return 'not signed in';
  if (isSubscription(a)) return id.subscription ? `Claude ${id.subscription}` : 'subscription';
  if (id.logged_in) return `${id.auth_method} account`;
  return 'not signed in';
}

/** The second line in an account list — identity, where the mockup had a key. */
export function accountSubtitle(a: Account): string {
  const id = a.identity;
  if (!id) return 'not signed in yet — /accounts login ' + a.name;
  if (!id.logged_in) return `signed out — /accounts login ${a.name}`;
  const who = id.email ?? 'signed in';
  if (id.subscription) return `${who}  ·  Claude ${id.subscription}`;
  if (id.org_name) return `${who}  ·  ${id.org_name}`;
  return who;
}

/** Total tokens Kora recorded in a window. */
export function totalTokens(t: UsageTotals): number {
  return t.input_tokens + t.output_tokens + t.cache_read + t.cache_write;
}
