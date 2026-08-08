import React from 'react';
import { RotateCcwIcon } from 'lucide-react';
import type { Mastery, SavedWord } from '../../types/lexnote';
import { classNames } from '../../utils/format';
import { MASTERY_META, MASTERY_ORDER } from '../ui/MasteryBadge';


const RANGES = [
{ value: 'all', label: '全部时间' },
{ value: '7', label: '最近 7 天' },
{ value: '30', label: '最近 30 天' }];


interface FilterPanelProps {
  words: SavedWord[];
  activeTags: string[];
  activeSources: string[];
  activeMastery: Mastery[];
  range: string;
  onToggleTag: (tag: string) => void;
  onToggleSource: (source: string) => void;
  onToggleMastery: (mastery: Mastery) => void;
  onRangeChange: (range: string) => void;
  onReset: () => void;
}

export function FilterPanel({
  words,
  activeTags,
  activeSources,
  activeMastery,
  range,
  onToggleTag,
  onToggleSource,
  onToggleMastery,
  onRangeChange,
  onReset
}: FilterPanelProps) {
  const tagCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  words.forEach((word) => {
    word.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1));
    sourceCounts.set(word.sourceApp, (sourceCounts.get(word.sourceApp) ?? 0) + 1);
  });

  const hasFilters = activeTags.length + activeSources.length + activeMastery.length > 0 || range !== 'all';

  return (
    <aside aria-label="筛选生词" className="thin-scroll w-filter shrink-0 overflow-y-auto border-r border-line bg-surface p-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">筛选</h2>
        {hasFilters ?
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-[11px] text-ink-subtle hover:text-accent">
          
            <RotateCcwIcon size={11} /> 清除
          </button> :
        null}
      </div>

      <section className="mb-4">
        <h3 className="mb-1.5 text-[11px] font-medium text-ink-muted">标签</h3>
        <ul className="space-y-0.5">
          {Array.from(tagCounts.entries()).
          sort((a, b) => b[1] - a[1]).
          map(([tag, count]) =>
          <li key={tag}>
                <button
              type="button"
              onClick={() => onToggleTag(tag)}
              className={classNames(
                'flex w-full items-center justify-between rounded px-2 py-1 text-left text-[12px] transition-colors',
                activeTags.includes(tag) ?
                'bg-accent-soft text-accent' :
                'text-ink-muted hover:bg-sunken hover:text-ink'
              )}>
              
                  <span className="truncate">{tag}</span>
                  <span className="ml-2 text-[10px] text-ink-subtle">{count}</span>
                </button>
              </li>
          )}
        </ul>
      </section>

      <section className="mb-4">
        <h3 className="mb-1.5 text-[11px] font-medium text-ink-muted">来源应用</h3>
        <ul className="space-y-0.5">
          {Array.from(sourceCounts.entries()).map(([sourceApp, count]) =>
          <li key={sourceApp}>
              <button
              type="button"
              onClick={() => onToggleSource(sourceApp)}
              className={classNames(
                'flex w-full items-center justify-between rounded px-2 py-1 text-left text-[12px] transition-colors',
                activeSources.includes(sourceApp) ?
                'bg-accent-soft text-accent' :
                'text-ink-muted hover:bg-sunken hover:text-ink'
              )}>
              
                <span className="truncate">{sourceApp}</span>
                <span className="ml-2 text-[10px] text-ink-subtle">{count}</span>
              </button>
            </li>
          )}
        </ul>
      </section>

      <section className="mb-4">
        <h3 className="mb-1.5 text-[11px] font-medium text-ink-muted">掌握度</h3>
        <div className="space-y-0.5">
          {MASTERY_ORDER.map((value) => {
            const meta = MASTERY_META[value];
            const Icon = meta.icon;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={activeMastery.includes(value)}
                onClick={() => onToggleMastery(value)}
                className={classNames(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors',
                  activeMastery.includes(value)
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-sunken hover:text-ink'
                )}
              >
                <Icon size={13} className={meta.tone} aria-hidden="true" />
                {meta.label}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[11px] font-medium text-ink-muted">时间范围</h3>
        <div className="space-y-0.5">
          {RANGES.map((item) =>
          <button
            key={item.value}
            type="button"
            onClick={() => onRangeChange(item.value)}
            className={classNames(
              'w-full rounded px-2 py-1 text-left text-[12px] transition-colors',
              range === item.value ?
              'bg-accent-soft text-accent' :
              'text-ink-muted hover:bg-sunken hover:text-ink'
            )}>
            
              {item.label}
            </button>
          )}
        </div>
      </section>
    </aside>);

}