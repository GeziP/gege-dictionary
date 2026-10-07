import { differenceInCalendarDays, format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { LookupHistoryItem, SavedWord } from '../types/lexnote';

/**
 * How the library tells two spellings apart when it looks for a saved word:
 * spacing and letter case do not matter. The backend uses the same rule.
 */
export function lemmaKey(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

const KEY_SEPARATOR = '\u001f';

const savedKey = (lemma: string, kind: string) => `${lemmaKey(lemma)}${KEY_SEPARATOR}${kind}`;

/** The saved words, reduced to what is needed to ask "is this lookup already in my library?". */
export function savedLookupKeys(words: Pick<SavedWord, 'lemma' | 'kind'>[]): Set<string> {
  return new Set(words.map((word) => savedKey(word.lemma, word.kind ?? 'word')));
}

/**
 * Whether the thing that was looked up has been saved. A saved word is stored under the
 * lemma the answer gave, so that is what is compared; a lookup that got no lemma is
 * compared by its text.
 */
export function isSavedLookup(
  item: Pick<LookupHistoryItem, 'lemma' | 'selection' | 'kind'>,
  keys: Set<string>,
): boolean {
  const lemma = item.lemma.trim() || item.selection;
  return keys.has(savedKey(lemma, item.kind));
}

/**
 * Whether to show the lemma next to a looked-up word ("running → run"). For sentences the
 * lemma is the sentence itself, which would only repeat what is already on screen.
 */
export function showsLemma(item: Pick<LookupHistoryItem, 'lemma' | 'selection' | 'kind'>): boolean {
  if (item.kind !== 'word' && item.kind !== 'phrase') return false;
  const lemma = lemmaKey(item.lemma);
  return lemma !== '' && lemma !== lemmaKey(item.selection);
}

/** Every word of the query has to appear somewhere in what the entry shows; case is ignored. */
export function filterHistory(items: LookupHistoryItem[], query: string): LookupHistoryItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystack = [item.selection, item.lemma, item.translation, item.sourceApp, item.sourceTitle]
      .join('\n')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** "今天", "昨天", the weekday for this year, and the full date for earlier years. */
export function dayLabel(date: Date, now: Date): string {
  const daysAgo = differenceInCalendarDays(now, date);
  if (daysAgo <= 0) return '今天';
  if (daysAgo === 1) return '昨天';
  if (date.getFullYear() === now.getFullYear()) return format(date, 'M月d日 EEEE', { locale: zhCN });
  return format(date, 'yyyy年M月d日', { locale: zhCN });
}

export interface HistoryDay {
  /** Local calendar day (yyyy-MM-dd), or `unknown` for an entry without a usable time. */
  key: string;
  label: string;
  items: LookupHistoryItem[];
}

/**
 * Splits the history (newest first) into local calendar days, keeping the order.
 * Entries whose time cannot be read are kept, under their own heading, rather than dropped.
 */
export function groupHistoryByDay(items: LookupHistoryItem[], now: Date = new Date()): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const item of items) {
    const when = new Date(item.lastAt);
    const known = !Number.isNaN(when.getTime());
    const key = known ? format(when, 'yyyy-MM-dd') : 'unknown';
    const last = days[days.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      days.push({ key, label: known ? dayLabel(when, now) : '时间未知', items: [item] });
    }
  }
  return days;
}

/** The local time of day of the latest lookup, or an empty string when it cannot be read. */
export function timeOfDay(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? '' : format(when, 'HH:mm');
}
