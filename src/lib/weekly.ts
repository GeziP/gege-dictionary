import { addDays, format, isValid, parseISO, startOfWeek } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { InsightsDay, LearningInsights } from '../types/lexnote';
import {
  MASTERY_LABELS,
  MASTERY_LEVELS,
  accuracyPercent,
  dayLabel,
  dayTotal,
  describeCounts,
  describeHardWord,
  describeReviewTotals,
  type ReviewAnswers,
} from './insights';

/** What a weekly goal can ask for, in days of the week; 0 is no goal. */
export const GOAL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/**
 * How many days of figures reach back to the Monday of last week from any day of this one
 * (from a Sunday that is 13 days ago): what a report of either week has to be made from.
 */
export const REPORT_WINDOW_DAYS = 14;

/** A week starts on Monday, the way the review calendar's weeks do. */
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_KEY = 'yyyy-MM-dd';

/**
 * The goal that is really in force for what the settings say: 1 to 7 days a week. Anything
 * else (nothing, zero, a number that no week can meet, a leftover of some other kind) is no goal.
 */
export function effectiveGoalDays(setting: unknown): number {
  return typeof setting === 'number' && Number.isInteger(setting) && setting >= 1 && setting <= 7 ? setting : 0;
}

export type WeekChoice = 'this' | 'last';

export interface WeekDay {
  /** yyyy-MM-dd. */
  date: string;
  /** 周一 to 周日. */
  name: string;
  /** What happened. A day that has not come yet is all zeros, which is not the same as nothing happening. */
  counts: InsightsDay;
  upcoming: boolean;
  today: boolean;
  /** Something was looked up, saved or reviewed: the same measure the streak is counted in. */
  active: boolean;
}

export interface Week {
  choice: WeekChoice;
  /** The Monday, yyyy-MM-dd. */
  start: string;
  /** The Sunday. */
  end: string;
  /** The day the figures are as of. */
  asOf: string;
  /** Monday to Sunday. */
  days: WeekDay[];
  lookups: number;
  saved: number;
  reviews: number;
  /** The days with something done. */
  activeDays: number;
  /** The days on which something can still be done: those to come, and today while nothing has been. */
  daysLeft: number;
  /** How the week's review cards were answered; null when the calendar does not reach the whole week. */
  answers: ReviewAnswers | null;
}

function parseDay(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = parseISO(text);
  return isValid(day) ? day : null;
}

/**
 * The calendar week (Monday to Sunday) that today is in, or the one before it, made of the
 * figures' own days. It is null when those do not reach back to the whole of it: a week that
 * is shown with days missing would count what is merely unknown as nothing done.
 */
export function weekOf(
  data: Pick<LearningInsights, 'today' | 'daily' | 'reviewCalendar'>,
  choice: WeekChoice,
): Week | null {
  const today = parseDay(data.today);
  if (!today) return null;
  const asOf = format(today, DAY_KEY);
  const monday = addDays(startOfWeek(today, { weekStartsOn: 1 }), choice === 'last' ? -7 : 0);
  const recorded = new Map(data.daily.map((day) => [day.date, day] as const));
  const reviewed = new Map(data.reviewCalendar.days.map((day) => [day.date, day] as const));

  const days: WeekDay[] = [];
  const answers: ReviewAnswers = { total: 0, correct: 0, hard: 0, wrong: 0 };
  let answersKnown = true;
  for (let index = 0; index < WEEKDAY_NAMES.length; index += 1) {
    const date = format(addDays(monday, index), DAY_KEY);
    const upcoming = date > asOf;
    const counts = recorded.get(date);
    if (!counts && !upcoming) return null;
    const shown = counts ?? { date, lookups: 0, saved: 0, reviews: 0 };
    days.push({
      date,
      name: WEEKDAY_NAMES[index],
      counts: shown,
      upcoming,
      today: date === asOf,
      active: dayTotal(shown) > 0,
    });
    if (upcoming) continue;
    const answered = reviewed.get(date);
    if (!answered) {
      answersKnown = false;
      continue;
    }
    answers.total += answered.total;
    answers.correct += answered.correct;
    answers.hard += answered.hard;
    answers.wrong += answered.wrong;
  }

  const sum = (key: 'lookups' | 'saved' | 'reviews') => days.reduce((total, day) => total + day.counts[key], 0);
  return {
    choice,
    start: format(monday, DAY_KEY),
    end: format(addDays(monday, WEEKDAY_NAMES.length - 1), DAY_KEY),
    asOf,
    days,
    lookups: sum('lookups'),
    saved: sum('saved'),
    reviews: sum('reviews'),
    activeDays: days.filter((day) => day.active).length,
    daysLeft: days.filter((day) => day.upcoming || (day.today && !day.active)).length,
    answers: answersKnown ? answers : null,
  };
}

export type GoalState = 'met' | 'open' | 'missed';

export interface GoalProgress {
  /** The days of the week the goal asks for. */
  goal: number;
  /** The days of the week with something done. */
  done: number;
  remaining: number;
  /** `open` while the days that are left are enough for the days that are missing; `missed` once they are not. */
  state: GoalState;
}

