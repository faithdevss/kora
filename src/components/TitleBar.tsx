/**
 * Window chrome. macOS draws the real traffic lights over this bar
 * (`titleBarStyle: "Overlay"` in tauri.conf.json), so the left inset is
 * reserved for them rather than the mockup's decorative dots.
 */

interface Props {
  workspace: string;
  onSearch: () => void;
  onToggleSplit: () => void;
  splitOn: boolean;
}

export function TitleBar({ workspace, onSearch, onToggleSplit, splitOn }: Props) {
  return (
    <div className="k-titlebar" data-tauri-drag-region>
      <div className="k-titlebar-left" data-tauri-drag-region>
        <span className="k-logo-mark" />
        <span className="k-logo-text">kora</span>
      </div>
      <div className="k-titlebar-path" data-tauri-drag-region>
        {workspace}
      </div>
      <div className="k-titlebar-actions">
        {/* No ⌘F binding yet — global shortcuts land in Phase 6. */}
        <button type="button" className="k-icon-btn" title="Search scrollback" onClick={onSearch}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
        </button>
        <button
          type="button"
          className={'k-icon-btn' + (splitOn ? ' is-on' : '')}
          title="Split view"
          onClick={onToggleSplit}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="7" height="16" rx="1" />
            <rect x="14" y="4" width="7" height="16" rx="1" />
          </svg>
        </button>
        <button type="button" className="k-icon-btn is-disabled" title="Settings (Phase 6)" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" y1="8" x2="20" y2="8" />
            <circle cx="9" cy="8" r="2.4" fill="#0d0e11" />
            <line x1="4" y1="16" x2="20" y2="16" />
            <circle cx="15" cy="16" r="2.4" fill="#0d0e11" />
          </svg>
        </button>
      </div>
    </div>
  );
}
