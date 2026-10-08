import { describe, expect, it } from 'vitest';
import type { InsightsDay, ReviewCalendarDay } from '../types/lexnote';
import { blankInsights, insightsFixture, reviewCalendarFixture } from './insights.fixture';
import {
  accuracyPercent,
  busiestDay,
  busiestReviewDay,
  calendarWeeks,
  chartBars,
  dayLabel,
  describeAnswers,
  describeCalendar,
  describeCounts,
  describeDay,
  describeHardWord,
  describeReviewDay,
  hardWordWeight,
  heatLevel,
  isBlank,
  masterySegments,
  rankShare,
  streakNote,
} from './insights';

const day = (date: string, lookups = 0, saved = 0, reviews = 0): InsightsDay => ({ date, lookups, saved, reviews });
const reviewed = (date: string, correct = 0, hard = 0, wrong = 0, unknown = 0): ReviewCalendarDay => ({
  date,
  total: correct + hard + wrong + unknown,
  correct,
  hard,
  wrong,
});

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

  it('does not count a card that was found hard as a right answer', () => {
    expect(accuracyPercent(6, 2, 2)).toBe(60);
    expect(accuracyPercent(3, 0, 1)).toBe(75);
    expect(accuracyPercent(0, 0, 4)).toBe(0);
    expect(accuracyPercent(1, 0, 0)).toBe(100);
    expect(accuracyPercent(999, 0, 1)).toBe(99); // it was not all right, and the number says so
  });
});

describe('describing the answers', () => {
  it('names right and wrong answers always, and hard ones only when there were some', () => {
    expect(describeAnswers({ correct: 75, hard: 0, wrong: 25 })).toBe('答对 75 次，答错 25 次');
    expect(describeAnswers({ correct: 75, hard: 10, wrong: 15 })).toBe('答对 75 次，有点难 10 次，答错 15 次');
  });

  it('names what makes a word hard, in the order of how much it weighs', () => {
    expect(describeHardWord({ wrong: 4, hard: 0 })).toBe('答错 4 次');
    expect(describeHardWord({ wrong: 0, hard: 3 })).toBe('有点难 3 次');
    expect(describeHardWord({ wrong: 1, hard: 3 })).toBe('答错 1 次 · 有点难 3 次');
  });

  it('weighs forgetting a word twice as much as finding it hard, as the backend ranks them', () => {
    expect(hardWordWeight({ wrong: 1, hard: 0 })).toBe(2);
    expect(hardWordWeight({ wrong: 0, hard: 3 })).toBe(3);
    expect(hardWordWeight({ wrong: 2, hard: 1 })).toBe(5);
  });
});

describe('the review calendar', () => {
  it('is dark in proportion to the busiest day, and never blank for a day with an answer', () => {
    expect(heatLevel(0, 12)).toBe(0);
    expect(heatLevel(12, 12)).toBe(4);
    expect(heatLevel(6, 12)).toBe(2);
    expect(heatLevel(7, 12)).toBe(3);
    expect(heatLevel(1, 1000)).toBe(1);
    expect(heatLevel(3, 0)).toBe(0);
    expect(heatLevel(-1, 5)).toBe(0);
  });

  it('finds the busiest day', () => {
    expect(busiestReviewDay([])).toBe(0);
    expect(busiestReviewDay([reviewed('2026-10-05', 2), reviewed('2026-10-06', 3, 4, 1), reviewed('2026-10-07')])).toBe(8);
  });

  it('is laid out in weeks that run from Monday, the last one up to today', () => {
    const weeks = calendarWeeks(reviewCalendarFixture());

    expect(weeks).toHaveLength(12);
    expect(weeks.slice(0, 11).every((week) => week.length === 7)).toBe(true);
    expect(weeks[11].map((cell) => cell.day.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    // Each week begins on a Monday: 20 July 2026 was one.
    expect(dayLabel(weeks[0][0].day.date)).toBe('7月20日 周一');
    expect(dayLabel(weeks[11][0].day.date)).toBe('10月5日 周一');
    expect(weeks.flat()).toHaveLength(80);
  });

  it('shades the days by how much was reviewed on them', () => {
    const cells = calendarWeeks(reviewCalendarFixture()).flat();
    const level = (date: string) => cells.find((cell) => cell.day.date === date)?.level;

    expect(level('2026-10-01')).toBe(4); // 8 cards, the busiest day
    expect(level('2026-10-06')).toBe(2); // 3 of 8
    expect(level('2026-09-28')).toBe(1); // 2 of 8
    expect(level('2026-10-02')).toBe(0);
  });

  it('has no weeks while it has no days', () => {
    expect(calendarWeeks({ first: '2026-10-05', weeks: 12, days: [] })).toEqual([]);
  });

  it('says what happened on a day, and how the cards were answered', () => {
    expect(describeReviewDay(reviewed('2026-10-07'))).toBe('10月7日 周三：没有复习');
    expect(describeReviewDay(reviewed('2026-10-06', 9, 2, 1))).toBe('10月6日 周二：复习 12 张（答对 9，有点难 2，答错 1）');
    expect(describeReviewDay(reviewed('2026-10-06', 3))).toBe('10月6日 周二：复习 3 张（答对 3）');
    // Cards answered before the kind of answer was recorded are not made up into one.
    expect(describeReviewDay(reviewed('2026-10-05', 1, 0, 0, 4))).toBe('10月5日 周一：复习 5 张（答对 1，未记录 4）');
    expect(describeReviewDay(reviewed('2026-10-05', 0, 0, 0, 2))).toBe('10月5日 周一：复习 2 张（未记录 2）');
  });

  it('sums up the weeks it covers', () => {
    expect(describeCalendar(reviewCalendarFixture())).toBe('近 12 周复习了 13 张，分布在 3 天');
    expect(describeCalendar(reviewCalendarFixture({}))).toBe('近 12 周没有复习');
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
