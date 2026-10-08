import type { Entry, SavedWord, SelectionKind } from '../types/lexnote';
import { lemmaKey } from './history';

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

/**
 * What to ask the model when a saved word is analysed again: the text as it
 * was first selected (words imported from a list have no selection, so the
 * lemma stands in), the sentence it was found in, and the kind it was saved as.
 */
export function reanalysisRequest(word: SavedWord): {
  selection: string;
  context: string;
  kind: SelectionKind;
} {
  return {
    selection: (word.selection ?? '').trim() || word.lemma,
    context: word.context ?? '',
    kind: word.kind ?? 'word',
  };
}

/**
 * The form a new answer gives a word, when that is not the form the word is
 * saved under: "running" was saved and the model says "run". Spacing and
 * letter case do not make another form (the backend tells words apart the same
 * way), and an answer that names nothing names no other form.
 */
export function otherLemma(
  word: Pick<SavedWord, 'lemma'>,
  entry: Pick<Entry, 'lemma'>,
): string | null {
  const named = (entry.lemma ?? '').trim();
  if (!named || lemmaKey(named) === lemmaKey(word.lemma)) return null;
  return named;
}

/**
 * The document to save after a saved word was analysed again: the new answer
 * for everything the model writes, on top of the stored word for everything
 * else (identity, the form it is saved under, progress, note, tags, where and
 * when it was collected). The backend merges by id as well; this keeps the same
 * promise where there is no backend to do it, and makes the intent readable at
 * the call site.
 *
 * The word keeps its form even when the answer names another one: what to do
 * with that is for the user to say (see `separateDraft`), not for a save to
 * decide by renaming the word.
 */
export function reanalysisDraft(word: SavedWord, entry: Entry): SavedWord {
  return {
    ...entry,
    id: word.id,
    lemma: word.lemma,
    savedAt: word.savedAt,
    context: word.context,
    sourceApp: word.sourceApp,
    sourceTitle: word.sourceTitle,
    tags: word.tags,
    mastery: word.mastery,
    lookups: word.lookups,
    note: word.note,
    reviewState: word.reviewState,
    ankiNoteId: word.ankiNoteId,
  };
}

/**
 * The document that undoes a re-analysis: everything the model wrote goes back
 * to how it was (including fields the new answer added, and the lookup count),
 * while what the user changed since, such as mastery, note, tags or an Anki
 * link, is kept. Restoring the whole earlier snapshot would silently throw
 * that work away.
 */
export function rollbackDraft(current: SavedWord, before: SavedWord): SavedWord {
  return {
    ...before,
    mastery: current.mastery,
    tags: current.tags,
    note: current.note,
    ankiNoteId: current.ankiNoteId ?? before.ankiNoteId,
    reviewState: current.reviewState ?? before.reviewState,
  };
}

/** An id for a word that is not saved yet; the backend keeps whatever it is given. */
export function newWordId(): string {
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The document that saves a re-analysis as a word of its own, under the form
 * the answer names: a new word, or the one the library has under that form
 * already (the backend refreshes it and keeps what the user owns there, so
 * nothing is made twice). It is collected where the word it came from was; the
 * tags and the note of that word stay with it.
 */
export function separateDraft(
  word: SavedWord,
  entry: Entry,
  existing: SavedWord | null,
): SavedWord {
  return {
    ...entry,
    id: existing?.id ?? newWordId(),
    savedAt: new Date().toISOString(),
    context: word.context,
    sourceApp: word.sourceApp,
    sourceTitle: word.sourceTitle,
    tags: [],
    mastery: 'new',
    lookups: 1,
    note: '',
  };
}

/**
 * Whether the user has done nothing with a word since it was saved as `saved`:
 * no mastery, note or tag, no further lookup, no Anki card. Only then does
 * deleting it, to take back the save that made it, lose nothing but the save.
 */
export function untouchedSince(saved: SavedWord, now: SavedWord): boolean {
  return (
    now.mastery === saved.mastery &&
    now.note === saved.note &&
    now.lookups === saved.lookups &&
    now.ankiNoteId === saved.ankiNoteId &&
    now.tags.length === saved.tags.length &&
    now.tags.every((tag, index) => tag === saved.tags[index])
  );
}
