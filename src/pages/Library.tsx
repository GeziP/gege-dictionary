import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';

import { useLexNote } from '../contexts/LexNoteContext';
import { WindowFrame } from '../components/shell/WindowFrame';
import { FilterPanel } from '../components/library/FilterPanel';
import { LibraryToolbar, READER_MAX, READER_MIN } from '../components/library/LibraryToolbar';
import { SelectionBar } from '../components/library/SelectionBar';
import { WordTable } from '../components/library/WordTable';
import { WordDetail } from '../components/library/WordDetail';
import { ExportDialog } from '../components/library/ExportDialog';
import { ImportDialog } from '../components/library/ImportDialog';
import { Toast, type ToastMessage } from '../components/ui/Toast';
import type { Mastery } from '../types/lexnote';
import { classNames } from '../utils/format';

export function Library() {
  const { words, removeWords, tagWords, refreshWords, settings, updateSettings } = useLexNote();
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
  const toastId = useRef(0);

  useEffect(() => {
    const onFocus = () => refreshWords();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cutoff = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000;
    return words.filter((word) => {
      if (q) {
        const haystack = [
        word.lemma,
        word.translation,
        word.contextMeaning,
        word.explanation,
        word.context,
        ...word.examples.map((example) => `${example.en} ${example.zh}`)].

        join(' ').
        toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (tagFilters.length && !tagFilters.every((tag) => word.tags.includes(tag))) return false;
      if (sourceFilters.length && !sourceFilters.includes(word.sourceApp)) return false;
      if (masteryFilters.length && !masteryFilters.includes(word.mastery)) return false;
      if (cutoff && new Date(word.savedAt).getTime() < cutoff) return false;
      return true;
    });
  }, [words, query, tagFilters, sourceFilters, masteryFilters, range]);

  const active = words.find((word) => word.id === activeId) ?? null;
  const selectedWords = words.filter((word) => selectedIds.includes(word.id));

  const toggle = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <WindowFrame title="生词库">
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
            words={filtered}
            density={density}
            selectedIds={selectedIds}
            activeId={activeId}
            onToggleSelect={(id) => setSelectedIds((prev) => toggle(prev, id))}
            onToggleAll={() =>
            setSelectedIds(selectedIds.length === filtered.length ? [] : filtered.map((word) => word.id))
            }
            onActivate={setActiveId} />
          

          <AnimatePresence>
            {selectedIds.length > 0 ? (
              <SelectionBar
                count={selectedIds.length}
                batchTag={batchTag}
                onBatchTagChange={setBatchTag}
                onApplyTag={() => {
                  const tag = batchTag.trim().toLowerCase();
                  if (!tag) return;
                  tagWords(selectedIds, [tag]);
                  showToast(`已为 ${selectedIds.length} 条生词添加标签「${tag}」`, 'success');
                  setBatchTag('');
                }}
                onExport={() => setExportOpen(true)}
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
    </WindowFrame>);

}