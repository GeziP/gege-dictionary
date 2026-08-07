import { formatDistanceToNowStrict, format } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export function relativeTime(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: zhCN });
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