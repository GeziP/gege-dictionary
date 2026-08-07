import { lookupEntry } from '../data/entries';
import type { Entry, SelectionKind } from '../types/lexnote';

export function detectKind(selection: string): SelectionKind {
  const trimmed = selection.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) return 'word';
  if (words.length <= 4 && !/[.!?;]/.test(trimmed)) return 'phrase';
  return 'sentence';
}

export const MAX_SELECTION = 500;

export function truncateSelection(selection: string): {text: string;truncated: boolean;} {
  if (selection.length <= MAX_SELECTION) return { text: selection, truncated: false };
  return { text: selection.slice(0, MAX_SELECTION), truncated: true };
}

/** Grabs roughly 200 characters either side of the selection, snapped to sentence bounds. */
export function extractContext(fullText: string, selection: string): string {
  const index = fullText.indexOf(selection);
  if (index === -1) return fullText.slice(0, 240);
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selection.length + 200);
  let snippet = fullText.slice(start, end).trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < fullText.length) snippet = snippet + '…';
  return snippet;
}

export function resolveEntry(selection: string): Entry | null {
  return lookupEntry(selection);
}

/** Plain-text rendering used when the model returns non-JSON output. */
export function toPlainText(entry: Entry): string {
  return [
  `${entry.lemma} ${entry.pos} ${entry.ipaUS}`,
  `翻译：${entry.translation}`,
  `语境义：${entry.contextMeaning}`,
  `解释：${entry.explanation}`,
  ...entry.examples.map((e, i) => `例 ${i + 1}. ${e.en} / ${e.zh}`)].
  join('\n');
}