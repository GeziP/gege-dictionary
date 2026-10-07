import { describe, expect, it } from 'vitest';
import type { SavedWord } from '../types/lexnote';
import { filterWords, searchTextOf, sortWords, type WordFilters } from './library-list';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400_000;
const NO_FILTERS: WordFilters = { query: '', tags: [], sources: [], mastery: [], range: 'all' };

const word = (overrides: Record<string, unknown> = {}): SavedWord =>
  ({
    id: 'w',
    lemma: 'run',
    translation: '',
    contextMeaning: '',
    explanation: '',
    context: '',
    examples: [],
    tags: [],
    sourceApp: 'Chrome',
    mastery: 'new',
    lookups: 1,
    savedAt: '2026-10-07T00:00:00Z',
    ...overrides,
  }) as unknown as SavedWord;

const ids = (words: SavedWord[]) => words.map((item) => item.id);
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

describe('searchTextOf', () => {
  it('gathers everything that the search box looks in, in lower case', () => {
    const text = searchTextOf(
      word({
        lemma: 'Livelock',
        translation: '活锁',
        contextMeaning: 'A State',
        explanation: 'Threads KEEP changing',
        context: 'the Protocol',
        examples: [{ en: 'It Spins.', zh: '它在空转。' }],
      }),
    );
    expect(text).toBe('livelock 活锁 a state threads keep changing the protocol it spins. 它在空转。');
  });

  it('is built once for a word object, which is what keeps a keystroke cheap', () => {
    const stored = word({ lemma: 'First' });
    expect(searchTextOf(stored)).toContain('first');
    // The library state is never changed in place, so the text of an object never goes stale;
    // an edited word is a new object and gets a text of its own.
    stored.lemma = 'Changed in place';
    expect(searchTextOf(stored)).toContain('first');
    expect(searchTextOf({ ...stored })).toContain('changed in place');
  });
});

describe('filterWords', () => {
  const livelock = word({
    id: 'livelock',
    lemma: 'livelock',
    translation: '活锁',
    examples: [{ en: 'Both threads keep spinning.', zh: '两个线程不停空转。' }],
    tags: ['os', 'concurrency'],
    sourceApp: 'Chrome',
    mastery: 'learning',
    savedAt: daysAgo(2),
  });
  const deadlock = word({
    id: 'deadlock',
    lemma: 'deadlock',
    translation: '死锁',
    contextMeaning: 'threads wait for each other',
    tags: ['os'],
    sourceApp: 'Code',
    mastery: 'mastered',
    savedAt: daysAgo(20),
  });
  const take = word({
    id: 'take',
    lemma: 'take off',
    translation: '起飞',
    context: 'The plane will take off at noon.',
    sourceApp: 'Chrome',
    savedAt: daysAgo(100),
  });
  const all = [livelock, deadlock, take];
  const filter = (filters: Partial<WordFilters>) => ids(filterWords(all, { ...NO_FILTERS, ...filters }, NOW));

  it('keeps every word when nothing narrows the list, in the order it came in', () => {
    expect(filter({})).toEqual(['livelock', 'deadlock', 'take']);
  });

  it('finds a word by the lemma, the translation, the meaning, the context or an example', () => {
    expect(filter({ query: 'livelock' })).toEqual(['livelock']);
    expect(filter({ query: '死锁' })).toEqual(['deadlock']);
    expect(filter({ query: 'wait for' })).toEqual(['deadlock']);
    expect(filter({ query: 'at noon' })).toEqual(['take']);
    expect(filter({ query: 'spinning' })).toEqual(['livelock']);
    expect(filter({ query: '空转' })).toEqual(['livelock']);
    expect(filter({ query: 'threads' })).toEqual(['livelock', 'deadlock']);
  });

  it('ignores case and the spaces around the search text, but not the order of its words', () => {
    expect(filter({ query: '  TAKE Off ' })).toEqual(['take']);
    expect(filter({ query: 'off take' })).toEqual([]);
  });

  it('wants every one of the chosen tags, but only one of the chosen apps or levels', () => {
    expect(filter({ tags: ['os'] })).toEqual(['livelock', 'deadlock']);
    expect(filter({ tags: ['os', 'concurrency'] })).toEqual(['livelock']);
    expect(filter({ sources: ['Chrome', 'Code'] })).toEqual(['livelock', 'deadlock', 'take']);
    expect(filter({ sources: ['Code'] })).toEqual(['deadlock']);
    expect(filter({ mastery: ['mastered', 'learning'] })).toEqual(['livelock', 'deadlock']);
  });

  it('keeps the words saved within the chosen number of days', () => {
    expect(filter({ range: '7' })).toEqual(['livelock']);
    expect(filter({ range: '30' })).toEqual(['livelock', 'deadlock']);
    expect(filter({ range: 'all' })).toEqual(['livelock', 'deadlock', 'take']);
  });

  it('needs all of the filters to agree', () => {
    expect(filter({ query: 'threads', tags: ['os'], sources: ['Code'], mastery: ['mastered'], range: '30' })).toEqual([
      'deadlock',
    ]);
    expect(filter({ query: 'threads', sources: ['Code'], range: '7' })).toEqual([]);
  });

  it('does not touch the list it was given', () => {
    const before = [...all];
    filterWords(all, { ...NO_FILTERS, query: 'livelock' }, NOW);
    expect(all).toEqual(before);
  });
});

describe('sortWords', () => {
  const a = word({ id: 'a', lemma: 'banana', lookups: 3, mastery: 'familiar', savedAt: '2026-10-01T00:00:00Z' });
  const b = word({ id: 'b', lemma: 'Apple', lookups: 1, mastery: 'new', savedAt: '2026-10-03T00:00:00Z' });
  const c = word({ id: 'c', lemma: 'cherry', lookups: 3, mastery: 'mastered', savedAt: '2026-10-02T00:00:00Z' });
  const d = word({ id: 'd', lemma: 'Éclair', lookups: 2, mastery: 'learning', savedAt: '2026-09-30T00:00:00Z' });
  const all = [a, b, c, d];

  it('sorts by the word, whatever its case', () => {
    expect(ids(sortWords(all, { field: 'lemma', dir: 'asc' }))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(sortWords(all, { field: 'lemma', dir: 'desc' }))).toEqual(['d', 'c', 'a', 'b']);
  });

  it('sorts by the day it was saved, newest first when descending', () => {
    expect(ids(sortWords(all, { field: 'savedAt', dir: 'desc' }))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(sortWords(all, { field: 'savedAt', dir: 'asc' }))).toEqual(['d', 'a', 'c', 'b']);
  });

  it('sorts by the number of lookups, keeping words that tie in the order they came in', () => {
    expect(ids(sortWords(all, { field: 'lookups', dir: 'desc' }))).toEqual(['a', 'c', 'd', 'b']);
    expect(ids(sortWords(all, { field: 'lookups', dir: 'asc' }))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('sorts by how well a word is known, from new to mastered', () => {
    expect(ids(sortWords(all, { field: 'mastery', dir: 'asc' }))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(sortWords(all, { field: 'mastery', dir: 'desc' }))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('ranks a level it does not know with the new words', () => {
    const odd = word({ id: 'odd', mastery: 'unheard-of' });
    expect(ids(sortWords([c, odd], { field: 'mastery', dir: 'asc' }))).toEqual(['odd', 'c']);
  });

  it('returns a new list and leaves the one it was given as it was', () => {
    const before = [...all];
    const sorted = sortWords(all, { field: 'lemma', dir: 'asc' });
    expect(sorted).not.toBe(all);
    expect(all).toEqual(before);
  });
});
