import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  DownloadIcon,
  LayoutGridIcon,
  MinusIcon,
  PlusIcon,
  RowsIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
  UploadIcon,
  XIcon } from
'lucide-react';
import { useLexNote } from '../contexts/LexNoteContext';
import { WindowFrame } from '../components/shell/WindowFrame';
import { FilterPanel } from '../components/library/FilterPanel';
import { WordTable } from '../components/library/WordTable';
import { WordDetail } from '../components/library/WordDetail';
import { ExportDialog } from '../components/library/ExportDialog';
import { ImportDialog } from '../components/library/ImportDialog';
import { Button } from '../components/ui/Button';
import { TextInput } from '../components/ui/TextInput';
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
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const onFocus = () => refreshWords();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshWords]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索词形、释义、例句…"
              leading={<SearchIcon size={13} />}
              className="w-64" />
            
            <span className="text-[11px] text-ink-subtle">{filtered.length} / {words.length} 条</span>
            <div className="ml-auto flex items-center gap-2">
              <div className="flex rounded-md border border-line p-0.5">
                {[
                { value: 'table' as const, icon: RowsIcon, label: '表格视图' },
                { value: 'cards' as const, icon: LayoutGridIcon, label: '卡片视图' }].
                map((option) =>
                <button
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  title={option.label}
                  onClick={() => setDensity(option.value)}
                  className={classNames(
                    'flex h-6 w-7 items-center justify-center rounded transition-colors',
                    density === option.value ? 'bg-accent-soft text-accent' : 'text-ink-subtle hover:bg-sunken'
                  )}>
                  
                    <option.icon size={13} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
                <button
                  type="button"
                  aria-label="缩小字体"
                  onClick={() => updateSettings({ fontSize: Math.max(10, fontSize - 1) })}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-subtle hover:bg-sunken"
                >
                  <MinusIcon size={12} />
                </button>
                <span className="min-w-[28px] text-center text-[10px] text-ink-muted">{fontSize}</span>
                <button
                  type="button"
                  aria-label="放大字体"
                  onClick={() => updateSettings({ fontSize: Math.min(22, fontSize + 1) })}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-subtle hover:bg-sunken"
                >
                  <PlusIcon size={12} />
                </button>
              </div>
              <Button size="sm" icon={<UploadIcon size={12} />} onClick={() => setImportOpen(true)}>
                导入
              </Button>
              <Button size="sm" variant="primary" icon={<DownloadIcon size={12} />} onClick={() => setExportOpen(true)}>
                导出
              </Button>
            </div>
          </div>

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
            {selectedIds.length > 0 ?
            <motion.div
              initial={{ y: 44 }}
              animate={{ y: 0 }}
              exit={{ y: 44 }}
              transition={{ duration: 0.16 }}
              className="flex h-11 shrink-0 items-center gap-2 border-t border-line bg-raised px-3">
              
                <span className="text-[12px] text-ink">已选 {selectedIds.length} 条</span>
                <div className="flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2">
                  <TagIcon size={12} className="text-ink-subtle" />
                  <input
                  value={batchTag}
                  onChange={(event) => setBatchTag(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && batchTag.trim()) {
                      tagWords(selectedIds, [batchTag.trim().toLowerCase()]);
                      setToast(`已为 ${selectedIds.length} 条生词添加标签 ${batchTag.trim().toLowerCase()}`);
                      setBatchTag('');
                    }
                  }}
                  placeholder="批量打标签后回车"
                  aria-label="批量打标签"
                  className="w-36 bg-transparent text-[11px] text-ink placeholder:text-ink-subtle outline-none" />
                
                </div>
                <Button size="sm" icon={<DownloadIcon size={12} />} onClick={() => setExportOpen(true)}>
                  导出所选
                </Button>
                <Button
                size="sm"
                variant="danger"
                icon={<Trash2Icon size={12} />}
                onClick={() => {
                  removeWords(selectedIds);
                  setToast(`已删除 ${selectedIds.length} 条生词`);
                  setSelectedIds([]);
                }}>
                
                  删除
                </Button>
                <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-subtle hover:text-ink">
                
                  <XIcon size={12} /> 取消选择
                </button>
              </motion.div> :
            null}
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
          onExported={setToast} /> :

        null}
        {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} onImported={setToast} /> : null}

        <AnimatePresence>
          {toast ?
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] text-ink-muted shadow-float">
            
              {toast}
            </motion.div> :
          null}
        </AnimatePresence>
      </div>
    </WindowFrame>);

}