import { describe, expect, it } from 'vitest';
import type { Entry, SavedWord } from '../types/lexnote';
import {
  normalizeTag,
  reanalysisDraft,
  reanalysisRequest,
  rollbackDraft,
  upsertSavedWord,
} from './words';

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

const stored = (overrides: Record<string, unknown> = {}): SavedWord =>
  ({
    id: 'w1',
    selection: ' running ',
    lemma: 'run',
    kind: 'word',
    translation: '旧释义',
    explanation: '旧说明',
    context: 'He was running late.',
    savedAt: '2026-01-01T00:00:00.000Z',
    sourceApp: 'Reader',
    sourceTitle: 'A Book',
    tags: ['travel'],
    mastery: 'familiar',
    lookups: 3,
    note: '我的笔记',
    ankiNoteId: 1700000000123,
    ...overrides,
  }) as unknown as SavedWord;

const fresh = (overrides: Record<string, unknown> = {}): Entry =>
  ({
    id: 'fresh-id',
    selection: 'running',
    lemma: 'run',
    kind: 'word',
    translation: '新释义',
    explanation: '新说明',
    ...overrides,
  }) as unknown as Entry;

describe('reanalysisRequest', () => {
  it('asks about the text as it was first selected, with its sentence and kind', () => {
    expect(reanalysisRequest(stored({ kind: 'phrase' }))).toEqual({
      selection: 'running',
      context: 'He was running late.',
      kind: 'phrase',
    });
  });

  it('falls back to the lemma for a word that came from an imported list', () => {
    const imported = stored({ selection: '', context: undefined });
    expect(reanalysisRequest(imported)).toEqual({ selection: 'run', context: '', kind: 'word' });
  });

  it('copes with documents saved by older versions that lack the fields', () => {
    const legacy = stored({ selection: undefined, kind: undefined });
    expect(reanalysisRequest(legacy)).toMatchObject({ selection: 'run', kind: 'word' });
  });
});

describe('reanalysisDraft', () => {
  it('takes the model-written content from the new answer', () => {
    const draft = reanalysisDraft(stored(), fresh({ syntax: [{ text: 'x' }] }));
    expect(draft).toMatchObject({ translation: '新释义', explanation: '新说明' });
    expect(draft.syntax).toEqual([{ text: 'x' }]);
  });

  it('keeps identity, progress and where the word was collected', () => {
    const draft = reanalysisDraft(stored(), fresh());
    expect(draft).toMatchObject({
      id: 'w1',
      savedAt: '2026-01-01T00:00:00.000Z',
      context: 'He was running late.',
      sourceApp: 'Reader',
      sourceTitle: 'A Book',
      tags: ['travel'],
      mastery: 'familiar',
      lookups: 3,
      note: '我的笔记',
      ankiNoteId: 1700000000123,
    });
  });
});

describe('rollbackDraft', () => {
  const before = stored();
  const afterReanalysis = stored({
    translation: '新释义',
    explanation: '新说明',
    syntax: [{ text: 'added by the new answer' }],
    lookups: 4,
  });

  it('puts back everything the model wrote, including fields the new answer added', () => {
    const draft = rollbackDraft(afterReanalysis, before);
    expect(draft).toMatchObject({ translation: '旧释义', explanation: '旧说明', lookups: 3 });
    expect(draft).not.toHaveProperty('syntax');
  });

  it('keeps what the user changed after the re-analysis', () => {
    const edited = { ...afterReanalysis, mastery: 'mastered', tags: ['travel', 'verbs'], note: '改过了' } as SavedWord;
    const draft = rollbackDraft(edited, before);
    expect(draft).toMatchObject({ mastery: 'mastered', tags: ['travel', 'verbs'], note: '改过了' });
  });

  it('keeps an Anki link that was made after the re-analysis', () => {
    const withoutLink = stored({ ankiNoteId: undefined });
    const linked = { ...afterReanalysis, ankiNoteId: 42 } as SavedWord;
    expect(rollbackDraft(linked, withoutLink).ankiNoteId).toBe(42);
  });
});
