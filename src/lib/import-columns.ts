/**
 * What the columns of a word list are usually called, for each of the fields a saved word has.
 * The names are compared without case, spaces, dashes and underscores, so `Part of Speech`,
 * `part_of_speech` and `partOfSpeech` are all the same name.
 */
const ALIASES: Record<string, string[]> = {
  lemma: ['word', 'words', 'term', 'vocab', 'vocabulary', 'headword', 'front', '单词', '词', '词汇', '词条', '英文', '英语'],
  translation: ['meaning', 'definition', 'def', 'back', '翻译', '释义', '中文', '含义', '意思', '词义', '中文释义'],
  pos: ['partofspeech', '词性'],
  contextMeaning: ['contextmeaning', '上下文释义', '语境释义'],
  explanation: ['usage', 'explanation', '用法', '用法说明', '解释', '详细解释'],
  note: ['notes', 'remark', 'remarks', 'comment', 'comments', '备注', '笔记', '注释'],
  tags: ['tag', 'category', 'categories', 'label', 'labels', '标签', '分类'],
};

const normalize = (name: string): string =>
  name
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./]+/g, '');

/**
 * Which column of the file holds which field of a word, as far as the names of the columns say.
 * `fields` are the fields in the order that matters when two of them could take the same column
 * (the first gets it); a column is never given to two fields. What is not found is not in the
 * answer, and the user chooses it.
 */
export function guessMapping(columns: string[], fields: readonly string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const taken = new Set<string>();
  for (const field of fields) {
    const names = new Set([field, ...(ALIASES[field] ?? [])].map(normalize));
    const column = columns.find((name) => !taken.has(name) && names.has(normalize(name)));
    if (column !== undefined) {
      mapping[field] = column;
      taken.add(column);
    }
  }
  return mapping;
}
