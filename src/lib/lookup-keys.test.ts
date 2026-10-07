import { afterEach, describe, expect, it } from 'vitest';
import { resolveLookupShortcut, type ShortcutEvent, type ShortcutState } from './lookup-keys';

const ready: ShortcutState = { pinned: false, hasEntry: true, canSave: true };

function element(tag: string, attributes: Record<string, string> = {}): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  document.body.appendChild(node);
  return node;
}

function press(
  key: string,
  target: EventTarget | null = document.body,
  extra: Partial<ShortcutEvent> = {},
): ShortcutEvent {
  return { key, target, ...extra };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('plain keys on the page', () => {
  it('Escape closes, Enter saves, Space speaks', () => {
    expect(resolveLookupShortcut(press('Escape'), ready)).toBe('close');
    expect(resolveLookupShortcut(press('Enter'), ready)).toBe('save');
    expect(resolveLookupShortcut(press(' '), ready)).toBe('speak');
  });

  it('ignores every other key', () => {
    expect(resolveLookupShortcut(press('a'), ready)).toBeNull();
    expect(resolveLookupShortcut(press('Tab'), ready)).toBeNull();
    expect(resolveLookupShortcut(press('ArrowDown'), ready)).toBeNull();
  });
});

describe('keys typed into a field belong to the field', () => {
  it.each([
    ['input', {}],
    ['textarea', {}],
    ['select', {}],
    ['div', { contenteditable: 'true' }],
    ['div', { contenteditable: '' }],
  ])('leaves Space and Enter alone in <%s %j>', (tag, attributes) => {
    const field = element(tag, attributes);
    expect(resolveLookupShortcut(press(' ', field), ready)).toBeNull();
    expect(resolveLookupShortcut(press('Enter', field), ready)).toBeNull();
  });

  it('does not treat contenteditable="false" as a field', () => {
    const block = element('div', { contenteditable: 'false' });
    expect(resolveLookupShortcut(press(' ', block), ready)).toBe('speak');
  });

  it('still closes on Escape from inside a field', () => {
    expect(resolveLookupShortcut(press('Escape', element('textarea')), ready)).toBe('close');
  });
});

describe('keys that activate the focused control', () => {
  it.each([
    ['button', {}],
    ['a', { href: '#' }],
    ['summary', {}],
    ['div', { role: 'button' }],
    ['div', { role: 'switch' }],
  ])('leaves Space and Enter to <%s %j>', (tag, attributes) => {
    const control = element(tag, attributes);
    expect(resolveLookupShortcut(press(' ', control), ready)).toBeNull();
    expect(resolveLookupShortcut(press('Enter', control), ready)).toBeNull();
  });
});

describe('modifiers, IME and repeats', () => {
  it('ignores combinations with Ctrl, Alt or Meta', () => {
    expect(resolveLookupShortcut(press('Enter', document.body, { ctrlKey: true }), ready)).toBeNull();
    expect(resolveLookupShortcut(press(' ', document.body, { altKey: true }), ready)).toBeNull();
    expect(resolveLookupShortcut(press('Escape', document.body, { metaKey: true }), ready)).toBeNull();
  });

  it('does not let the Enter that confirms an IME candidate save', () => {
    expect(resolveLookupShortcut(press('Enter', document.body, { isComposing: true }), ready)).toBeNull();
    expect(resolveLookupShortcut(press('Escape', document.body, { isComposing: true }), ready)).toBeNull();
  });

  it('does not speak again for a held-down Space', () => {
    expect(resolveLookupShortcut(press(' ', document.body, { repeat: true }), ready)).toBeNull();
  });

  it('respects events something else already handled', () => {
    expect(resolveLookupShortcut(press('Enter', document.body, { defaultPrevented: true }), ready)).toBeNull();
  });
});

describe('what the window can do right now', () => {
  it('a pinned window stays open on Escape', () => {
    expect(resolveLookupShortcut(press('Escape'), { ...ready, pinned: true })).toBeNull();
  });

  it('Enter only saves when saving is possible', () => {
    expect(resolveLookupShortcut(press('Enter'), { ...ready, canSave: false })).toBeNull();
  });

  it('Space only speaks when there is an entry', () => {
    expect(resolveLookupShortcut(press(' '), { ...ready, hasEntry: false, canSave: false })).toBeNull();
  });

  it('a target that is not an element (window, document) counts as the page', () => {
    expect(resolveLookupShortcut(press('Enter', window), ready)).toBe('save');
    expect(resolveLookupShortcut(press('Enter', null), ready)).toBe('save');
  });
});
