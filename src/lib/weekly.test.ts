import { format, parseISO, subDays } from 'date-fns';
import { describe, expect, it, vi } from 'vitest';
import type { LearningInsights } from '../types/lexnote';
import { insightsFixture, reviewCalendarFixture } from './insights.fixture';
import {
  GOAL_CHOICES,
  REPORT_WINDOW_DAYS,
  buildWeeklyReport,
  describeGoal,
  effectiveGoalDays,
  escapeMarkdown,
  goalProgress,
  weekOf,
  type Week,
} from './weekly';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

/** The days a report is made of, ending on `today`, with a lookup on each of the `active` days and nothing else. */
function dataOn(today: string, active: string[] = [], days = REPORT_WINDOW_DAYS): LearningInsights {
  const daily = Array.from({ length: days }, (_, index) => {
    const date = format(subDays(parseISO(today), days - 1 - index), 'yyyy-MM-dd');
    return { date, lookups: active.includes(date) ? 1 : 0, saved: 0, reviews: 0 };
  });
  return insightsFixture({ days, daily, today, reviewCalendar: reviewCalendarFixture({}) });
}

describe('effectiveGoalDays', () => {
  it('keeps one to seven days a week', () => {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) expect(effectiveGoalDays(days)).toBe(days);
  });

  it('treats everything that no week can meet, or that is not a number, as no goal', () => {
    for (const setting of [0, 8, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined, true, {}]) {
      expect(effectiveGoalDays(setting)).toBe(0);
    }
  });

  it('is offered as no goal and then one to seven days', () => {
    expect([...GOAL_CHOICES]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('weekOf', () => {
  it('is the week from Monday to Sunday that today is in, with what happened on each day of it', () => {
    const week = must(weekOf(insightsFixture({ days: 14 }), 'this'));

    expect(week).toMatchObject({
      choice: 'this',
      start: '2026-10-05',
      end: '2026-10-11',
      asOf: '2026-10-07',
      lookups: 5,
      saved: 2,
      reviews: 3,
      activeDays: 3,
    });
    expect(week.days.map((day) => [day.name, day.date])).toEqual([
      ['周一', '2026-10-05'],
      ['周二', '2026-10-06'],
      ['周三', '2026-10-07'],
      ['周四', '2026-10-08'],
      ['周五', '2026-10-09'],
      ['周六', '2026-10-10'],
      ['周日', '2026-10-11'],
    ]);
    expect(week.days.map((day) => day.counts.lookups)).toEqual([1, 0, 4, 0, 0, 0, 0]);
    expect(week.days.map((day) => day.active)).toEqual([true, true, true, false, false, false, false]);
    expect(week.days.map((day) => day.today)).toEqual([false, false, true, false, false, false, false]);
    expect(week.days.map((day) => day.upcoming)).toEqual([false, false, false, true, true, true, true]);
  });

  it('counts the days still to come, and today only while nothing has been done on it', () => {
    expect(must(weekOf(insightsFixture({ days: 14 }), 'this')).daysLeft).toBe(4);

    const quietToday = must(weekOf(dataOn('2026-10-07', ['2026-10-05']), 'this'));
    expect(quietToday.daysLeft).toBe(5);
    expect(quietToday.activeDays).toBe(1);
  });

  it('is the whole week before, with nothing left to come, when asked for last week', () => {
    const week = must(weekOf(insightsFixture({ days: 14 }), 'last'));

    expect(week).toMatchObject({ choice: 'last', start: '2026-09-28', end: '2026-10-04', lookups: 2, activeDays: 1, daysLeft: 0 });
    expect(week.days.some((day) => day.upcoming || day.today)).toBe(false);
    // Sunday 4 October is the only day with anything in it
    expect(week.days.map((day) => day.active)).toEqual([false, false, false, false, false, false, true]);
  });

  it('is one day old on a Monday, and complete on a Sunday', () => {
    const monday = must(weekOf(dataOn('2026-10-05'), 'this'));
    expect(monday).toMatchObject({ start: '2026-10-05', end: '2026-10-11', daysLeft: 7 });
    expect(monday.days.filter((day) => !day.upcoming)).toHaveLength(1);
    expect(must(weekOf(dataOn('2026-10-05'), 'last'))).toMatchObject({ start: '2026-09-28', end: '2026-10-04' });

    const sunday = must(weekOf(dataOn('2026-10-11', ['2026-10-11']), 'this'));
    expect(sunday).toMatchObject({ start: '2026-10-05', end: '2026-10-11', daysLeft: 0, activeDays: 1 });
    expect(sunday.days.some((day) => day.upcoming)).toBe(false);
    expect(must(weekOf(dataOn('2026-10-11'), 'this')).daysLeft).toBe(1);
  });

  it('crosses the turn of a year', () => {
    const week = must(weekOf(dataOn('2026-01-01', ['2025-12-30', '2026-01-01']), 'this'));
    expect(week).toMatchObject({ start: '2025-12-29', end: '2026-01-04', activeDays: 2 });
    expect(week.days.map((day) => day.date)).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(must(weekOf(dataOn('2026-01-01'), 'last'))).toMatchObject({ start: '2025-12-22', end: '2025-12-28' });
  });

  it('has the days of a leap year in it', () => {
    const week = must(weekOf(dataOn('2028-02-29'), 'this'));
    expect(week.days.map((day) => day.date)).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
      '2028-03-03',
      '2028-03-04',
      '2028-03-05',
    ]);
  });

  it('goes by the day the figures are as of, never by the clock of this machine', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2031, 2, 15));
      expect(must(weekOf(insightsFixture({ days: 14 }), 'this')).start).toBe('2026-10-05');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the week of a window of seven days, but not the one before it', () => {
    const seven = insightsFixture({ days: 7 });
    expect(weekOf(seven, 'this')).not.toBeNull();
    // 28 September to 4 October is not in 1 to 7 October: unknown days are not days without anything
    expect(weekOf(seven, 'last')).toBeNull();
  });

  it('can be made of the days a report asks for, whichever day of the week it is, but not of one day fewer', () => {
    for (const today of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) {
      expect(weekOf(dataOn(today), 'this'), today).not.toBeNull();
      expect(weekOf(dataOn(today), 'last'), today).not.toBeNull();
    }
    // from a Sunday, the Monday of last week is 13 days back, so that 14 days are needed and 13 do not reach it
    expect(weekOf(dataOn('2026-10-11', [], REPORT_WINDOW_DAYS - 1), 'last')).toBeNull();
  });

  it('is nothing when the figures have no days, or do not say what day it is', () => {
    expect(weekOf(insightsFixture({ days: 14, daily: [] }), 'this')).toBeNull();
    for (const today of ['', 'soon', '2026-02-31', '2026-10-07T10:00:00', '7 October 2026']) {
      expect(weekOf(insightsFixture({ days: 14, today }), 'this')).toBeNull();
    }
  });

  it('adds up how the cards of the week were answered, and says when it cannot', () => {
    expect(must(weekOf(insightsFixture({ days: 14 }), 'this')).answers).toEqual({ total: 3, correct: 2, hard: 1, wrong: 0 });
    expect(must(weekOf(insightsFixture({ days: 14 }), 'last')).answers).toEqual({ total: 10, correct: 7, hard: 2, wrong: 1 });

    const calendar = reviewCalendarFixture();
    const shortCalendar = { ...calendar, days: calendar.days.slice(0, -2) }; // stops on Monday 5 October
    expect(must(weekOf(insightsFixture({ days: 14, reviewCalendar: shortCalendar }), 'this')).answers).toBeNull();
    expect(must(weekOf(insightsFixture({ days: 14, reviewCalendar: shortCalendar }), 'last')).answers).not.toBeNull();
  });
});

