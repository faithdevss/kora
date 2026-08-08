/**
 * The settings panel.
 *
 * Every control writes straight through to the backend, which clamps anything
 * unreasonable and returns what it stored — so what is rendered here is always
 * the saved value, not the requested one. There is deliberately nothing here
 * that could hold a credential: accounts are profile directories the agent owns
 * (Phase 3), managed through `/accounts`.
 */

import { useEffect, useRef } from 'react';
import type { Agent, Model, Settings } from '../types/agent';
import { DEFAULT_KEYMAP, displayChord } from '../state/keymap';

interface Props {
  settings: Settings;
  agents: Agent[];
  /** Models of the currently focused session's agent, as it reported them. */
  models: Model[];
  version: string;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="k-set-row">
      <span className="k-set-label">
        {label}
        {hint ? <span className="k-set-hint">{hint}</span> : null}
      </span>
      <span className="k-set-control">{children}</span>
    </label>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={'k-toggle' + (on ? ' is-on' : '')}
      onClick={() => onChange(!on)}
    >
      <span className="k-toggle-knob" />
    </button>
  );
}

export function SettingsPanel(props: Props) {
  const { settings } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="k-palette-backdrop" onClick={props.onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label="Settings"
        className="k-settings kscroll"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
        }}
      >
        <div className="k-settings-head">
          <span className="k-settings-title">settings</span>
          <span className="k-settings-version">Kora {props.version}</span>
          <button type="button" className="k-search-close" title="Close" onClick={props.onClose}>
            ×
          </button>
        </div>

        <section className="k-settings-group">
          <h3 className="k-settings-h">appearance</h3>

          <Row label="theme" hint="one ships today; the setting is here so a second needs no migration">
            <select
              className="k-select"
              value={settings.theme}
              onChange={(e) => props.onChange({ theme: e.target.value })}
            >
              <option value="kora-dark">Kora Dark</option>
            </select>
          </Row>

          <Row label="font size">
            <input
              className="k-range"
              type="range"
              min={9}
              max={24}
              step={0.5}
              value={settings.fontSize}
              onChange={(e) => props.onChange({ fontSize: Number(e.target.value) })}
            />
            <span className="k-set-value">{settings.fontSize}px</span>
          </Row>

          <Row label="font" hint="blank uses the bundled JetBrains Mono">
            <input
              className="k-text"
              value={settings.fontFamily}
              placeholder="JetBrains Mono"
              onChange={(e) => props.onChange({ fontFamily: e.target.value })}
            />
          </Row>

          <Row label="density">
            <select
              className="k-select"
              value={settings.density}
              onChange={(e) =>
                props.onChange({ density: e.target.value === 'compact' ? 'compact' : 'comfortable' })
              }
            >
              <option value="comfortable">comfortable</option>
              <option value="compact">compact</option>
            </select>
          </Row>

          <Row label="accent glow">
            <Toggle on={settings.glow} onChange={(glow) => props.onChange({ glow })} />
          </Row>

          <Row label="status bar">
            <Toggle on={settings.statusBar} onChange={(statusBar) => props.onChange({ statusBar })} />
          </Row>
        </section>

        <section className="k-settings-group">
          <h3 className="k-settings-h">defaults</h3>

          <Row label="agent" hint="what a new session starts under">
            <select
              className="k-select"
              value={settings.defaultAgent}
              onChange={(e) => props.onChange({ defaultAgent: e.target.value })}
            >
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Row>

          <Row label="model" hint="as the running CLI reports them">
            <select
              className="k-select"
              value={settings.defaultModel ?? ''}
              onChange={(e) => props.onChange({ defaultModel: e.target.value || null })}
            >
              <option value="">the agent's own default</option>
              {props.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Row>

          <Row
            label="account"
            hint="accounts are the agent's own sign-ins — manage them with /accounts"
          >
            <span className="k-set-value">/accounts</span>
          </Row>
        </section>

        <section className="k-settings-group">
          <h3 className="k-settings-h">context</h3>

          <Row
            label="auto-compact"
            hint="past 90%, ask the agent to compact instead of only suggesting it"
          >
            <Toggle
              on={settings.autoCompact}
              onChange={(autoCompact) => props.onChange({ autoCompact })}
            />
          </Row>
        </section>

        <section className="k-settings-group">
          <h3 className="k-settings-h">notifications</h3>
          <p className="k-settings-note">
            Notifications name the session and the condition — never a line of the conversation.
          </p>

          {(
            [
              ['context', 'nearing the context limit'],
              ['usage', 'usage limit reached'],
              ['auth', 'authentication expired'],
              ['errors', 'request failed'],
              ['updates', 'update available'],
            ] as const
          ).map(([key, label]) => (
            <Row key={key} label={label}>
              <Toggle
                on={settings.notifications[key]}
                onChange={(v) =>
                  props.onChange({ notifications: { ...settings.notifications, [key]: v } })
                }
              />
            </Row>
          ))}
        </section>

        <section className="k-settings-group">
          <h3 className="k-settings-h">keyboard</h3>
          <p className="k-settings-note">
            Bindings live in one keymap; remapping is not in this build.
          </p>
          <div className="k-keymap">
            {DEFAULT_KEYMAP.map((b) => (
              <div key={b.id} className="k-keymap-row">
                <span className="k-keymap-label">{b.label}</span>
                <span className="k-keymap-chord">{displayChord(b.keys)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
