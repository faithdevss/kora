/**
 * The global command palette (`⌘⇧P`).
 *
 * Distinct from the `/`-prefixed palette above the input, which completes what
 * you are typing. This one is always reachable and searches everything Kora can
 * do from a keyboard: commands, agents, models, sessions, settings
 * (`docs/features.gpt.md` §20).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../state/appState';
import { accountsFor, agentOf, availCmds, focusedSession, modelsOf } from '../state/appState';
import { CMD_DESC } from '../state/mockFixtures';
import { DEFAULT_KEYMAP, displayChord } from '../state/keymap';
import { lineMatches } from '../state/search';

export type PaletteGroup = 'command' | 'agent' | 'model' | 'account' | 'session' | 'setting';

export interface PaletteEntry {
  id: string;
  group: PaletteGroup;
  label: string;
  hint: string;
  /** Shortcut to show on the right, when the entry has one. */
  chord?: string;
  run: () => void;
}

interface Props {
  state: AppState;
  /** Runs a slash command on the focused session. */
  onRun: (cmd: string) => void;
  onOpenSettings: () => void;
  onFocusSession: (id: string) => void;
  onAction: (id: string) => void;
  onClose: () => void;
}

const GROUP_LABEL: Record<PaletteGroup, string> = {
  command: 'command',
  agent: 'agent',
  model: 'model',
  account: 'account',
  session: 'session',
  setting: 'settings',
};

/** Everything the palette can offer, in the order it offers it. */
export function paletteEntries(props: Props): PaletteEntry[] {
  const { state, onRun, onOpenSettings, onFocusSession, onAction } = props;
  const focused = focusedSession(state);
  const out: PaletteEntry[] = [];

  // Keyboard actions first: the palette is also how you discover them.
  for (const binding of DEFAULT_KEYMAP) {
    out.push({
      id: `action:${binding.id}`,
      group: 'command',
      label: binding.label,
      hint: 'shortcut',
      chord: binding.keys,
      run: () => onAction(binding.id),
    });
  }

  for (const cmd of availCmds(focused)) {
    out.push({
      id: `cmd:${cmd}`,
      group: 'command',
      label: cmd,
      hint: CMD_DESC[cmd] ?? 'agent command',
      run: () => onRun(cmd),
    });
  }

  for (const agent of state.sessions.length ? [agentOf(focused)] : []) {
    // Models come from the live CLI when it has reported them (Phase 3).
    for (const model of modelsOf(focused)) {
      out.push({
        id: `model:${model.id}`,
        group: 'model',
        label: model.name,
        hint: `switch ${agent.name} to this model`,
        run: () => onRun(`/models ${model.id}`),
      });
    }
  }

  for (const account of accountsFor(state, focused.agentId)) {
    out.push({
      id: `account:${account.id}`,
      group: 'account',
      label: account.name,
      hint: 'switch account — the conversation restarts',
      run: () => onRun(`/accounts ${account.name}`),
    });
  }

  for (const session of state.sessions) {
    out.push({
      id: `session:${session.id}`,
      group: 'session',
      label: session.name,
      hint: session.id === state.focusedId ? 'current session' : 'go to this session',
      run: () => onFocusSession(session.id),
    });
  }

  out.push({
    id: 'setting:open',
    group: 'setting',
    label: 'Settings',
    hint: 'theme, font, defaults, notifications',
    chord: 'Mod+,',
    run: onOpenSettings,
  });

  return out;
}

export function GlobalCommandPalette(props: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const entries = useMemo(() => paletteEntries(props), [props]);
  const matches = useMemo(() => {
    if (!query.trim()) return entries;
    // Fuzzy, like the scrollback search: typing "acsw" should find
    // "switch account".
    return entries.filter(
      (e) =>
        lineMatches(`${e.label} ${e.hint}`, query, 'fuzzy') ||
        lineMatches(`${e.label} ${e.hint}`, query, 'plain'),
    );
  }, [entries, query]);

  const current = matches[Math.min(index, matches.length - 1)];

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      props.onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (matches.length ? (i + 1) % matches.length : 0));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!current) return;
      props.onClose();
      current.run();
    }
  }

  return (
    <div className="k-palette-backdrop" onClick={props.onClose}>
      <div
        className="k-gpalette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="k-gpalette-input"
          value={query}
          placeholder="Commands, agents, models, sessions, settings…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="k-gpalette-list kscroll">
          {matches.length ? (
            matches.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                className={'k-gpalette-item' + (entry === current ? ' is-on' : '')}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  props.onClose();
                  entry.run();
                }}
              >
                <span className="k-gpalette-group">{GROUP_LABEL[entry.group]}</span>
                <span className="k-gpalette-label">{entry.label}</span>
                <span className="k-gpalette-hint">{entry.hint}</span>
                {entry.chord ? (
                  <span className="k-gpalette-chord">{displayChord(entry.chord)}</span>
                ) : null}
              </button>
            ))
          ) : (
            <div className="k-gpalette-empty">nothing matches “{query}”</div>
          )}
        </div>
      </div>
    </div>
  );
}
