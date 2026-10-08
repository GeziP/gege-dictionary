import { addDays, format, subDays } from 'date-fns';
import type { InsightsDay, LearningInsights, ReviewCalendar, ReviewCalendarDay } from '../types/lexnote';

/** The last day of the fixture: 7 October 2026, a Wednesday. */
export const FIXTURE_TODAY = new Date(2026, 9, 7, 15, 30);

/** Review cards answered on some days of the calendar (everything else is zero). */
const REVIEWED: Record<string, Partial<ReviewCalendarDay>> = {
  '2026-10-06': { total: 3, correct: 2, hard: 1 },
  '2026-10-01': { total: 8, correct: 5, hard: 2, wrong: 1 },
  '2026-09-28': { total: 2, correct: 2 },
};

/**
 * Twelve weeks that start on Monday 20 July and end on `FIXTURE_TODAY` (80 days), with a few
 * cards answered in them.
 */
export function reviewCalendarFixture(reviewed: Record<string, Partial<ReviewCalendarDay>> = REVIEWED): ReviewCalendar {
  const first = new Date(2026, 6, 20);
  return {
    first: format(first, 'yyyy-MM-dd'),
    weeks: 12,
    days: Array.from({ length: 80 }, (_, index) => {
      const date = format(addDays(first, index), 'yyyy-MM-dd');
      return { date, total: 0, correct: 0, hard: 0, wrong: 0, ...reviewed[date] };
    }),
  };
}

/**
 * The figures of a learner who looked something up today, saved a word today and yesterday,
 * reviewed three cards yesterday, and has been at it for four days running. Anything can
 * be replaced; the window sums follow the daily series unless they are replaced as well.
 */
export function insightsFixture(overrides: Partial<LearningInsights> = {}): LearningInsights {
  const days = overrides.days ?? 30;
  const busy: Record<number, Partial<InsightsDay>> = {
    0: { lookups: 4, saved: 1 },
    1: { saved: 1, reviews: 3 },
    2: { lookups: 1 },
    3: { lookups: 2 },
  };
  const daily: InsightsDay[] = Array.from({ length: days }, (_, index) => {
    const ago = days - 1 - index;
    return {
      date: format(subDays(FIXTURE_TODAY, ago), 'yyyy-MM-dd'),
      lookups: 0,
      saved: 0,
      reviews: 0,
      ...busy[ago],
    };
  });
  const sum = (key: 'lookups' | 'saved' | 'reviews') =>
    (overrides.daily ?? daily).reduce((total, day) => total + day[key], 0);

  return {
    today: '2026-10-07',
    days,
    daily,
    window: { lookups: sum('lookups'), saved: sum('saved'), reviews: sum('reviews') },
    savedThisWeek: 2,
    streak: { current: 4, longest: 6, activeDays: 12 },
    totals: { words: 40, lookups: 156 },
    mastery: { new: 20, learning: 10, familiar: 6, mastered: 4 },
    review: { dueToday: 5, total: 38, boxCounts: [20, 12, 6], correct: 75, hard: 10, wrong: 15 },
    reviewCalendar: reviewCalendarFixture(),
    topSources: [
      { source: 'chrome.exe', count: 12 },
      { source: 'Kindle.exe', count: 4 },
    ],
    oftenLookedUp: [
      { lemma: 'ubiquitous', count: 5 },
      { lemma: 'run', count: 3 },
    ],
    hardWords: [
      { lemma: 'serendipity', wrong: 4, hard: 0 },
      { lemma: 'ephemeral', wrong: 1, hard: 3 },
    ],
    ...overrides,
  };
}

/** A learner who has not done anything yet. */
export function blankInsights(days = 30): LearningInsights {
  return insightsFixture({
    days,
    daily: Array.from({ length: days }, (_, index) => ({
      date: format(subDays(FIXTURE_TODAY, days - 1 - index), 'yyyy-MM-dd'),
      lookups: 0,
      saved: 0,
      reviews: 0,
    })),
    window: { lookups: 0, saved: 0, reviews: 0 },
    savedThisWeek: 0,
    streak: { current: 0, longest: 0, activeDays: 0 },
    totals: { words: 0, lookups: 0 },
    mastery: { new: 0, learning: 0, familiar: 0, mastered: 0 },
    review: { dueToday: 0, total: 0, boxCounts: [0, 0, 0], correct: 0, hard: 0, wrong: 0 },
    reviewCalendar: reviewCalendarFixture({}),
    topSources: [],
    oftenLookedUp: [],
    hardWords: [],
  });
}
