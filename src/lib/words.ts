import type { SavedWord } from '../types/lexnote';

/** Longest tag the backend accepts, counted in characters. */
export const MAX_TAG_CHARS = 32;

/** Tags are stored trimmed and lower-cased; an empty result means "no tag". */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Puts a word that came back from the backend into the in-memory list: it
 * replaces the entry with the same id where that already is, otherwise it is
 * shown first (newest first, like the library). Nothing else is touched, and
 * the input list is never mutated.
 */
export function upsertSavedWord(words: SavedWord[], stored: SavedWord): SavedWord[] {
  const index = words.findIndex((word) => word.id === stored.id);
  if (index < 0) return [stored, ...words];
  const next = words.slice();
  next[index] = stored;
  return next;
}
