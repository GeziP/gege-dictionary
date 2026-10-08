import { describe, expect, it } from 'vitest';
import { guessMapping } from './import-columns';

const FIELDS = ['lemma', 'translation', 'pos', 'contextMeaning', 'explanation', 'note', 'tags'];

describe('guessMapping', () => {
  it('finds the columns that carry the names of the fields', () => {
    expect(guessMapping(['lemma', 'translation', 'tags'], FIELDS)).toEqual({
      lemma: 'lemma',
      translation: 'translation',
      tags: 'tags',
    });
  });

  it('does not mind case, spaces, dashes or underscores', () => {
    expect(guessMapping(['Context_Meaning', 'PART OF SPEECH', 'Lemma'], FIELDS)).toEqual({
      lemma: 'Lemma',
      pos: 'PART OF SPEECH',
      contextMeaning: 'Context_Meaning',
    });
  });

  it('knows the names that other word lists use, in English and in Chinese', () => {
    expect(guessMapping(['Word', 'Meaning', 'Notes'], FIELDS)).toEqual({
      lemma: 'Word',
      translation: 'Meaning',
      note: 'Notes',
    });
    expect(guessMapping(['单词', '释义', '词性', '备注', '标签'], FIELDS)).toEqual({
      lemma: '单词',
      translation: '释义',
      pos: '词性',
      note: '备注',
      tags: '标签',
    });
    // The two sides of an Anki card.
    expect(guessMapping(['Front', 'Back'], FIELDS)).toEqual({ lemma: 'Front', translation: 'Back' });
  });

  it('ignores the byte order mark that a spreadsheet puts in front of the first column', () => {
    expect(guessMapping(['\uFEFFlemma', 'translation'], FIELDS)).toEqual({
      lemma: '\uFEFFlemma',
      translation: 'translation',
    });
  });

  it('takes the first of two columns that look like the same field', () => {
    expect(guessMapping(['Word', 'Front', 'Back', 'Meaning'], FIELDS)).toEqual({
      lemma: 'Word',
      translation: 'Back',
    });
  });

  it('never gives one column to two fields', () => {
    expect(guessMapping(['word'], ['lemma', 'lemma'])).toEqual({ lemma: 'word' });
    expect(Object.values(guessMapping(['解释', '释义'], FIELDS)).sort()).toEqual(['释义', '解释'].sort());
  });

  it('leaves out what it cannot find, and a column of an unknown name stays unmapped', () => {
    expect(guessMapping(['foo', 'bar'], FIELDS)).toEqual({});
    expect(guessMapping([], FIELDS)).toEqual({});
  });
});