/** How far the week is to the goal, or null when there is none. */
export function goalProgress(week: Week, setting: unknown): GoalProgress | null {
  const goal = effectiveGoalDays(setting);
  if (goal === 0) return null;
  const done = week.activeDays;
  const remaining = Math.max(0, goal - done);
  const state: GoalState = remaining === 0 ? 'met' : remaining <= week.daysLeft ? 'open' : 'missed';
  return { goal, done, remaining, state };
}

/** Where the week stands to the goal, as a sentence that needs nothing around it. */
export function describeGoal(week: Week, { goal, done, remaining, state }: GoalProgress): string {
  const target = `每周目标 ${goal} 天`;
  if (state === 'met') return `${target}，已达成（学习了 ${done} 天）`;
  if (state === 'open') return `${target}，已学习 ${done} 天，还差 ${remaining} 天，本周还有 ${week.daysLeft} 天可以学`;
  return week.choice === 'this'
    ? `${target}，已学习 ${done} 天，剩下的日子不够补到 ${goal} 天了，下周再来`
    : `${target}，学习了 ${done} 天，没有达到`;
}

/**
 * A word, a source or anything else that came from the library, safe to set in a line of
 * Markdown: kept to one line, and with nothing in it that would be read as formatting.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

const dateWithWeekday = (date: string): string => `${date}（${format(parseISO(date), 'EEE', { locale: zhCN })}）`;
const tableRow = (cells: Array<string | number>): string => `| ${cells.join(' | ')} |`;
/** What stands in the table for a day that has not come: not zero, because nothing is known yet. */
const NOT_YET = '—';

export interface WeeklyReport {
  fileName: string;
  markdown: string;
}

/**
 * The week as a Markdown document, from the figures alone: nothing in it is made up, and every
 * number is one the page shows or adds up from what it shows. Null when the figures do not
 * reach the whole week.
 */
export function buildWeeklyReport(
  data: LearningInsights,
  choice: WeekChoice,
  goalSetting: unknown,
): WeeklyReport | null {
  const week = weekOf(data, choice);
  if (!week) return null;
  const name = choice === 'this' ? '本周' : '上周';
  const progress = goalProgress(week, goalSetting);

  const lines = [
    '# 鸽鸽词典周报',
    '',
    `${dateWithWeekday(week.start)}至 ${dateWithWeekday(week.end)} · ${
      choice === 'this' ? `本周，数据截至 ${dateWithWeekday(week.asOf)}` : '上周'
    }`,
    '',
    '## 概览',
    '',
  ];
  if (week.activeDays === 0) {
    lines.push(`- ${name}没有学习记录`);
  } else {
    lines.push(`- 学习了 ${week.activeDays} 天（查词、收藏或复习过的日子）`, `- ${describeCounts(week)}`);
  }
  if (progress) lines.push(`- ${describeGoal(week, progress)}`);

  lines.push('', '## 每天', '', '| 日期 | 查词 | 收藏 | 复习 |', '| --- | ---: | ---: | ---: |');
  for (const day of week.days) {
    lines.push(
      day.upcoming
        ? tableRow([dayLabel(day.date), NOT_YET, NOT_YET, NOT_YET])
        : tableRow([dayLabel(day.date), day.counts.lookups, day.counts.saved, day.counts.reviews]),
    );
  }

  const { answers } = week;
  if (answers && answers.total > 0) {
    // A share of the answers is only a share of all of them when every answer's kind is known.
    const accuracy =
      answers.correct + answers.hard + answers.wrong === answers.total
        ? accuracyPercent(answers.correct, answers.wrong, answers.hard)
        : null;
    lines.push(
      '',
      '## 复习',
      '',
      accuracy === null ? describeReviewTotals(answers) : `${describeReviewTotals(answers)}，答对率 ${accuracy}%`,
    );
  }

  const { totals, streak, review, mastery } = data;
  lines.push(
    '',
    `## 词库现状（截至 ${week.asOf}）`,
    '',
    `- 生词库共 ${totals.words} 个词，累计查词 ${totals.lookups} 次`,
    `- 掌握程度：${MASTERY_LEVELS.map((level) => `${MASTERY_LABELS[level]} ${mastery[level] ?? 0} 个`).join('，')}`,
    `- 连续学习 ${streak.current} 天（最长 ${streak.longest} 天），累计学习过 ${streak.activeDays} 天`,
    `- 复习库 ${review.total} 张，今天到期 ${review.dueToday} 张`,
  );
  if (data.oftenLookedUp.length > 0) {
    lines.push(
      `- 常查的词：${data.oftenLookedUp.map((item) => `${escapeMarkdown(item.lemma)}（${item.count} 次）`).join('、')}`,
    );
  }
  if (data.hardWords.length > 0) {
    lines.push(
      `- 易错的词：${data.hardWords.map((item) => `${escapeMarkdown(item.lemma)}（${describeHardWord(item)}）`).join('、')}`,
    );
  }
  lines.push('', '---', '', '由鸽鸽词典在本机生成。', '');

  return { fileName: `鸽鸽词典周报-${week.start}.md`, markdown: lines.join('\n') };
}
