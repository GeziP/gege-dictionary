import type { SavedWord } from '../types/lexnote';
import { absoluteTime } from './format';

export type ExportField =
'lemma' |
'ipaUS' |
'pos' |
'translation' |
'contextMeaning' |
'examples' |
'context' |
'tags' |
'source' |
'savedAt';

export const FIELD_LABELS: Record<ExportField, string> = {
  lemma: '单词',
  ipaUS: '美式音标',
  pos: '词性',
  translation: '翻译',
  contextMeaning: '语境释义',
  examples: '例句',
  context: '收藏时的原句',
  tags: '标签',
  source: '来源',
  savedAt: '收藏时间'
};

function valueOf(word: SavedWord, field: ExportField): string {
  switch (field) {
    case 'examples':
      return word.examples.map((example) => `${example.en} — ${example.zh}`).join(' | ');
    case 'tags':
      return word.tags.join(',');
    case 'source':
      return `${word.sourceApp} · ${word.sourceTitle}`;
    case 'savedAt':
      return absoluteTime(word.savedAt);
    default:
      return String(word[field] ?? '');
  }
}

export function toCSV(words: SavedWord[], fields: ExportField[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const header = fields.map((field) => escape(FIELD_LABELS[field])).join(',');
  const rows = words.map((word) => fields.map((field) => escape(valueOf(word, field))).join(','));
  return [header, ...rows].join('\n');
}

export function toMarkdown(words: SavedWord[], fields: ExportField[]): string {
  return words.
  map((word) => {
    const lines = [`## ${word.lemma}${word.ipaUS && fields.includes('ipaUS') ? `  ${word.ipaUS}` : ''}`];
    if (fields.includes('translation')) lines.push(`**${word.translation}**`);
    if (fields.includes('contextMeaning')) lines.push(word.contextMeaning);
    if (fields.includes('examples') && word.examples.length) {
      lines.push(...word.examples.map((example) => `- ${example.en}\n  ${example.zh}`));
    }
    if (fields.includes('context') && word.context) lines.push(`> ${word.context}`);
    if (fields.includes('tags') && word.tags.length) lines.push(word.tags.map((tag) => `#${tag}`).join(' '));
    if (fields.includes('source')) lines.push(`_${valueOf(word, 'source')}_`);
    return lines.join('\n\n');
  }).
  join('\n\n---\n\n');
}

export function toAnkiTSV(words: SavedWord[], front: ExportField, back: ExportField[]): string {
  return words.
  map((word) => {
    const backHtml = back.
    map((field) => `<div>${valueOf(word, field).replace(/\t/g, ' ')}</div>`).
    join('');
    return `${valueOf(word, front)}\t${backHtml}\t${word.tags.join(' ')}`;
  }).
  join('\n');
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}