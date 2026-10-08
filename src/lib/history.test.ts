import { describe, expect, it } from 'vitest';
import type { LookupHistoryItem } from '../types/lexnote';
import {
  dayLabel,
  filterHistory,
  groupHistoryByDay,
  isSavedLookup,
  lemmaKey,
  savedLookupKeys,
  showsLemma,
  timeOfDay,
} from './history';

// 7 October 2026, in the local time zone, so none of this depends on where the tests run.
const NOW = new Date(2026, 9, 7, 15, 30);
const local = (month: number, day: number, hour = 12, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).toISOString();

const item = (overrides: Partial<LookupHistoryItem> = {}): LookupHistoryItem => ({
  id: 1,
  selection: 'run',
  lemma: 'run',
  translation: '跑',
  kind: 'word',
  sourceApp: '',
  sourceTitle: '',
  count: 1,
  firstAt: local(10, 7),
  lastAt: local(10, 7),
  ...overrides,
});

describe('lemmaKey', () => {
  it('ignores case and spacing, like the backend does when it looks for a saved word', () => {
    expect(lemmaKey('  Run   Away ')).toBe('run away');
    expect(lemmaKey('')).toBe('');
  });
});

describe('isSavedLookup', () => {
  const keys = savedLookupKeys([
    { lemma: 'Run', kind: 'word' },
    { lemma: 'Time flies like an arrow.', kind: 'sentence' },
  ]);

  it('compares the lemma the answer gave, not the spelling that was selected', () => {
    expect(isSavedLookup(item({ selection: 'running', lemma: 'run' }), keys)).toBe(true);
    expect(isSavedLookup(item({ selection: 'run', lemma: 'sprint' }), keys)).toBe(false);
  });

  it('falls back to the text when the answer gave no lemma', () => {
    expect(isSavedLookup(item({ selection: ' RUN ', lemma: '' }), keys)).toBe(true);
  });

  it('keeps kinds apart: a phrase is not the saved word of the same spelling', () => {
    expect(isSavedLookup(item({ lemma: 'run', kind: 'phrase' }), keys)).toBe(false);
    expect(
      isSavedLookup(item({ selection: 'time  flies like an arrow.', lemma: '', kind: 'sentence' }), keys),
    ).toBe(true);
  });
});

describe('showsLemma', () => {
  it('shows the base form of a word that was looked up in another form', () => {
    expect(showsLemma(item({ selection: 'running', lemma: 'run' }))).toBe(true);
  });

  it('does not repeat the same word, however it is spelled', () => {
    expect(showsLemma(item({ selection: 'Run', lemma: 'run' }))).toBe(false);
    expect(showsLemma(item({ selection: 'run', lemma: '' }))).toBe(false);
  });

  it('never shows the lemma of a sentence, which is the sentence itself', () => {
    expect(showsLemma(item({ kind: 'sentence', selection: 'Time flies.', lemma: 'time fly' }))).toBe(false);
    expect(showsLemma(item({ kind: 'paragraph', selection: 'a', lemma: 'b' }))).toBe(false);
  });
});

describe('filterHistory', () => {
  const items = [
    item({ id: 1, selection: 'running', lemma: 'run', translation: '奔跑', sourceApp: 'chrome.exe' }),
    item({ id: 2, selection: 'serendipity', lemma: 'serendipity', translation: '意外发现', sourceApp: 'Reader' }),
    item({ id: 3, selection: 'Time flies.', lemma: 'Time flies.', kind: 'sentence', sourceTitle: 'Notes' }),
  ];
  const ids = (list: LookupHistoryItem[]) => list.map((entry) => entry.id);

  it('keeps everything for an empty query', () => {
    expect(filterHistory(items, '   ')).toBe(items);
  });

  it('looks in the text, the lemma, the translation and the source, ignoring case', () => {
    expect(ids(filterHistory(items, 'RUN'))).toEqual([1]);
    expect(ids(filterHistory(items, '意外'))).toEqual([2]);
    expect(ids(filterHistory(items, 'reader'))).toEqual([2]);
    expect(ids(filterHistory(items, 'notes'))).toEqual([3]);
  });

  it('needs every word of the query, wherever each one is found', () => {
    expect(ids(filterHistory(items, 'run chrome'))).toEqual([1]);
    expect(ids(filterHistory(items, 'run reader'))).toEqual([]);
  });
});

describe('dayLabel', () => {
  it('names today and yesterday', () => {
    expect(dayLabel(new Date(2026, 9, 7, 0, 5), NOW)).toBe('今天');
    expect(dayLabel(new Date(2026, 9, 6, 23, 55), NOW)).toBe('昨天');
  });

  it('counts calendar days, not 24-hour spans', () => {
    // 15:30 on the 7th is only a few hours after 23:55 on the 6th.
    expect(dayLabel(new Date(2026, 9, 6, 23, 55), new Date(2026, 9, 7, 0, 10))).toBe('昨天');
  });

  it('gives the weekday within this year and the full date before it', () => {
    expect(dayLabel(new Date(2026, 9, 5), NOW)).toBe('10月5日 星期一');
    expect(dayLabel(new Date(2025, 11, 30), NOW)).toBe('2025年12月30日');
  });

  it('does not call a time from the future anything but today', () => {
    expect(dayLabel(new Date(2026, 9, 9), NOW)).toBe('今天');
  });
});

describe('groupHistoryByDay', () => {
  it('splits the newest-first list into local days and keeps the order', () => {
    const days = groupHistoryByDay(
      [
        item({ id: 1, lastAt: local(10, 7, 14, 0) }),
        item({ id: 2, lastAt: local(10, 7, 9, 0) }),
        item({ id: 3, lastAt: local(10, 6, 22, 0) }),
        item({ id: 4, lastAt: local(10, 1, 8, 0) }),
      ],
      NOW,
    );
    expect(days.map((day) => [day.key, day.label, day.items.map((entry) => entry.id)])).toEqual([
      ['2026-10-07', '今天', [1, 2]],
      ['2026-10-06', '昨天', [3]],
      ['2026-10-01', '10月1日 星期四', [4]],
    ]);
  });

  it('keeps an entry whose time cannot be read, under its own heading', () => {
    const days = groupHistoryByDay(
      [item({ id: 1, lastAt: local(10, 7) }), item({ id: 2, lastAt: 'not a time' })],
      NOW,
    );
    expect(days.map((day) => [day.label, day.items.map((entry) => entry.id)])).toEqual([
      ['今天', [1]],
      ['时间未知', [2]],
    ]);
  });

  it('is empty for an empty history', () => {
    expect(groupHistoryByDay([], NOW)).toEqual([]);
  });
});

describe('timeOfDay', () => {
  it('shows the local time, and nothing when it cannot be read', () => {
    expect(timeOfDay(local(10, 7, 9, 5))).toBe('09:05');
    expect(timeOfDay('garbage')).toBe('');
  });
});
