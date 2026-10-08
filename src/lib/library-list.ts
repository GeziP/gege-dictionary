import type { Mastery, SavedWord } from '../types/lexnote';

export type SortField = 'savedAt' | 'lemma' | 'mastery' | 'lookups';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  field: SortField;
  dir: SortDir;
}

/** What the library list is narrowed down to; an empty list or text narrows nothing. */
export interface WordFilters {
  query: string;
  /** A word must have every one of these tags. */
  tags: string[];
  /** A word must come from one of these apps. */
  sources: string[];
  /** A word must be at one of these levels. */
  mastery: Mastery[];
  /** `'all'`, or the number of days back that words were saved in. */
  range: string;
}

const DAY_MS = 86_400_000;

const MASTERY_ORDER: Record<Mastery, number> = { new: 0, learning: 1, familiar: 2, mastered: 3 };

// One collator for every comparison: asking `localeCompare` for a locale builds a new one each time.
const LEMMA_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' });

const searchTexts = new WeakMap<SavedWord, string>();

/**
 * Everything of a word that the search box looks in, as one lower-cased string.
 *
 * Kept per word object, so a keystroke only compares strings instead of rebuilding this for
 * every word in the library. A word that is edited is a new object (the library state is
 * never changed in place) and gets its own text; the old one is forgotten with its object.
 */
export function searchTextOf(word: SavedWord): string {
  let text = searchTexts.get(word);
  if (text === undefined) {
    text = [
      word.lemma,
      word.translation,
      word.contextMeaning,
      word.explanation,
      word.context,
      ...word.examples.map((example) => `${example.en} ${example.zh}`),
    ]
      .join(' ')
      .toLowerCase();
    searchTexts.set(word, text);
  }
  return text;
}

/** The words that match all of the filters, in their original order. */
export function filterWords(words: SavedWord[], filters: WordFilters, now = Date.now()): SavedWord[] {
  const query = filters.query.trim().toLowerCase();
  const cutoff = filters.range === 'all' ? 0 : now - Number(filters.range) * DAY_MS;
  return words.filter((word) => {
    if (query && !searchTextOf(word).includes(query)) return false;
    if (filters.tags.length && !filters.tags.every((tag) => word.tags.includes(tag))) return false;
    if (filters.sources.length && !filters.sources.includes(word.sourceApp)) return false;
    if (filters.mastery.length && !filters.mastery.includes(word.mastery)) return false;
    if (cutoff && new Date(word.savedAt).getTime() < cutoff) return false;
    return true;
  });
}

/** A sorted copy of the words; words that rank the same stay in the order they came in. */
export function sortWords(words: SavedWord[], { field, dir }: SortState): SavedWord[] {
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = [...words];
  switch (field) {
    case 'lemma':
      return sorted.sort((a, b) => sign * LEMMA_COLLATOR.compare(a.lemma, b.lemma));
    case 'savedAt': {
      // Read each date once, not once for every comparison it takes part in.
      const times = new Map(words.map((word): [SavedWord, number] => [word, new Date(word.savedAt).getTime()]));
      return sorted.sort((a, b) => sign * ((times.get(a) ?? 0) - (times.get(b) ?? 0)));
    }
    case 'lookups':
      return sorted.sort((a, b) => sign * (a.lookups - b.lookups));
    case 'mastery':
      return sorted.sort((a, b) => sign * ((MASTERY_ORDER[a.mastery] ?? 0) - (MASTERY_ORDER[b.mastery] ?? 0)));
  }
}
