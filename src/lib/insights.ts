import { format, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { InsightsDay, LearningInsights, Mastery } from '../types/lexnote';

/** The ranges the page offers, in days. The backend keeps a window between a week and a quarter. */
export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export const MASTERY_LEVELS: Mastery[] = ['new', 'learning', 'familiar', 'mastered'];

/**
 * Right answers as a percentage of all answers, or `null` while nothing was answered.
 * Rounding never claims more than the truth: 100 only without a mistake, 0 only without a success.
 */
export function accuracyPercent(correct: number, wrong: number): number | null {
  if (correct + wrong <= 0) return null;
  if (wrong <= 0) return 100;
  if (correct <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round((correct / (correct + wrong)) * 100)));
}

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
