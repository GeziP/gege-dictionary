import { describe, expect, it } from 'vitest';
import type { InsightsDay } from '../types/lexnote';
import { blankInsights, insightsFixture } from './insights.fixture';
import {
  accuracyPercent,
  busiestDay,
  chartBars,
  dayLabel,
  describeCounts,
  describeDay,
  isBlank,
  masterySegments,
  rankShare,
  streakNote,
} from './insights';

const day = (date: string, lookups = 0, saved = 0, reviews = 0): InsightsDay => ({ date, lookups, saved, reviews });

describe('accuracyPercent', () => {
  it('is not a number until something has been answered', () => {
    expect(accuracyPercent(0, 0)).toBeNull();
  });

  it('is the share of right answers', () => {
    expect(accuracyPercent(3, 1)).toBe(75);
    expect(accuracyPercent(1, 1)).toBe(50);
    expect(accuracyPercent(75, 25)).toBe(75);
  });

  it('shows 100 only without a mistake, and 0 only without a success', () => {
    expect(accuracyPercent(10, 0)).toBe(100);
    expect(accuracyPercent(0, 5)).toBe(0);
    expect(accuracyPercent(999, 1)).toBe(99); // 99.9 rounds to 100, which would hide the mistake
    expect(accuracyPercent(1, 999)).toBe(1); // 0.1 rounds to 0, which would hide the success
  });
});

describe('describing days', () => {
  it('writes the date the way the rest of the app does, with the weekday', () => {
    expect(dayLabel('2026-10-07')).toBe('10月7日 周三');
    expect(dayLabel('2026-12-31')).toBe('12月31日 周四');
  });

  it('leaves a date it cannot read as it is', () => {
    expect(dayLabel('someday')).toBe('someday');
  });

  it('names only what happened, and says so when nothing did', () => {
    expect(describeCounts({ lookups: 4, saved: 1, reviews: 2 })).toBe('查词 4 次，收藏 1 个，复习 2 张');
    expect(describeCounts({ lookups: 0, saved: 3, reviews: 0 })).toBe('收藏 3 个');
    expect(describeCounts({ lookups: 0, saved: 0, reviews: 0 })).toBe('没有记录');
  });

  it('puts the day in front', () => {
    expect(describeDay(day('2026-10-07', 4, 1))).toBe('10月7日 周三：查词 4 次，收藏 1 个');
    expect(describeDay(day('2026-10-06'))).toBe('10月6日 周二：没有记录');
  });
});

describe('chartBars', () => {
  it('scales to the busiest day', () => {
    const bars = chartBars([day('2026-10-05', 40), day('2026-10-06', 10), day('2026-10-07')]);
    expect(bars.map((bar) => bar.height)).toEqual([1, 0.25, 0]);
    expect(bars.map((bar) => bar.day.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('counts everything that was done on a day', () => {
    expect(chartBars([day('2026-10-05', 5, 5, 10), day('2026-10-06', 10)]).map((bar) => bar.height)).toEqual([1, 0.5]);
  });

  it('does not stretch a quiet stretch to the full height', () => {
    const bars = chartBars([day('2026-10-06'), day('2026-10-07', 1)]);
    expect(bars[0].height).toBe(0);
    expect(bars[1].height).toBeCloseTo(0.2); // one of a scale of at least five
  });

  it('never lets a day with something in it vanish next to a busy one', () => {
    const bars = chartBars([day('2026-10-06', 1000), day('2026-10-07', 1)]);
    expect(bars[0].height).toBe(1);
    expect(bars[1].height).toBeCloseTo(0.05);
  });

  it('copes with no days at all', () => {
    expect(chartBars([])).toEqual([]);
    expect(busiestDay([])).toBe(0);
  });
});

describe('masterySegments', () => {
  it('lists the four levels in order with their share of the library', () => {
    const segments = masterySegments({ new: 2, learning: 1, familiar: 0, mastered: 1 });
    expect(segments.map((segment) => segment.level)).toEqual(['new', 'learning', 'familiar', 'mastered']);
    expect(segments.map((segment) => segment.count)).toEqual([2, 1, 0, 1]);
    expect(segments.map((segment) => segment.share)).toEqual([0.5, 0.25, 0, 0.25]);
    expect(segments.map((segment) => segment.percent)).toEqual([50, 25, 0, 25]);
  });

  it('is all zeros, not NaN, for an empty library', () => {
    const segments = masterySegments({ new: 0, learning: 0, familiar: 0, mastered: 0 });
    expect(segments.every((segment) => segment.share === 0 && segment.percent === 0)).toBe(true);
  });
});

describe('rankShare', () => {
  it('is relative to the largest value', () => {
    expect(rankShare(10, 10)).toBe(100);
    expect(rankShare(5, 10)).toBe(50);
  });

  it('keeps a small value visible, and nothing at zero', () => {
    expect(rankShare(1, 100)).toBe(4);
    expect(rankShare(0, 10)).toBe(0);
    expect(rankShare(3, 0)).toBe(0);
  });
});

describe('streakNote', () => {
  const fixture = insightsFixture();
  const quietToday = fixture.daily.map((item, index) =>
    index === fixture.daily.length - 1 ? { ...item, lookups: 0, saved: 0, reviews: 0 } : item,
  );

  it('tells a newcomer how a streak starts', () => {
    expect(streakNote(blankInsights())).toBe('查一个词、收藏一个词或复习一张卡片，就开始计数');
  });

  it('offers a fresh start after a broken streak', () => {
    expect(streakNote({ streak: { current: 0, longest: 5, activeDays: 9 }, daily: fixture.daily })).toBe(
      '最长连续 5 天，今天开始新的记录',
    );
  });

  it('asks for something today when the run is alive only because today is not over', () => {
    expect(streakNote({ streak: { current: 3, longest: 5, activeDays: 9 }, daily: quietToday })).toBe(
      '今天还没有学习，继续就不会断（最长 5 天）',
    );
  });

  it('states the record while the run is on', () => {
    expect(streakNote({ streak: { current: 3, longest: 5, activeDays: 9 }, daily: fixture.daily })).toBe('最长连续 5 天');
    expect(streakNote({ streak: { current: 5, longest: 5, activeDays: 9 }, daily: fixture.daily })).toBe(
      '这就是你的最长连续记录',
    );
  });
});

describe('isBlank', () => {
  it('is true for somebody who has done nothing', () => {
    expect(isBlank(blankInsights())).toBe(true);
  });

  it('is false as soon as there is anything: a word, a lookup, an active day or a card', () => {
    const blank = blankInsights();
    expect(isBlank({ ...blank, totals: { words: 1, lookups: 0 } })).toBe(false);
    expect(isBlank({ ...blank, totals: { words: 0, lookups: 3 } })).toBe(false);
    expect(isBlank({ ...blank, streak: { current: 0, longest: 1, activeDays: 1 } })).toBe(false);
    expect(isBlank({ ...blank, review: { ...blank.review, total: 2 } })).toBe(false);
    expect(isBlank(insightsFixture())).toBe(false);
  });
});