describe('the goal', () => {
  const thisWeek = () => must(weekOf(insightsFixture({ days: 14 }), 'this')); // 3 days done, 4 left
  const lastWeek = () => must(weekOf(insightsFixture({ days: 14 }), 'last')); // 1 day done

  it('is not there when none is set', () => {
    expect(goalProgress(thisWeek(), 0)).toBeNull();
    expect(goalProgress(thisWeek(), 12)).toBeNull();
    expect(goalProgress(thisWeek(), undefined)).toBeNull();
  });

  it('is met as soon as enough days were done, and stays met with more', () => {
    expect(goalProgress(thisWeek(), 3)).toEqual({ goal: 3, done: 3, remaining: 0, state: 'met' });
    expect(goalProgress(thisWeek(), 1)).toEqual({ goal: 1, done: 3, remaining: 0, state: 'met' });
    expect(goalProgress(lastWeek(), 1)?.state).toBe('met');
  });

  it('is open while the days that are left are enough, down to the last one', () => {
    expect(goalProgress(thisWeek(), 5)).toEqual({ goal: 5, done: 3, remaining: 2, state: 'open' });
    // 3 done and 4 days left: every one of them is needed, and it can still be done
    expect(goalProgress(thisWeek(), 7)).toEqual({ goal: 7, done: 3, remaining: 4, state: 'open' });
  });

  it('counts today as a day left only while nothing has been done on it', () => {
    // Friday with one day done: Friday, Saturday and Sunday are left
    const friday = must(weekOf(dataOn('2026-10-09', ['2026-10-05']), 'this'));
    expect(friday.daysLeft).toBe(3);
    expect(goalProgress(friday, 4)?.state).toBe('open');
    expect(goalProgress(friday, 5)?.state).toBe('missed');

    // the same Friday, once something was done on it: two days are left, and two are done
    const doneToday = must(weekOf(dataOn('2026-10-09', ['2026-10-05', '2026-10-09']), 'this'));
    expect(doneToday.daysLeft).toBe(2);
    expect(goalProgress(doneToday, 4)?.state).toBe('open');
    expect(goalProgress(doneToday, 5)?.state).toBe('missed');
  });

  it('is missed when too few days are left, and for a week that is over, when it was not reached', () => {
    expect(goalProgress(lastWeek(), 5)).toEqual({ goal: 5, done: 1, remaining: 4, state: 'missed' });
    // on the last day of the week, one more day is all there is to do
    const sunday = must(weekOf(dataOn('2026-10-11', ['2026-10-05']), 'this'));
    expect(goalProgress(sunday, 2)?.state).toBe('open');
    expect(goalProgress(sunday, 3)?.state).toBe('missed');
  });

  it('is put into words that stand on their own', () => {
    const say = (week: Week, goal: number) => describeGoal(week, must(goalProgress(week, goal)));

    expect(say(thisWeek(), 3)).toBe('每周目标 3 天，已达成（学习了 3 天）');
    expect(say(thisWeek(), 5)).toBe('每周目标 5 天，已学习 3 天，还差 2 天，本周还有 4 天可以学');
    const friday = must(weekOf(dataOn('2026-10-09', ['2026-10-05']), 'this'));
    expect(say(friday, 5)).toBe('每周目标 5 天，已学习 1 天，剩下的日子不够补到 5 天了，下周再来');
    expect(say(lastWeek(), 5)).toBe('每周目标 5 天，学习了 1 天，没有达到');
    expect(say(lastWeek(), 1)).toBe('每周目标 1 天，已达成（学习了 1 天）');
  });
});

