import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';

import { useLexNote } from '../contexts/LexNoteContext';
import { WindowFrame } from '../components/shell/WindowFrame';
import { FilterPanel } from '../components/library/FilterPanel';
import { LibraryToolbar, READER_MAX, READER_MIN } from '../components/library/LibraryToolbar';
import { SelectionBar } from '../components/library/SelectionBar';
import { WordTable } from '../components/library/WordTable';
import { filterWords, sortWords, type SortState } from '../lib/library-list';
import { WordDetail } from '../components/library/WordDetail';
import { ExportDialog } from '../components/library/ExportDialog';
import { ImportDialog } from '../components/library/ImportDialog';
import { Toast, type ToastMessage } from '../components/ui/Toast';
import type { Mastery } from '../types/lexnote';
import { classNames } from '../utils/format';
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

export function Library() {
  const { words, removeWords, tagWords, batchSetMastery, refreshWords, settings, updateSettings } = useLexNote();
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
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [viewMode, setViewMode] = useState<'words' | 'sessions' | 'history'>('words');
  const [ankiBusy, setAnkiBusy] = useState(false);
  const [sort, setSort] = useState<SortState>({ field: 'savedAt', dir: 'desc' });
  const toastId = useRef(0);
  const enrichment = useEnrichment();

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

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (text: string, tone: ToastMessage['tone'] = 'info', action?: Pick<ToastMessage, 'actionLabel' | 'onAction'>) => {
    toastId.current += 1;
    setToast({ id: toastId.current, text, tone, ...action });
  };

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

  return (
    <WindowFrame title="生词库">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
        <button type="button" onClick={() => setViewMode('words')} className={classNames('h-full border-b-2 px-3 text-xs', viewMode === 'words' ? 'border-accent text-accent' : 'border-transparent text-ink-muted')}>词条</button>
        <button type="button" onClick={() => setViewMode('sessions')} className={classNames('h-full border-b-2 px-3 text-xs', viewMode === 'sessions' ? 'border-accent text-accent' : 'border-transparent text-ink-muted')}>会话</button>
        <button type="button" onClick={() => setViewMode('history')} className={classNames('h-full border-b-2 px-3 text-xs', viewMode === 'history' ? 'border-accent text-accent' : 'border-transparent text-ink-muted')}>历史</button>
      </div>
      {viewMode === 'words' ? (
      <div className="relative flex min-h-0 flex-1">
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
          onReset={() => {
            setTagFilters([]);
            setSourceFilters([]);
            setMasteryFilters([]);
            setRange('all');
          }} />
        

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
            readerSize={fontSize}
            onReaderSizeChange={(size) => updateSettings({ fontSize: Math.min(READER_MAX, Math.max(READER_MIN, size)) })}
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
            onActivate={setActiveId} />
          

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
                  const labels: Record<string, string> = { new: '新词', learning: '巩固中', familiar: '熟悉', mastered: '已掌握' };
                  showToast(`已将 ${selectedIds.length} 条生词设为「${labels[mastery] || mastery}」`, 'success');
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
                    showToast(String(e), 'error');
                  } finally {
                    setAnkiBusy(false);
                  }
                }}
                onDelete={() => {
                  removeWords(selectedIds);
                  showToast(`已删除 ${selectedIds.length} 条生词`, 'info');
                  setSelectedIds([]);
                }}
                onClear={() => setSelectedIds([])}
              />
            ) : null}
          </AnimatePresence>
        </div>

        {/* 点击单词时弹出覆盖面板 */}
        {active && (
          <div className="absolute inset-0 z-30 flex justify-end">
            <div className="absolute inset-0 bg-black/20" onClick={() => setActiveId(null)} />
            <aside
              className={classNames(
                'thin-scroll relative overflow-y-auto border-l border-line bg-surface animate-slide-in-right',
                active.kind === 'paragraph' || active.kind === 'sentence'
                  ? 'w-full max-w-[90%]'
                  : 'w-[480px] max-w-[75%]'
              )}
            >
              <WordDetail word={active} onClose={() => setActiveId(null)} inline fontSize={fontSize} />
            </aside>
          </div>
        )}

        {exportOpen ?
        <ExportDialog
          words={selectedWords.length > 0 ? selectedWords : filtered}
          onClose={() => setExportOpen(false)}
          onExported={(msg) => showToast(msg, 'success')} /> :

        null}
        {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} onImported={(msg) => showToast(msg, 'success')} /> : null}

        <Toast message={toast} />
      </div>
      ) : viewMode === 'sessions' ? <ReadingSessions /> : <HistoryTab />}
    </WindowFrame>);

}
