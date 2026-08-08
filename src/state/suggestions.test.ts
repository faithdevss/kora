import { describe, expect, it } from 'vitest';
import { __resetIds, mkSession } from './appState';
import { suggestions } from './suggestions';
import type { Session } from '../types/agent';

/** A live Claude session with a 200k window and nothing yet in it. */
function sess(over: Partial<Session> = {}): Session {
  __resetIds();
  return { ...mkSession('claude'), ctxWin: 200000, status: 'idle', ...over };
}

function ids(s: Session): string[] {
  return suggestions(s).map((x) => x.id);
}

describe('suggestions', () => {
  it('says nothing about a fresh session', () => {
    expect(suggestions(sess())).toEqual([]);
  });

  it('never invents a suggestion from data the agent has not reported', () => {
    // No usage, no cost, no quota: the engine has nothing to go on and says so
    // by staying quiet, rather than nudging on principle.
    const s = sess({ ctxUsed: 1000, msgs: 1, costUsd: undefined, rateLimit: undefined });
    expect(suggestions(s)).toEqual([]);
  });

  it('offers only real commands, never a Kora-side edit of the conversation', () => {
    const s = sess({ ctxUsed: 190000, msgs: 40, cacheRead: 90000, sessIn: 100000, costUsd: 5 });
    const cmds = suggestions(s).flatMap((x) => x.chips.map((c) => c.cmd));
    for (const cmd of cmds) {
      // `/compact` and `/clear` are the agent's own; the rest are Kora UI
      // actions. Nothing here rewrites conversation content.
      expect(['/compact', '/clear', '/tab', '/accounts', '/models']).toContain(cmd.split(' ')[0]);
    }
  });

  describe('context', () => {
    it('raises the informational threshold at 70%', () => {
      expect(ids(sess({ ctxUsed: 139000 }))).toEqual([]);
      expect(ids(sess({ ctxUsed: 140000 }))).toEqual(['context-high']);
    });

    it('replaces it with the urgent one at 90%, rather than showing both', () => {
      expect(ids(sess({ ctxUsed: 181000 }))).toEqual(['context-urgent']);
    });

    it('reports the real percentage in the informational copy', () => {
      const [tip] = suggestions(sess({ ctxUsed: 150000 }));
      expect(tip.text).toContain('75%');
    });
  });

  describe('quota', () => {
    it('speaks up only once the agent reports the window nearly used', () => {
      const near = sess({
        rateLimit: { window: 'seven_day', utilization: 0.93, resetsAt: null },
      });
      expect(ids(near)).toContain('quota-near');
      expect(suggestions(near).find((x) => x.id === 'quota-near')!.text).toContain('93%');

      const fine = sess({
        rateLimit: { window: 'seven_day', utilization: 0.4, resetsAt: null },
      });
      expect(ids(fine)).not.toContain('quota-near');
    });
  });

  describe('cheaper model', () => {
    const models = [
      { id: 'opus', name: 'Opus 5', win: 200000 },
      { id: 'sonnet', name: 'Sonnet 5', win: 200000 },
    ];

    it('suggests one only when the session has really cost something', () => {
      expect(ids(sess({ models, modelId: 'opus', costUsd: 0.2 }))).not.toContain('cheaper-model');
      expect(ids(sess({ models, modelId: 'opus', costUsd: 4 }))).toContain('cheaper-model');
    });

    it('never suggests trading down from the cheapest model on offer', () => {
      expect(ids(sess({ models, modelId: 'sonnet', costUsd: 40 }))).not.toContain('cheaper-model');
    });

    it('points at a model the agent actually reported', () => {
      const tip = suggestions(sess({ models, modelId: 'opus', costUsd: 4 })).find(
        (x) => x.id === 'cheaper-model',
      )!;
      expect(tip.chips[0].cmd).toBe('/models sonnet');
      expect(tip.text).toContain('Sonnet 5');
    });
  });

  describe('long session', () => {
    it('suggests a fresh tab only while context is still healthy', () => {
      // With context already high, the context banner is the useful advice.
      expect(ids(sess({ msgs: 40, ctxUsed: 150000 }))).not.toContain('long-session');
      expect(ids(sess({ msgs: 40, ctxUsed: 20000 }))).toContain('long-session');
    });
  });

  describe('cache', () => {
    it('is an observation with no action attached', () => {
      const tip = suggestions(sess({ sessIn: 100000, cacheRead: 80000 })).find(
        (x) => x.id === 'cache-working',
      )!;
      expect(tip.chips).toEqual([]);
      expect(tip.text).toContain('80%');
    });

    it('stays quiet when the cache is barely being used', () => {
      expect(ids(sess({ sessIn: 100000, cacheRead: 1000 }))).not.toContain('cache-working');
    });
  });
});
