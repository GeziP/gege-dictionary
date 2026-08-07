import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookmarkPlusIcon, CheckIcon, RotateCcwIcon, ThumbsDownIcon, ThumbsUpIcon, TagIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import type { Entry, LookupRequest, SavedWord } from '../../types/lexnote';
import { relativeTime } from '../../utils/format';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';

interface SaveBarProps {
  entry: Entry;
  request: LookupRequest;
  saveSignal: number;
  onOpenLibrary: () => void;
}

export function SaveBar({ entry, request, saveSignal, onOpenLibrary }: SaveBarProps) {
  const { tags, saveWord, removeWords, findByLemma } = useLexNote();
  const existing = findByLemma(entry.lemma);
  const [justSaved, setJustSaved] = useState(false);
  const [previous, setPrevious] = useState<SavedWord | null>(null);
  const [undoSeconds, setUndoSeconds] = useState(0);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [feedback, setFeedback] = useState<'helpful' | 'inaccurate' | null>(null);
  const lastSignal = useRef(saveSignal);

  const suggestions = tags.filter(
    (tag) => tag.startsWith(tagDraft.toLowerCase()) && !draftTags.includes(tag) && tagDraft.length > 0
  );

  const commit = () => {
    const word: SavedWord = {
      ...entry,
      savedAt: new Date().toISOString(),
      context: request.context,
      sourceApp: request.sourceApp,
      sourceTitle: request.sourceTitle,
      tags: Array.from(new Set([...(existing?.tags ?? []), ...draftTags])),
      mastery: existing?.mastery ?? 'new',
      lookups: (existing?.lookups ?? 0) + 1,
      note: existing?.note ?? ''
    };
    setPrevious(existing ?? null);
    saveWord(word);
    setJustSaved(true);
    setUndoSeconds(5);
  };

  useEffect(() => {
    if (saveSignal !== lastSignal.current) {
      lastSignal.current = saveSignal;
      if (!justSaved) commit();
    }
  });

  useEffect(() => {
    if (undoSeconds <= 0) return;
    const timer = window.setTimeout(() => setUndoSeconds((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [undoSeconds]);

  const undo = () => {
    if (previous) saveWord(previous);else
    removeWords([entry.id]);
    setJustSaved(false);
    setUndoSeconds(0);
  };

  const addTag = (tag: string) => {
    const clean = tag.trim().toLowerCase();
    if (!clean) return;
    setDraftTags((prev) => prev.includes(clean) ? prev : [...prev, clean]);
    setTagDraft('');
  };

  return (
    <div className="border-t border-line bg-raised px-4 py-2.5">
      <AnimatePresence mode="wait" initial={false}>
        {justSaved ?
        <motion.div
          key="saved"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2">
          
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-accent">
              <CheckIcon size={13} /> 已收藏
            </span>
            <button
            type="button"
            onClick={onOpenLibrary}
            className="text-xs text-ink-muted underline-offset-2 hover:text-accent hover:underline">
            
              在生词库中查看
            </button>
            <div className="ml-auto">
              {undoSeconds > 0 ?
            <Button size="sm" variant="ghost" icon={<RotateCcwIcon size={12} />} onClick={undo}>
                  撤销 {undoSeconds}s
                </Button> :
            null}
            </div>
          </motion.div> :

        <motion.div key="save" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {existing ?
          <p className="mb-2 flex items-center gap-1.5 text-[11px] text-warn">
                <BookmarkPlusIcon size={12} />
                已收藏于 {relativeTime(existing.savedAt)} · 保存将更新为本次解析
              </p> :
          null}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" icon={<BookmarkPlusIcon size={13} />} onClick={commit}>
                {existing ? '更新解析' : '加入生词库'}
                <kbd className="ml-1 rounded bg-black/15 px-1 text-[10px] font-normal">Enter</kbd>
              </Button>
              <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-line bg-surface px-2">
                <TagIcon size={12} className="shrink-0 text-ink-subtle" />
                {draftTags.map((tag) =>
              <Chip
                key={tag}
                label={tag}
                tone="accent"
                onRemove={() => setDraftTags((prev) => prev.filter((t) => t !== tag))} />

              )}
                <input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    addTag(suggestions[0] ?? tagDraft);
                  }
                }}
                placeholder={draftTags.length ? '' : '添加标签…'}
                aria-label="添加标签"
                className="min-w-[60px] flex-1 bg-transparent text-xs text-ink placeholder:text-ink-subtle outline-none" />
              
              </div>
            </div>
            {suggestions.length > 0 ?
          <div className="mt-1.5 flex flex-wrap gap-1">
                {suggestions.slice(0, 4).map((tag) =>
            <Chip key={tag} label={tag} onClick={() => addTag(tag)} />
            )}
              </div> :
          null}
          </motion.div>
        }
      </AnimatePresence>

      <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
        <span className="text-[11px] text-ink-subtle">这条解析</span>
        {feedback ?
        <span className="text-[11px] text-ink-muted">
            {feedback === 'helpful' ? '已标记为有帮助' : '已本地记录为不准确样本，可在设置中查看'}
          </span> :

        <>
            <button
            type="button"
            onClick={() => setFeedback('helpful')}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-sunken hover:text-accent">
            
              <ThumbsUpIcon size={12} /> 有帮助
            </button>
            <button
            type="button"
            onClick={() => setFeedback('inaccurate')}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-sunken hover:text-danger">
            
              <ThumbsDownIcon size={12} /> 不准确
            </button>
          </>
        }
      </div>
    </div>);

}