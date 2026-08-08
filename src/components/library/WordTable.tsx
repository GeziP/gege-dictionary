import React from 'react';
import type { SavedWord } from '../../types/lexnote';
import { classNames, relativeTime } from '../../utils/format';
import { Chip } from '../ui/Chip';
import { MasteryBadge } from '../ui/MasteryBadge';

interface WordTableProps {
  words: SavedWord[];
  density: 'table' | 'cards';
  selectedIds: string[];
  activeId: string | null;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onActivate: (id: string) => void;
}

export function WordTable({
  words,
  density,
  selectedIds,
  activeId,
  onToggleSelect,
  onToggleAll,
  onActivate
}: WordTableProps) {
  if (words.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
        <p className="text-sm text-ink">没有匹配的生词</p>
        <p className="text-xs text-ink-subtle">换个关键词，或清除左侧的筛选条件。</p>
      </div>);

  }

  if (density === 'cards') {
    return (
      <div className="thin-scroll grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(238px,1fr))] content-start gap-2.5 overflow-y-auto p-3">
        {words.map((word) =>
        <button
          key={word.id}
          type="button"
          onClick={() => onActivate(word.id)}
          className={classNames(
            'flex flex-col rounded-lg border bg-surface p-3 text-left transition-colors',
            activeId === word.id ? 'border-accent' : 'border-line hover:border-line-strong'
          )}>
          
            <div className="flex items-baseline gap-2">
              <span className="font-serif text-[17px] font-bold text-ink">{word.lemma}</span>
              <span className="font-ipa text-[11px] text-ink-subtle">{word.ipaUS}</span>
              <span className="ml-auto shrink-0"><MasteryBadge mastery={word.mastery} compact /></span>
            </div>
            <p className="mt-1 text-[13px] text-ink">{word.translation}</p>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-subtle">{word.contextMeaning}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {word.tags.map((tag) =>
            <Chip key={tag} label={tag} tone="muted" />
            )}
            </div>
            <p className="mt-2 text-[10px] text-ink-subtle">
              {word.sourceApp} · {relativeTime(word.savedAt)}
            </p>
          </button>
        )}
      </div>);

  }

  const allSelected = selectedIds.length === words.length;

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">生词列表，点击单词打开详情</caption>
        <thead className="sticky top-0 z-10 bg-raised">
          <tr className="border-b border-line text-2xs tracking-wide text-ink-subtle">
            <th scope="col" className="w-10 px-3 py-2">
              <input
                type="checkbox"
                aria-label="全选当前列表"
                checked={allSelected}
                onChange={onToggleAll}
                className="h-3.5 w-3.5 accent-[color:var(--accent)]"
              />
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">单词</th>
            <th scope="col" className="py-2 pr-3 font-medium">翻译</th>
            <th scope="col" className="hidden py-2 pr-3 font-medium xl:table-cell">标签</th>
            <th scope="col" className="hidden py-2 pr-3 font-medium lg:table-cell">来源</th>
            <th scope="col" className="py-2 pr-3 font-medium">收藏时间</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">查询次数</th>
            <th scope="col" className="py-2 pr-3 font-medium">掌握度</th>
          </tr>
        </thead>
        <tbody>
          {words.map((word) => (
            <tr
              key={word.id}
              className={classNames(
                'border-b border-line transition-colors',
                activeId === word.id ? 'bg-accent-soft' : 'hover:bg-raised',
              )}
            >
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`选择 ${word.lemma}`}
                  checked={selectedIds.includes(word.id)}
                  onChange={() => onToggleSelect(word.id)}
                  className="h-3.5 w-3.5 accent-[color:var(--accent)]"
                />
              </td>
              <td className="py-1 pr-3">
                <button
                  type="button"
                  onClick={() => onActivate(word.id)}
                  className="-mx-1 flex items-baseline gap-1.5 rounded-sm px-1 py-1 text-left hover:underline"
                >
                  <span className="font-serif text-base font-bold text-ink">{word.lemma}</span>
                  <span className="text-2xs text-ink-subtle">{word.pos}</span>
                </button>
              </td>
              <td className="max-w-[12rem] truncate py-2 pr-3 text-ink-muted">{word.translation}</td>
              <td className="hidden py-2 pr-3 xl:table-cell">
                <span className="flex flex-wrap items-center gap-1">
                  {word.tags.slice(0, 2).map((tag) => (
                    <Chip key={tag} label={tag} tone="muted" />
                  ))}
                  {word.tags.length > 2 ? (
                    <span className="text-2xs text-ink-subtle">+{word.tags.length - 2}</span>
                  ) : null}
                </span>
              </td>
              <td className="hidden max-w-[9rem] truncate py-2 pr-3 text-ink-subtle lg:table-cell">
                {word.sourceApp}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-ink-subtle">{relativeTime(word.savedAt)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-ink-subtle">{word.lookups}</td>
              <td className="py-2 pr-3">
                <MasteryBadge mastery={word.mastery} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}