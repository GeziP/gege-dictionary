/**
 * Keyboard shortcuts of the lookup window, decided in one place so they can be
 * tested. The window used to act on every key pressed anywhere in it, which
 * swallowed the spaces typed into the context box, saved twice (the tag box
 * handled Enter as well), re-triggered a save when a button had focus, and
 * treated the Enter that confirms an IME candidate as "save".
 */

/** The parts of a `KeyboardEvent` the rules look at. */
export interface ShortcutEvent {
  key: string;
  target: EventTarget | null;
  repeat?: boolean;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

export interface ShortcutState {
  /** A pinned window stays open on Escape. */
  pinned: boolean;
  hasEntry: boolean;
  /** An entry is on screen, not saved yet and no save is under way. */
  canSave: boolean;
}

export type LookupShortcut = 'close' | 'save' | 'speak';

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const ACTIVATABLE_ROLES = new Set(['button', 'link', 'menuitem', 'checkbox', 'switch', 'tab']);

function isContentEditable(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  const attribute = element.getAttribute('contenteditable');
  return attribute !== null && attribute !== 'false';
}

/** Elements that take typed text, and with it Space and Enter, for themselves. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return TEXT_ENTRY_TAGS.has(target.tagName) || isContentEditable(target);
}

/** Elements that already react to Space or Enter by being activated. */
export function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (ACTIVATABLE_TAGS.has(target.tagName)) return true;
  const role = target.getAttribute('role');
  return role !== null && ACTIVATABLE_ROLES.has(role);
}

/**
 * What a key press means in the lookup window, or `null` when it is none of
 * its business and must be left to the page (typing, button activation, IME,
 * system shortcuts).
 */
export function resolveLookupShortcut(
  event: ShortcutEvent,
  state: ShortcutState,
): LookupShortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  // Shortcuts are plain keys; Ctrl+Enter, Alt+Space and friends belong to the
  // system or the page.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  if (event.key === 'Escape') return state.pinned ? null : 'close';

  if (isTextEntryTarget(event.target) || isActivatableTarget(event.target)) return null;

  if (event.key === 'Enter') return state.canSave ? 'save' : null;
  if (event.key === ' ' || event.key === 'Spacebar') {
    return state.hasEntry && !event.repeat ? 'speak' : null;
  }
  return null;
}
