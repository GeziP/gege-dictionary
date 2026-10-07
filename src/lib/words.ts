import type { Entry, SavedWord, SelectionKind } from '../types/lexnote';

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
 * The document to save after a saved word was analysed again: the new answer
 * for everything the model writes, on top of the stored word for everything
 * else (identity, progress, note, tags, where and when it was collected). The
 * backend merges by id as well; this keeps the same promise where there is no
 * backend to do it, and makes the intent readable at the call site.
 */
export function reanalysisDraft(word: SavedWord, entry: Entry): SavedWord {
  return {
    ...entry,
    id: word.id,
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
