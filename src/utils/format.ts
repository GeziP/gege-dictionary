import { differenceInCalendarDays, formatDistanceToNowStrict, format, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export function relativeTime(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: zhCN });
}

/**
 * When something is next due, as a person would say it: "今天", "明天", "3 天后". The date is the
 * `yyyy-MM-dd` of the user's own day, as the backend keeps the review dates; anything else is
 * shown as it came.
 */
export function dueText(date: string, now: Date = new Date()): string {
  const days = differenceInCalendarDays(parseISO(date), now);
  if (Number.isNaN(days)) return date;
  if (days <= 0) return '今天';
  if (days === 1) return '明天';
  return `${days} 天后`;
}

/** What a failed call says: the backend sends its reason as a plain string, anything else as an `Error`. */
export function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : String(reason);
}

export function absoluteTime(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd HH:mm');
}

export function shortDate(iso: string): string {
  return format(new Date(iso), 'MM-dd');
}

/** Splits text so the target term can be highlighted in example sentences. */
export function splitOnTerm(text: string, term: string): {chunk: string;hit: boolean;}[] {
  const stem = term.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z]/g, '');
  if (stem.length < 3) return [{ chunk: text, hit: false }];
  const root = stem.length > 5 ? stem.slice(0, stem.length - 2) : stem;
  const re = new RegExp(`(${root}[a-z]*)`, 'gi');
  const parts = text.split(re);
  return parts.
  filter((p) => p.length > 0).
  map((p) => ({ chunk: p, hit: p.toLowerCase().startsWith(root) }));
}

export function classNames(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}