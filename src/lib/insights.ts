import { format, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type {
  InsightsDay,
  LearningInsights,
  Mastery,
  ReviewCalendar,
  ReviewCalendarDay,
} from '../types/lexnote';

/** The ranges the page offers, in days. The backend keeps a window between a week and a quarter. */
export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export const MASTERY_LEVELS: Mastery[] = ['new', 'learning', 'familiar', 'mastered'];

/** What each level is called, in the badge, the charts and the weekly report alike. */
export const MASTERY_LABELS: Record<Mastery, string> = {
  new: '新词',
  learning: '巩固中',
  familiar: '熟悉',
  mastered: '已掌握',
};

/**
 * Right answers as a percentage of all answers, or `null` while nothing was answered. A card
 * that was found hard was not answered right. Rounding never claims more than the truth: 100
 * only when every answer was right, 0 only when none was.
 */
export function accuracyPercent(correct: number, wrong: number, hard = 0): number | null {
  const answered = correct + hard + wrong;
  if (answered <= 0) return null;
  if (correct >= answered) return 100;
  if (correct <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round((correct / answered) * 100)));
}

/** "答对 75 次，有点难 10 次，答错 25 次"; what was never the answer is left out, apart from right and wrong. */
export function describeAnswers({ correct, hard, wrong }: { correct: number; hard: number; wrong: number }): string {
  return [`答对 ${correct} 次`, hard > 0 ? `有点难 ${hard} 次` : '', `答错 ${wrong} 次`].filter(Boolean).join('，');
}

/** What is said under a word in the ranking of the ones that were missed. */
export function describeHardWord({ wrong, hard }: { wrong: number; hard: number }): string {
  return [wrong > 0 ? `答错 ${wrong} 次` : '', hard > 0 ? `有点难 ${hard} 次` : ''].filter(Boolean).join(' · ');
}

/** How much a word weighs in that ranking: forgetting it counts twice as much as finding it hard, as the backend ranks. */
export const hardWordWeight = ({ wrong, hard }: { wrong: number; hard: number }): number => wrong * 2 + hard;

/** "10月7日 周三", or the text as it came when it is not a date. */
export function dayLabel(date: string): string {
  const parsed = parseISO(date);
  return Number.isNaN(parsed.getTime()) ? date : format(parsed, 'M月d日 EEE', { locale: zhCN });
}

type Counts = Pick<InsightsDay, 'lookups' | 'saved' | 'reviews'>;

/** "查词 4 次，收藏 1 个，复习 2 张": only what happened; "没有记录" when nothing did. */
export function describeCounts({ lookups, saved, reviews }: Counts): string {
  const parts: string[] = [];
  if (lookups > 0) parts.push(`查词 ${lookups} 次`);
  if (saved > 0) parts.push(`收藏 ${saved} 个`);
  if (reviews > 0) parts.push(`复习 ${reviews} 张`);
  return parts.length > 0 ? parts.join('，') : '没有记录';
}

export const describeDay = (day: InsightsDay): string => `${dayLabel(day.date)}：${describeCounts(day)}`;

export const dayTotal = (counts: Counts): number => counts.lookups + counts.saved + counts.reviews;

/** The most that happened on a single day of the window. */
export const busiestDay = (daily: InsightsDay[]): number => daily.reduce((most, day) => Math.max(most, dayTotal(day)), 0);

/**
 * The chart is never scaled to less than this, so that a quiet day of a lookup or two
 * is a short bar rather than a full one.
 */
const MIN_SCALE = 5;
/** A day with anything in it stays this tall at least, or it would vanish beside a busy one. */
const MIN_VISIBLE = 0.05;

export interface ChartBar {
  day: InsightsDay;
  /** How tall the bar is, as a share (0 to 1) of the chart's height. */
  height: number;
}

export function chartBars(daily: InsightsDay[]): ChartBar[] {
  const scale = Math.max(MIN_SCALE, busiestDay(daily));
  return daily.map((day) => {
    const total = dayTotal(day);
    return { day, height: total > 0 ? Math.min(1, Math.max(MIN_VISIBLE, total / scale)) : 0 };
  });
}

export interface MasterySegment {
  level: Mastery;
  count: number;
  /** Share of all words, 0 to 1. */
  share: number;
  /** The same, as a rounded percentage. */
  percent: number;
}

