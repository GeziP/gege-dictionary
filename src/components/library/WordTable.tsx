import React from 'react';
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon } from 'lucide-react';
import { useRowWindow } from '../../hooks/useRowWindow';
import type { SortField, SortState } from '../../lib/library-list';
import type { SavedWord } from '../../types/lexnote';
import { classNames, relativeTime } from '../../utils/format';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { MasteryBadge } from '../ui/MasteryBadge';

/**
 * From this many words on, the table draws only the rows that are on screen. Below it, drawing
 * all of them is cheap, and it keeps every row reachable for find-in-page and the Tab key.
 */
export const WINDOW_FROM = 400;
/** The columns of the table, which the spacer rows of a windowed table have to span. */
const COLUMNS = 8;

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
  /** Puts the search and the filters away; offered when they leave nothing to show. */
  onClearFilters?: () => void;
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
  /** Where the row is in a table that draws only some of its rows (the header row is 1). */
  rowIndex?: number;
  onToggleSelect: (id: string) => void;
  onActivate: (id: string) => void;
}

// Rows are memoized: selecting one word or opening another changes the props of two rows, not of
// every row in a library of thousands, so the rest are not rendered again.
// A row is one line, whatever a word or a translation looks like: the table that draws only the
// visible rows needs them all to be as tall as each other.
const WordRow = React.memo(function WordRow({
  word,
  selected,
  active,
  rowIndex,
  onToggleSelect,
  onActivate,
}: RowProps) {
  return (
    <tr
      data-row
      aria-rowindex={rowIndex}
      className={classNames(
        'whitespace-nowrap border-b border-line transition-colors',
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
      <td className="max-w-[16rem] py-1 pr-3">
        <button
          type="button"
          onClick={() => onActivate(word.id)}
          className="-mx-1 flex max-w-full items-baseline gap-1.5 rounded-sm px-1 py-1 text-left hover:underline"
        >
          <span className="min-w-0 truncate font-serif text-base font-bold text-ink">{word.lemma}</span>
          <span className="shrink-0 text-2xs text-ink-subtle">{word.pos}</span>
        </button>
      </td>
      <td className="max-w-[12rem] truncate py-2 pr-3 text-ink-muted">{word.translation}</td>
      <td className="hidden max-w-[12rem] py-2 pr-3 2xl:table-cell">
        <span className="flex flex-nowrap items-center gap-1 overflow-hidden">
          {word.tags.slice(0, 2).map((tag) => (
            <Chip key={tag} label={tag} tone="muted" />
          ))}
          {word.tags.length > 2 ? (
            <span className="text-2xs text-ink-subtle">+{word.tags.length - 2}</span>
          ) : null}
        </span>
      </td>
      <td className="hidden max-w-[9rem] truncate py-2 pr-3 text-ink-subtle xl:table-cell">
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

/** Stands in for the rows of a long table that are not drawn, so that the scroll bar stays honest. */
function SpacerRow({ height }: { height: number }) {
  return (
    <tr aria-hidden="true" data-spacer style={{ height }}>
      <td colSpan={COLUMNS} className="p-0" />
    </tr>
  );
}

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
      // The browser skips the layout and painting of the cards that are off screen, which is what
      // keeps a library of thousands of cards light (their height is remembered once seen).
      className={classNames(
        'flex flex-col rounded-lg border bg-surface p-3 text-left transition-colors [contain-intrinsic-size:auto_150px] [content-visibility:auto]',
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
  onActivate,
  onClearFilters
}: WordTableProps) {
  const windowed = density === 'table' && words.length > WINDOW_FROM;
  const { scrollerRef, rows, measure } = useRowWindow({ count: words.length, enabled: windowed });
  const bodyRef = React.useRef<HTMLTableSectionElement>(null);
  React.useLayoutEffect(() => {
    if (windowed && bodyRef.current) measure(bodyRef.current.querySelectorAll<HTMLElement>('tr[data-row]'));
  }, [windowed, rows.start, rows.end, measure]);

  /** Tells assistive technology which column the list is in order of, and which way. */
  const ariaSort = (field: SortField) =>
    sort?.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;

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
        {onClearFilters ? (
          <Button size="sm" className="mt-3" onClick={onClearFilters}>
            清除搜索和筛选
          </Button>
        ) : null}
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
    <div ref={scrollerRef} className="thin-scroll min-h-0 flex-1 overflow-auto">
      <table
        // Screen readers are told how long the list really is, though only a part of it is drawn.
        aria-rowcount={windowed ? words.length + 1 : undefined}
        className="w-full border-collapse text-left text-xs"
      >
        <caption className="sr-only">生词列表，点击单词打开详情</caption>
        <thead className="sticky top-0 z-10 bg-raised">
          <tr aria-rowindex={windowed ? 1 : undefined} className="border-b border-line text-2xs tracking-wide text-ink-subtle">
            <th scope="col" className="w-10 px-3 py-2">
              <input
                type="checkbox"
                aria-label="全选当前列表"
                checked={allSelected}
                onChange={onToggleAll}
                className="h-3.5 w-3.5 accent-[color:var(--accent)]"
              />
            </th>
            <th scope="col" aria-sort={ariaSort('lemma')} className="whitespace-nowrap py-2 pr-3 font-medium">
              <button type="button" onClick={() => cycle('lemma')} className="inline-flex items-center hover:text-ink">
                单词<SortIcon field="lemma" sort={sort} />
              </button>
            </th>
            <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">翻译</th>
            <th scope="col" className="hidden whitespace-nowrap py-2 pr-3 font-medium 2xl:table-cell">标签</th>
            <th scope="col" className="hidden whitespace-nowrap py-2 pr-3 font-medium xl:table-cell">来源</th>
            <th scope="col" aria-sort={ariaSort('savedAt')} className="whitespace-nowrap py-2 pr-3 font-medium">
              <button type="button" onClick={() => cycle('savedAt')} className="inline-flex items-center hover:text-ink">
                收藏时间<SortIcon field="savedAt" sort={sort} />
              </button>
            </th>
            <th scope="col" aria-sort={ariaSort('lookups')} className="whitespace-nowrap py-2 pr-3 text-right font-medium">
              <button type="button" onClick={() => cycle('lookups')} className="inline-flex items-center justify-end hover:text-ink">
                查询次数<SortIcon field="lookups" sort={sort} />
              </button>
            </th>
            <th scope="col" aria-sort={ariaSort('mastery')} className="whitespace-nowrap py-2 pr-3 font-medium">
              <button type="button" onClick={() => cycle('mastery')} className="inline-flex items-center hover:text-ink">
                掌握度<SortIcon field="mastery" sort={sort} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {windowed && rows.before > 0 ? <SpacerRow height={rows.before} /> : null}
          {(windowed ? words.slice(rows.start, rows.end) : words).map((word, index) => (
            <WordRow
              key={word.id}
              word={word}
              selected={selectedIds.has(word.id)}
              active={activeId === word.id}
              rowIndex={windowed ? rows.start + index + 2 : undefined}
              onToggleSelect={onToggleSelect}
              onActivate={onActivate}
            />
          ))}
          {windowed && rows.after > 0 ? <SpacerRow height={rows.after} /> : null}
        </tbody>
      </table>
    </div>
  );
}