describe('escapeMarkdown', () => {
  it('leaves words as they are', () => {
    for (const word of ['serendipity', "don't", 'e.g.', 'C++', 'run-of-the-mill', '生词', 'état']) {
      expect(escapeMarkdown(word)).toBe(word);
    }
  });

  it('keeps what Markdown would read as formatting from being read so', () => {
    expect(escapeMarkdown('snake_case')).toBe('snake\\_case');
    expect(escapeMarkdown('*bold* `code` ~gone~')).toBe('\\*bold\\* \\`code\\` \\~gone\\~');
    expect(escapeMarkdown('[link](x) <b>')).toBe('\\[link\\](x) \\<b\\>');
    expect(escapeMarkdown('a|b\\c')).toBe('a\\|b\\\\c');
  });

  it('keeps a word to one line', () => {
    expect(escapeMarkdown('  two\nlines\r\n here ')).toBe('two lines here');
    expect(escapeMarkdown('\n\n')).toBe('');
  });
});

describe('buildWeeklyReport', () => {
  const goalFive = 5;

  it('writes the week as a document of its own, from the figures and nothing else', () => {
    const report = must(buildWeeklyReport(insightsFixture({ days: 14 }), 'this', goalFive));

    expect(report.fileName).toBe('鸽鸽词典周报-2026-10-05.md');
    expect(report.markdown).toBe(
      [
        '# 鸽鸽词典周报',
        '',
        '2026-10-05（周一）至 2026-10-11（周日） · 本周，数据截至 2026-10-07（周三）',
        '',
        '## 概览',
        '',
        '- 学习了 3 天（查词、收藏或复习过的日子）',
        '- 查词 5 次，收藏 2 个，复习 3 张',
        '- 每周目标 5 天，已学习 3 天，还差 2 天，本周还有 4 天可以学',
        '',
        '## 每天',
        '',
        '| 日期 | 查词 | 收藏 | 复习 |',
        '| --- | ---: | ---: | ---: |',
        '| 10月5日 周一 | 1 | 0 | 0 |',
        '| 10月6日 周二 | 0 | 1 | 3 |',
        '| 10月7日 周三 | 4 | 1 | 0 |',
        '| 10月8日 周四 | — | — | — |',
        '| 10月9日 周五 | — | — | — |',
        '| 10月10日 周六 | — | — | — |',
        '| 10月11日 周日 | — | — | — |',
        '',
        '## 复习',
        '',
        '复习 3 张（答对 2，有点难 1），答对率 67%',
        '',
        '## 词库现状（截至 2026-10-07）',
        '',
        '- 生词库共 40 个词，累计查词 156 次',
        '- 掌握程度：新词 20 个，巩固中 10 个，熟悉 6 个，已掌握 4 个',
        '- 连续学习 4 天（最长 6 天），累计学习过 12 天',
        '- 复习库 38 张，今天到期 5 张',
        '- 常查的词：ubiquitous（5 次）、run（3 次）',
        '- 易错的词：serendipity（答错 4 次）、ephemeral（答错 1 次 · 有点难 3 次）',
        '',
        '---',
        '',
        '由鸽鸽词典在本机生成。',
        '',
      ].join('\n'),
    );
  });

  it('writes last week with its own days, and no days to come', () => {
    const data = insightsFixture({ days: 14, reviewCalendar: reviewCalendarFixture({}) });
    const report = must(buildWeeklyReport(data, 'last', 0));

    expect(report.fileName).toBe('鸽鸽词典周报-2026-09-28.md');
    expect(report.markdown).toContain('2026-09-28（周一）至 2026-10-04（周日） · 上周');
    expect(report.markdown).toContain('- 学习了 1 天（查词、收藏或复习过的日子）');
    expect(report.markdown).toContain('- 查词 2 次');
    expect(report.markdown).toContain('| 9月28日 周一 | 0 | 0 | 0 |');
    expect(report.markdown).toContain('| 10月4日 周日 | 2 | 0 | 0 |');
    expect(report.markdown).not.toContain('—');
    expect(report.markdown).not.toContain('数据截至');
    expect(report.markdown).not.toContain('每周目标');
    expect(report.markdown).not.toContain('## 复习');
  });

  it('says that nothing was done, rather than listing zeros as an achievement', () => {
    const report = must(buildWeeklyReport(dataOn('2026-10-07'), 'this', 3));

    expect(report.markdown).toContain('- 本周没有学习记录');
    expect(report.markdown).not.toContain('学习了');
    expect(report.markdown).toContain('- 每周目标 3 天，已学习 0 天，还差 3 天，本周还有 5 天可以学');
    expect(report.markdown).not.toContain('## 复习');
  });

  it('leaves the goal out of a report when there is none, and takes it from the settings as they are', () => {
    const data = insightsFixture({ days: 14 });
    expect(must(buildWeeklyReport(data, 'this', 0)).markdown).not.toContain('每周目标');
    expect(must(buildWeeklyReport(data, 'this', undefined)).markdown).not.toContain('每周目标');
    expect(must(buildWeeklyReport(data, 'this', 99)).markdown).not.toContain('每周目标');
    expect(must(buildWeeklyReport(data, 'this', 3)).markdown).toContain('- 每周目标 3 天，已达成（学习了 3 天）');
  });

  it('does not claim a share of right answers when some answers have no kind', () => {
    const data = insightsFixture({
      days: 14,
      reviewCalendar: reviewCalendarFixture({ '2026-10-06': { total: 5, correct: 1 } }),
    });
    const { markdown } = must(buildWeeklyReport(data, 'this', 0));

    expect(markdown).toContain('\n复习 5 张（答对 1，未记录 4）\n');
    expect(markdown).not.toContain('答对率');
  });

  it('leaves out the rankings that are empty', () => {
    const data = insightsFixture({ days: 14, oftenLookedUp: [], hardWords: [] });
    const { markdown } = must(buildWeeklyReport(data, 'this', 0));

    expect(markdown).not.toContain('常查的词');
    expect(markdown).not.toContain('易错的词');
    expect(markdown).toContain('- 复习库 38 张，今天到期 5 张');
  });

  it('sets the words of the library so that they cannot change the document', () => {
    const data = insightsFixture({
      days: 14,
      oftenLookedUp: [{ lemma: 'snake_case *x*', count: 2 }],
      hardWords: [{ lemma: 'a|b\nc', wrong: 1, hard: 0 }],
    });
    const { markdown } = must(buildWeeklyReport(data, 'this', 0));

    expect(markdown).toContain('- 常查的词：snake\\_case \\*x\\*（2 次）');
    expect(markdown).toContain('- 易错的词：a\\|b c（答错 1 次）');
  });

  it('is nothing when the figures do not reach the whole week, since a report with a hole in it would say too little', () => {
    expect(buildWeeklyReport(insightsFixture({ days: 7 }), 'last', 0)).toBeNull();
    expect(buildWeeklyReport(insightsFixture({ days: 14, daily: [] }), 'this', 0)).toBeNull();
  });

  it('is a document that ends with a line break, with no stray blank lines in a row', () => {
    const { markdown } = must(buildWeeklyReport(insightsFixture({ days: 14 }), 'this', 5));

    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown).not.toMatch(/\n{3,}/);
    expect(markdown).not.toContain('\r');
  });
});