/** The four levels in order, with how much of the library each one is (all zero for an empty library). */
export function masterySegments(mastery: Record<Mastery, number>): MasterySegment[] {
  const total = MASTERY_LEVELS.reduce((sum, level) => sum + (mastery[level] ?? 0), 0);
  return MASTERY_LEVELS.map((level) => {
    const count = mastery[level] ?? 0;
    const share = total > 0 ? count / total : 0;
    return { level, count, share, percent: Math.round(share * 100) };
  });
}

/** The width (a percentage) of one bar in a ranking, relative to the largest; never invisible. */
export const rankShare = (value: number, largest: number): number =>
  largest > 0 && value > 0 ? Math.min(100, Math.max(4, Math.round((value / largest) * 100))) : 0;

/** One sentence under the streak: what it is, or what to do to keep it. */
export function streakNote({ streak, daily }: Pick<LearningInsights, 'streak' | 'daily'>): string {
  if (streak.activeDays === 0) return '查一个词、收藏一个词或复习一张卡片，就开始计数';
  if (streak.current === 0) return `最长连续 ${streak.longest} 天，今天开始新的记录`;
  const today = daily[daily.length - 1];
  if (today && dayTotal(today) === 0) return `今天还没有学习，继续就不会断（最长 ${streak.longest} 天）`;
  return streak.longest > streak.current ? `最长连续 ${streak.longest} 天` : '这就是你的最长连续记录';
}

/** Whether there is nothing to show yet: no words, no lookups and no active day. */
export const isBlank = ({ totals, streak, review }: LearningInsights): boolean =>
  totals.words === 0 && totals.lookups === 0 && streak.activeDays === 0 && review.total === 0;

/** How dark a day of the review calendar is drawn: 0 for none, 4 for the busiest day. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** The darkness of a day, in quarters of the busiest day; any answer at all is at least a quarter. */
export function heatLevel(total: number, busiest: number): HeatLevel {
  if (total <= 0 || busiest <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((total / busiest) * 4))) as HeatLevel;
}

/** The most cards answered on a single day of the calendar. */
export const busiestReviewDay = (days: ReviewCalendarDay[]): number =>
  days.reduce((most, day) => Math.max(most, day.total), 0);

export interface CalendarCell {
  day: ReviewCalendarDay;
  level: HeatLevel;
}

/**
 * The calendar as weeks, oldest first, each with its days from Monday on (the backend starts
 * the calendar on a Monday). The last week stops at today.
 */
export function calendarWeeks(calendar: ReviewCalendar): CalendarCell[][] {
  const busiest = busiestReviewDay(calendar.days);
  const weeks: CalendarCell[][] = [];
  calendar.days.forEach((day, index) => {
    if (index % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ day, level: heatLevel(day.total, busiest) });
  });
  return weeks;
}

/** How many review cards were answered, over some days or one, and how. */
export type ReviewAnswers = Pick<ReviewCalendarDay, 'total' | 'correct' | 'hard' | 'wrong'>;

/**
 * "复习 12 张（答对 9，有点难 2，答错 1）", or "没有复习". Answers whose kind was not recorded
 * are in the total but not in the brackets, which then say how many there are.
 */
export function describeReviewTotals(answers: ReviewAnswers): string {
  if (answers.total <= 0) return '没有复习';
  const parts: string[] = [];
  if (answers.correct > 0) parts.push(`答对 ${answers.correct}`);
  if (answers.hard > 0) parts.push(`有点难 ${answers.hard}`);
  if (answers.wrong > 0) parts.push(`答错 ${answers.wrong}`);
  const unknown = answers.total - answers.correct - answers.hard - answers.wrong;
  if (unknown > 0) parts.push(`未记录 ${unknown}`);
  return `复习 ${answers.total} 张（${parts.join('，')}）`;
}

/** "10月7日 周三：复习 12 张（答对 9，有点难 2，答错 1）". */
export const describeReviewDay = (day: ReviewCalendarDay): string => `${dayLabel(day.date)}：${describeReviewTotals(day)}`;

/** "近 12 周复习了 31 张，分布在 6 天", or that there was nothing. */
export function describeCalendar(calendar: ReviewCalendar): string {
  const total = calendar.days.reduce((sum, day) => sum + day.total, 0);
  const active = calendar.days.filter((day) => day.total > 0).length;
  return total > 0 ? `近 ${calendar.weeks} 周复习了 ${total} 张，分布在 ${active} 天` : `近 ${calendar.weeks} 周没有复习`;
}
