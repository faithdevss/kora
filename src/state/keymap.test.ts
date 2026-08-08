import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYMAP, bindingFor, chordOf, displayChord, normalize } from './keymap';

/** A key event as the browser would deliver it. */
function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

describe('chordOf', () => {
  it('reads ⌘ as Mod on macOS and Ctrl elsewhere', () => {
    expect(chordOf(key({ key: 'k', metaKey: true }), true)).toBe('Mod+K');
    expect(chordOf(key({ key: 'k', ctrlKey: true }), false)).toBe('Mod+K');
  });

  it('does not confuse the other platform modifier for Mod', () => {
    // Ctrl+K on a Mac is not ⌘K, and must not fire the ⌘K binding.
    expect(chordOf(key({ key: 'k', ctrlKey: true }), true)).toBe('Ctrl+K');
    expect(chordOf(key({ key: 'k', metaKey: true }), false)).toBe('Ctrl+K');
  });

  it('normalizes letters, arrows and space', () => {
    expect(chordOf(key({ key: 'P', metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+P');
    expect(chordOf(key({ key: 'ArrowRight', metaKey: true, altKey: true }), true)).toBe(
      'Mod+Alt+Right',
    );
    expect(chordOf(key({ key: ' ', metaKey: true }), true)).toBe('Mod+Space');
  });
});

describe('normalize', () => {
  it('makes modifier order and case irrelevant', () => {
    expect(normalize('shift+mod+p')).toBe(normalize('Mod+Shift+P'));
    expect(normalize('MOD+k')).toBe('Mod+K');
  });
});

describe('bindingFor', () => {
  it('finds the docs shortcuts from a real event', () => {
    const cases: [string, Partial<KeyboardEvent> & { key: string }][] = [
      ['search', { key: 'k', metaKey: true }],
      ['clear', { key: 'l', metaKey: true }],
      ['history', { key: 'r', metaKey: true }],
      ['copy', { key: 'C', metaKey: true, shiftKey: true }],
      ['paste', { key: 'V', metaKey: true, shiftKey: true }],
      ['palette', { key: 'P', metaKey: true, shiftKey: true }],
    ];
    for (const [id, ev] of cases) {
      expect(bindingFor(key(ev), DEFAULT_KEYMAP, true)?.id).toBe(id);
    }
  });

  it('is undefined for a plain keystroke, so typing is never swallowed', () => {
    expect(bindingFor(key({ key: 'k' }), DEFAULT_KEYMAP, true)).toBeUndefined();
    expect(bindingFor(key({ key: 'Enter' }), DEFAULT_KEYMAP, true)).toBeUndefined();
  });

  it('every default binding is reachable and unique', () => {
    const chords = DEFAULT_KEYMAP.map((b) => normalize(b.keys));
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('covers every shortcut the docs list in §21', () => {
    const ids = DEFAULT_KEYMAP.map((b) => b.id);
    for (const id of ['search', 'clear', 'history', 'copy', 'paste']) {
      expect(ids).toContain(id);
    }
  });
});

describe('displayChord', () => {
  it('reads as the platform writes it', () => {
    expect(displayChord('Mod+Shift+P', true)).toBe('⌘⇧P');
    expect(displayChord('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(displayChord('Mod+Alt+Right', true)).toBe('⌘⌥→');
  });
});
