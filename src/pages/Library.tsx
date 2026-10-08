import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';

import { useLexNote } from '../contexts/LexNoteContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useToast } from '../hooks/useToast';
import { WindowFrame } from '../components/shell/WindowFrame';
import { FilterPanel } from '../components/library/FilterPanel';
import { LibraryEmpty } from '../components/library/LibraryEmpty';
import { LibraryToolbar } from '../components/library/LibraryToolbar';
import { SelectionBar } from '../components/library/SelectionBar';
import { WordTable } from '../components/library/WordTable';
import { filterWords, sortWords, type SortState } from '../lib/library-list';
import { clampReaderSize } from '../lib/reader-size';
import { WordDetail } from '../components/library/WordDetail';
import { ExportDialog } from '../components/library/ExportDialog';
import { ImportDialog } from '../components/library/ImportDialog';
import { Toast } from '../components/ui/Toast';
import type { Mastery, SavedWord } from '../types/lexnote';
import { classNames, errorText } from '../utils/format';
import { ReviewOverview } from '../components/review/ReviewOverview';
import { EnrichmentPanel } from '../components/library/EnrichmentPanel';
import { ReadingSessions } from '../components/library/ReadingSessions';
import { HistoryTab } from '../components/library/HistoryTab';
import { useEnrichment } from '../hooks/useEnrichment';
import { isBare, isRunActive } from '../lib/enrichment';

/** The list without `value` if it was in it, otherwise with it added. */
function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * What a notice says was done to words: "已删除「alpha」" for one word, "已删除 3 条生词" for
 * more. A saved paragraph can be long, so only the start of what it is called is shown.
 */
function said(verb: string, words: SavedWord[]): string {
  if (words.length !== 1) return `${verb} ${words.length} 条生词`;
  const { lemma } = words[0];
  return `${verb}「${lemma.length > 24 ? `${lemma.slice(0, 24)}…` : lemma}」`;
}

const MASTERY_LABELS: Record<Mastery, string> = { new: '新词', learning: '巩固中', familiar: '熟悉', mastered: '已掌握' };

const TABS = [
  { value: 'words', label: '词条' },
  { value: 'sessions', label: '会话' },
  { value: 'history', label: '历史' },
] as const;

