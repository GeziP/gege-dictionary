import { describe, expect, it } from 'vitest';
import type { SavedWord } from '../types/lexnote';
import { normalizeTag, upsertSavedWord } from './words';

const word = (id: string, translation = ''): SavedWord =>
  ({ id, lemma: id, translation, tags: [], mastery: 'new', lookups: 1 }) as unknown as SavedWord;

describe('upsertSavedWord', () => {
  it('shows a word that is not in the list yet first', () => {
    const list = [word('a'), word('b')];
    expect(upsertSavedWord(list, word('c')).map((w) => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('replaces a word where it already is instead of moving it', () => {
    const list = [word('a'), word('b'), word('c')];
    const next = upsertSavedWord(list, word('b', 'merged'));
    expect(next.map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(next[1].translation).toBe('merged');
  });

  it('never mutates the list it was given', () => {
    const list = [word('a'), word('b')];
    const snapshot = JSON.stringify(list);
    upsertSavedWord(list, word('a', 'changed'));
    upsertSavedWord(list, word('z'));
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});

describe('normalizeTag', () => {
  it('trims and lower-cases', () => {
    expect(normalizeTag('  Project-A ')).toBe('project-a');
  });

  it('turns blank input into the empty string', () => {
    expect(normalizeTag('   ')).toBe('');
  });
});
