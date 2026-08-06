import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { store as defaultStore, lineText, type SessionStore } from './state/sessionStore';
import { agentOf, availCmds, focusedSession, sessionById } from './state/appState';
import { paneIds } from './state/commandRouter';
import { TitleBar } from './components/TitleBar';
import { TabBar } from './components/TabBar';
import { StatusBar } from './components/StatusBar';
import { SplitView } from './components/SplitView';
import { Pane, type PaneActions } from './components/Pane';
import { SearchOverlay } from './components/SearchOverlay';
import { paletteMatches } from './components/CommandPalette';
import { countMatches } from './components/Highlight';

/** `store` is injectable so tests get a fresh one instead of the app singleton. */
export default function App({ store = defaultStore }: { store?: SessionStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  // Connects to the backend and starts the first agent. The store guards
  // against double-starting, which StrictMode's double-mount would otherwise do.
  useEffect(() => {
    void store.start();
  }, [store]);
  const focused = focusedSession(state);
  const accent = agentOf(focused).accent;

  const actions: PaneActions = useMemo(
    () => ({
      runQuick: (sessionId, cmd) => store.runQuick(cmd, sessionId),
      pickItem: (sessionId, kind, itemId) => store.pickItem(kind, itemId, sessionId),
      fillInput: store.fillInput,
      answerPermission: (sessionId, requestId, decision) =>
        void store.answerPermission(sessionId, requestId, decision),
    }),
    [store],
  );

  const matches = paletteMatches(state.input, availCmds(focused));

  // Occurrences, not matching lines — the prototype counted lines, but a
  // per-occurrence count is what Phase 5's real scrollback search will report.
  const matchCount = state.searchQuery
    ? focused.lines.reduce((n, l) => n + countMatches(lineText(l), state.searchQuery), 0)
    : 0;

  const query = state.searchOpen && state.searchQuery ? state.searchQuery : undefined;

  const ids = paneIds(state);

  return (
    <div
      className={'k-root' + (state.density === 'compact' ? ' density-compact' : '')}
      style={
        {
          // Chrome (title bar, tabs, status bar, search) follows the focused
          // agent. Each pane overrides these with its own agent's accent.
          '--ac': accent,
          '--ac-dim': accent + '22',
          '--ac-soft': accent + '12',
          '--ac-edge': accent + '66',
          '--glow': state.glow ? `0 0 10px ${accent}88` : 'none',
        } as React.CSSProperties
      }
    >
      <TitleBar
        workspace={store.workspace()}
        onSearch={store.toggleSearch}
        onToggleSplit={store.toggleSplit}
        splitOn={state.splitOn}
      />

      <TabBar
        sessions={state.sessions}
        focusedId={state.focusedId}
        onSelect={store.focusPane}
        onClose={store.closeTab}
        onNewTab={store.newTab}
      />

      <StatusBar session={focused} onSuggest={store.runQuick} />

      <SplitView>
        {ids.map((id) => {
          const s = sessionById(state, id);
          if (!s) return null;
          const isFocused = id === state.focusedId;
          return (
            <Pane
              key={id}
              session={s}
              focused={isFocused}
              glow={state.glow}
              query={query}
              actions={actions}
              onFocus={() => store.focusPane(id)}
              input={{
                focusToken: `${id}:${state.focusNonce}`,
                value: state.input,
                matches,
                attachments: state.attachments,
                onChange: store.setInput,
                onSubmit: store.submit,
                onEscape: store.escape,
                onTabComplete: store.tabComplete,
                onHistoryPrev: store.historyPrev,
                onHistoryNext: store.historyNext,
                onPickCmd: store.fillInput,
                onAttach: () => store.addPlaceholderAttachment('screenshot'),
                onPasteImage: () => store.addPlaceholderAttachment('pasted'),
                onRemoveAttachment: store.removeAttachment,
              }}
            />
          );
        })}
      </SplitView>

      {state.searchOpen ? (
        <SearchOverlay
          query={state.searchQuery}
          matchCount={matchCount}
          onChange={store.setSearchQuery}
          onClose={store.closeSearch}
        />
      ) : null}
    </div>
  );
}