export function Library() {
  const { words, removeWords, restoreWords, tagWords, batchSetMastery, refreshWords, settings, updateSettings } =
    useLexNote();
  const fontSize = settings.fontSize ?? 13;
  const [query, setQuery] = useState('');
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [sourceFilters, setSourceFilters] = useState<string[]>([]);
  const [masteryFilters, setMasteryFilters] = useState<Mastery[]>([]);
  const [range, setRange] = useState('all');
  const [density, setDensity] = useState<'table' | 'cards'>('table');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [batchTag, setBatchTag] = useState('');
  const [viewMode, setViewMode] = useState<(typeof TABS)[number]['value']>('words');
  const [ankiBusy, setAnkiBusy] = useState(false);
  const [sort, setSort] = useState<SortState>({ field: 'savedAt', dir: 'desc' });
  const { toast, show: showToast, pause: pauseToast, resume: resumeToast } = useToast();
  const enrichment = useEnrichment();
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFocus = () => refreshWords();
    window.addEventListener('focus', onFocus);

    let unlisten: (() => void) | null = null;
    import('../lib/tauri-bridge').then((b) =>
      b.listenWordSaved(() => refreshWords())
    ).then((u) => { unlisten = u; }).catch((error) => {
      console.error('Failed to listen for saved words:', error);
    });

    return () => {
      window.removeEventListener('focus', onFocus);
      unlisten?.();
    };
  }, [refreshWords]);

  // The box itself follows the keys at once; the list catches up when the browser has a moment,
  // so typing stays smooth in a library of thousands of words.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(
    () =>
      filterWords(words, {
        query: deferredQuery,
        tags: tagFilters,
        sources: sourceFilters,
        mastery: masteryFilters,
        range,
      }),
    [words, deferredQuery, tagFilters, sourceFilters, masteryFilters, range],
  );
  const sorted = useMemo(() => sortWords(filtered, sort), [filtered, sort]);

  const active = useMemo(() => words.find((word) => word.id === activeId) ?? null, [words, activeId]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedWords = useMemo(() => words.filter((word) => selectedSet.has(word.id)), [words, selectedSet]);

  // A word that is gone, deleted here or by something else, is neither selected nor open any more.
  useEffect(() => {
    const present = new Set(words.map((word) => word.id));
    setSelectedIds((prev) => {
      const kept = prev.filter((id) => present.has(id));
      return kept.length === prev.length ? prev : kept;
    });
    setActiveId((prev) => (prev && !present.has(prev) ? null : prev));
  }, [words]);

  // Escape puts the open word away, unless something on top of it (a dialog, an edit that is
  // under way) has used the key for itself.
  useEffect(() => {
    if (!active || exportOpen || importOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setActiveId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, exportOpen, importOpen]);
  useFocusTrap(detailRef, Boolean(active) && !exportOpen && !importOpen);

  // Of the selected words, those that have only a meaning, which the batch enrichment can fill in.
  const enrichableIds = useMemo(() => selectedWords.filter(isBare).map((word) => word.id), [selectedWords]);
  const enrichBlocked =
    enrichment.status && isRunActive(enrichment.status.progress.state)
      ? '已经有一轮补全在进行，请先暂停或停止它'
      : enrichment.busy
        ? '正在提交…'
        : undefined;
  // "All" means every word that is listed, however many others are selected out of sight.
  const allSelected = sorted.length > 0 && sorted.every((word) => selectedSet.has(word.id));

  const toggleSelect = useCallback((id: string) => setSelectedIds((prev) => toggle(prev, id)), []);
  // The box in the table header is for the listed words only: it adds them to the choice, or,
  // when they are all in it already, takes them out; what was chosen before the list was
  // narrowed down is left as it is.
  const toggleAll = useCallback(() => {
    const listed = sorted.map((word) => word.id);
    setSelectedIds((prev) => {
      if (allSelected) {
        const gone = new Set(listed);
        return prev.filter((id) => !gone.has(id));
      }
      const have = new Set(prev);
      return [...prev, ...listed.filter((id) => !have.has(id))];
    });
  }, [allSelected, sorted]);

  const resetFilters = () => {
    setTagFilters([]);
    setSourceFilters([]);
    setMasteryFilters([]);
    setRange('all');
  };
  const clearSearchAndFilters = () => {
    setQuery('');
    resetFilters();
  };

  const setReaderSize = (size: number) => updateSettings({ fontSize: clampReaderSize(size) });

  const undoDelete = useCallback(
    async (removed: SavedWord[]) => {
      try {
        await restoreWords(removed);
        // What the user wrote and saved comes back whole; a word's place in the review schedule
        // does not, it starts again.
        const reviewed = removed.some((word) => ['word', 'phrase'].includes(word.kind || 'word'));
        showToast(`${said('已恢复', removed)}${reviewed ? '，复习进度重新开始' : ''}`, 'success');
      } catch (error) {
        showToast(`恢复失败：${errorText(error)}`, 'error');
      }
    },
    [restoreWords, showToast],
  );

  const deleteWords = useCallback(
    async (ids: string[]) => {
      try {
        const removed = await removeWords(ids);
        if (removed.length === 0) return;
        showToast(said('已删除', removed), 'info', {
          actionLabel: '撤销',
          onAction: () => void undoDelete(removed),
        });
      } catch (error) {
        showToast(`删除失败：${errorText(error)}`, 'error');
      }
    },
    [removeWords, showToast, undoDelete],
  );

  return (
    <WindowFrame title="生词库">
      <div role="tablist" aria-label="生词库视图" className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={viewMode === tab.value}
            onClick={() => setViewMode(tab.value)}
            className={classNames(
              'h-full border-b-2 px-3 text-xs',
              viewMode === tab.value ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {viewMode === 'words' ? (
      <div className="relative flex min-h-0 flex-1">
        {words.length === 0 ? (
          <LibraryEmpty settings={settings} onImport={() => setImportOpen(true)} />
        ) : (
          <>
            <FilterPanel
              words={words}
              activeTags={tagFilters}
              activeSources={sourceFilters}
              activeMastery={masteryFilters}
              range={range}
              onToggleTag={(tag) => setTagFilters((prev) => toggle(prev, tag))}
              onToggleSource={(source) => setSourceFilters((prev) => toggle(prev, source))}
              onToggleMastery={(mastery) => setMasteryFilters((prev) => toggle(prev, mastery))}
              onRangeChange={setRange}
              onReset={resetFilters} />

            <div className="flex min-w-0 flex-1 flex-col">
              <ReviewOverview />
              <EnrichmentPanel enrichment={enrichment} />
              <LibraryToolbar
                query={query}
                onQueryChange={setQuery}
                filteredCount={filtered.length}
                totalCount={words.length}
                density={density}
                onDensityChange={setDensity}
                onImport={() => setImportOpen(true)}
                onExport={() => setExportOpen(true)}
              />

              <WordTable
                words={sorted}
                density={density}
                selectedIds={selectedSet}
                allSelected={allSelected}
                activeId={activeId}
                sort={sort}
                onSortChange={setSort}
                onToggleSelect={toggleSelect}
                onToggleAll={toggleAll}
                onActivate={setActiveId}
                onClearFilters={clearSearchAndFilters} />

              <AnimatePresence>
                {selectedIds.length > 0 ? (
                  <SelectionBar
                    count={selectedIds.length}
                    batchTag={batchTag}
                    ankiEnabled={Boolean(settings.anki?.enabled)}
                    ankiBusy={ankiBusy}
                    enrichableCount={enrichableIds.length}
                    enrichBlocked={enrichBlocked}
                    onEnrich={() => void enrichment.start(enrichableIds)}
                    onBatchTagChange={setBatchTag}
                    onApplyTag={() => {
                      const tag = batchTag.trim().toLowerCase();
                      if (!tag) return;
                      tagWords(selectedIds, [tag]);
                      showToast(`已为 ${selectedIds.length} 条生词添加标签「${tag}」`, 'success');
                      setBatchTag('');
                    }}
                    onExport={() => setExportOpen(true)}
                    onSetMastery={(mastery) => {
                      batchSetMastery(selectedIds, mastery);
                      showToast(`已将 ${selectedIds.length} 条生词设为「${MASTERY_LABELS[mastery] || mastery}」`, 'success');
                    }}
                    onSendAnki={async () => {
                      setAnkiBusy(true);
                      try {
                        const { sendWordsToAnki } = await import('../lib/tauri-bridge');
                        const report = await sendWordsToAnki(selectedIds);
                        const added = report.added ?? 0;
                        const skipped = report.skipped ?? 0;
                        const failed = report.errors?.length ?? 0;
                        if (failed > 0) {
                          showToast(`Anki：成功 ${added} · 跳过 ${skipped} · 失败 ${failed}`, 'error');
                        } else {
                          showToast(`已发送 ${added} 条到 Anki（跳过 ${skipped}）`, 'success');
                        }
                      } catch (e) {
                        showToast(errorText(e), 'error');
                      } finally {
                        setAnkiBusy(false);
                      }
                    }}
                    onDelete={() => void deleteWords(selectedIds)}
                    onClear={() => setSelectedIds([])}
                  />
                ) : null}
              </AnimatePresence>
            </div>
          </>
        )}

        {/* 点击单词时弹出覆盖面板 */}
        {active && (
          <div className="absolute inset-0 z-30 flex justify-end">
            <div className="absolute inset-0 bg-black/20" onClick={() => setActiveId(null)} aria-hidden="true" />
            <div
              ref={detailRef}
              role="dialog"
              aria-modal="true"
              aria-label={`词条详情：${active.lemma}`}
              tabIndex={-1}
              className={classNames(
                'thin-scroll relative overflow-y-auto border-l border-line bg-surface outline-none animate-slide-in-right',
                active.kind === 'paragraph' || active.kind === 'sentence'
                  ? 'w-full max-w-[90%]'
                  : 'w-[480px] max-w-[75%]'
              )}
            >
              <WordDetail
                word={active}
                onClose={() => setActiveId(null)}
                onDelete={(word) => void deleteWords([word.id])}
                inline
                fontSize={fontSize}
                onFontSizeChange={setReaderSize}
              />
            </div>
          </div>
        )}

        {exportOpen ?
        <ExportDialog
          words={selectedWords.length > 0 ? selectedWords : filtered}
          onClose={() => setExportOpen(false)}
          onExported={(msg) => showToast(msg, 'success')} /> :

        null}
        {importOpen ?
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(msg) => {
            showToast(msg, 'success');
            // The words are in the database, not on the screen yet; and the words that have only
            // a meaning are more than they were.
            void Promise.all([refreshWords(), enrichment.refresh()]).catch((error) => {
              console.error('Failed to refresh the library after an import:', error);
            });
          }} /> :

        null}

        <Toast message={toast} onPause={pauseToast} onResume={resumeToast} />
      </div>
      ) : viewMode === 'sessions' ? <ReadingSessions /> : <HistoryTab />}
    </WindowFrame>);

}
