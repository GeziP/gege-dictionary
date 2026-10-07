import React from 'react';
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon } from 'lucide-react';
import type { SortField, SortState } from '../../lib/library-list';
import type { SavedWord } from '../../types/lexnote';
import { classNames, relativeTime } from '../../utils/format';
import { Chip } from '../ui/Chip';
import { MasteryBadge } from '../ui/MasteryBadge';

interface WordTableProps {
  words: SavedWord[];
  density: 'table' | 'cards';
  selectedIds: ReadonlySet<string>;
  /** Whether every word in `words` is selected (and there is at least one). */
  allSelected: boolean;
  activeId: string | null;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onActivate: (id: string) => void;
}

function SortIcon({ field, sort }: { field: SortField; sort?: SortState }) {
  if (!sort || sort.field !== field) return <ArrowUpDownIcon size={11} className="ml-0.5 inline opacity-30" />;
  return sort.dir === 'asc'
    ? <ArrowUpIcon size={11} className="ml-0.5 inline text-accent" />
    : <ArrowDownIcon size={11} className="ml-0.5 inline text-accent" />;
}

interface RowProps {
  word: SavedWord;
  selected: boolean;
  active: boolean;
  onToggleSelect: (id: string) => void;
  onActivate: (id: string) => void;
}

// Rows are memoized: selecting one word or opening another changes the props of two rows, not of
// every row in a library of thousands, so the rest are not rendered again.
const WordRow = React.memo(function WordRow({ word, selected, active, onToggleSelect, onActivate }: RowProps) {
  return (
    <tr
      className={classNames(
        'border-b border-line transition-colors',
        active ? 'bg-accent-soft' : 'hover:bg-raised',
      )}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          aria-label={`选择 ${word.lemma}`}
          checked={selected}
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
  );
});

const WordCard = React.memo(function WordCard({
  word,
  active,
  onActivate,
}: {
  word: SavedWord;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onActivate(word.id)}
      className={classNames(
        'flex flex-col rounded-lg border bg-surface p-3 text-left transition-colors',
        active ? 'border-accent' : 'border-line hover:border-line-strong'
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
  );
});

export function WordTable({
  words,
  density,
  selectedIds,
  allSelected,
  activeId,
  sort,
  onSortChange,
  onToggleSelect,
  onToggleAll,
  onActivate
}: WordTableProps) {
  const cycle = (field: SortField) => {
    if (!onSortChange) return;
    if (!sort || sort.field !== field) {
      onSortChange({ field, dir: field === 'lemma' ? 'asc' : 'desc' });
    } else {
      onSortChange({ field, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    }
  };

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
          <WordCard key={word.id} word={word} active={activeId === word.id} onActivate={onActivate} />
        )}
      </div>);

  }

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
            <th scope="col" className="py-2 pr-3 font-medium">
              <button type="button" onClick={() => cycle('lemma')} className="inline-flex items-center hover:text-ink">
                单词<SortIcon field="lemma" sort={sort} />
              </button>
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">翻译</th>
            <th scope="col" className="hidden py-2 pr-3 font-medium xl:table-cell">标签</th>
            <th scope="col" className="hidden py-2 pr-3 font-medium lg:table-cell">来源</th>
            <th scope="col" className="py-2 pr-3 font-medium">
              <button type="button" onClick={() => cycle('savedAt')} className="inline-flex items-center hover:text-ink">
                收藏时间<SortIcon field="savedAt" sort={sort} />
              </button>
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              <button type="button" onClick={() => cycle('lookups')} className="inline-flex items-center justify-end hover:text-ink">
                查询次数<SortIcon field="lookups" sort={sort} />
              </button>
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              <button type="button" onClick={() => cycle('mastery')} className="inline-flex items-center hover:text-ink">
                掌握度<SortIcon field="mastery" sort={sort} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {words.map((word) => (
            <WordRow
              key={word.id}
              word={word}
              selected={selectedIds.has(word.id)}
              active={activeId === word.id}
              onToggleSelect={onToggleSelect}
              onActivate={onActivate}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
