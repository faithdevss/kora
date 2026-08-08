/**
 * Every keyboard shortcut in Kora, in one table.
 *
 * Two reasons this is a table rather than handlers scattered through
 * components: the global listener can then work from anywhere in the app
 * (`docs/features.gpt.md` §21 asks for exactly that), and a future Settings
 * remap has one place to write to.
 *
 * Bindings are written with `Mod`, which is ⌘ on macOS and Ctrl elsewhere —
 * the shortcuts the docs list as `Ctrl+…` are what a Mac user expects under ⌘.
 */

export type Chord = string;

/** What a binding does. Kept as an intent, so the store owns the behaviour. */
export type ActionId =
  | 'search'
  | 'palette'
  | 'clear'
  | 'history'
  | 'copy'
  | 'paste'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'split'
  | 'settings'
  | 'interrupt'
  | 'help';

export interface Binding {
  id: ActionId;
  /** e.g. `Mod+K`, `Mod+Shift+P`. Modifier order does not matter. */
  keys: Chord;
  /** Shown in the palette and the settings panel. */
  label: string;
  /**
   * Whether the binding fires while the user is typing in a text field.
   *
   * Most do not: `Mod+K` should still work from the input, but a bare letter
   * never should, and neither should anything the field itself needs.
   */
  inInput?: boolean;
}

/** True on macOS, where `Mod` means ⌘. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * The default bindings.
 *
 * The five the docs name explicitly (§21) come first; the rest are the ones a
 * tabbed terminal is expected to have.
 */
export const DEFAULT_KEYMAP: Binding[] = [
  { id: 'search', keys: 'Mod+K', label: 'Search this session', inInput: true },
  { id: 'clear', keys: 'Mod+L', label: 'Clear the context', inInput: true },
  { id: 'history', keys: 'Mod+R', label: 'Command history', inInput: true },
  { id: 'copy', keys: 'Mod+Shift+C', label: 'Copy the last response', inInput: true },
  { id: 'paste', keys: 'Mod+Shift+V', label: 'Paste into the prompt', inInput: true },

  { id: 'palette', keys: 'Mod+Shift+P', label: 'Command palette', inInput: true },
  { id: 'settings', keys: 'Mod+,', label: 'Settings', inInput: true },
  { id: 'newTab', keys: 'Mod+T', label: 'New session', inInput: true },
  { id: 'closeTab', keys: 'Mod+W', label: 'Close session', inInput: true },
  { id: 'nextTab', keys: 'Mod+Alt+Right', label: 'Next session', inInput: true },
  { id: 'prevTab', keys: 'Mod+Alt+Left', label: 'Previous session', inInput: true },
  { id: 'split', keys: 'Mod+D', label: 'Toggle split view', inInput: true },
  { id: 'interrupt', keys: 'Mod+.', label: 'Stop generating', inInput: true },
  { id: 'help', keys: 'Mod+/', label: 'Show help', inInput: true },
];

/** The chord a keyboard event represents, in the same shape as a binding. */
export function chordOf(e: KeyboardEvent, mac = isMac()): Chord {
  const parts: string[] = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  // The non-Mod control key still distinguishes bindings on either platform.
  if (mac ? e.ctrlKey : e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.startsWith('Arrow')) key = key.slice('Arrow'.length);
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);

  return parts.join('+');
}

/** Normalizes a written chord so modifier order and case do not matter. */
export function normalize(chord: Chord): Chord {
  const parts = chord.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const out: string[] = [];
  for (const [name, lower] of [
    ['Mod', 'mod'],
    ['Ctrl', 'ctrl'],
    ['Alt', 'alt'],
    ['Shift', 'shift'],
  ] as const) {
    if (mods.has(lower)) out.push(name);
  }
  out.push(key.length === 1 ? key.toUpperCase() : key);
  return out.join('+');
}

/** The binding a key event triggers, if any. */
export function bindingFor(
  e: KeyboardEvent,
  keymap: Binding[] = DEFAULT_KEYMAP,
  mac = isMac(),
): Binding | undefined {
  const chord = normalize(chordOf(e, mac));
  return keymap.find((b) => normalize(b.keys) === chord);
}

/** How a chord should read in the UI, per platform. */
export function displayChord(chord: Chord, mac = isMac()): string {
  return normalize(chord)
    .split('+')
    .map((p) => {
      if (p === 'Mod') return mac ? '⌘' : 'Ctrl';
      if (p === 'Ctrl') return mac ? '⌃' : 'Ctrl';
      if (p === 'Alt') return mac ? '⌥' : 'Alt';
      if (p === 'Shift') return mac ? '⇧' : 'Shift';
      if (p === 'Right') return '→';
      if (p === 'Left') return '←';
      return p;
    })
    .join(mac ? '' : '+');
}
