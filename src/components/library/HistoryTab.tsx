import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookmarkCheckIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import {
  filterHistory,
  groupHistoryByDay,
  isSavedLookup,
  savedLookupKeys,
  showsLemma,
  timeOfDay,
} from '../../lib/history';
import type { LookupHistoryItem, SelectionKind } from '../../types/lexnote';
import { classNames } from '../../utils/format';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';

const KIND_LABEL: Record<SelectionKind, string> = {
  word: '单词',
  phrase: '短语',
  sentence: '句子',
  paragraph: '段落',
};

/** A short form of the text for accessible names, so a pasted paragraph does not become one. */
const preview = (text: string) => (text.length > 30 ? `${text.slice(0, 30)}…` : text);

interface Notice {
  tone: 'info' | 'error';
  text: string;
}

/**
 * What the user looked up, newest first and grouped by day: look something up again with one
 * click (an answer that is still cached costs nothing), search it, or forget some of it.
 */
export function HistoryTab() {
  const { words, settings } = useLexNote();
  const navigate = useNavigate();
  const recording = settings.historyEnabled !== false;

  const [items, setItems] = useState<LookupHistoryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState('');

  // Reads overlap (focus, a finished lookup and a click can all happen at once) and may come
  // back out of order: only the read that started last may be shown, since it also saw
  // everything that was changed before it started.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const list = await bridge.getLookupHistory();
      if (mine !== generation.current) return;
      setItems(list);
      setLoadError(null);
    } catch (error) {
      if (mine !== generation.current) return;
      setLoadError(String(error));
      setItems((previous) => previous ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);

    // A lookup made in another window finishes after it was recorded, so this is the moment to read.
    let stop: (() => void) | undefined;
    let disposed = false;
    bridge
      .listenLookupDone(() => void load())
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((error) => console.error('Failed to listen for finished lookups:', error));

    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      stop?.();
    };
  }, [load]);

  const savedKeys = useMemo(() => savedLookupKeys(words), [words]);
  const visible = useMemo(() => filterHistory(items ?? [], query), [items, query]);
  const days = useMemo(() => groupHistoryByDay(visible), [visible]);
  const total = items?.length ?? 0;

  const reopen = async (entry: LookupHistoryItem) => {
    setNotice(null);
    try {
      await bridge.reopenLookupFromHistory(entry.id);
    } catch (error) {
      setNotice({ tone: 'error', text: String(error) });
      void load(); // most likely the entry is gone
    }
  };

  const remove = async (entry: LookupHistoryItem) => {
    setNotice(null);
    try {
      await bridge.deleteLookupHistory([entry.id]);
      setItems((previous) => previous?.filter((item) => item.id !== entry.id) ?? previous);
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: `删除失败：${error}` });
    }
  };

  const clear = async () => {
    if (total === 0) return;
    if (!confirm(`确定要清空全部 ${total} 条查词历史吗？已收藏到生词库的词不受影响。`)) return;
    setNotice(null);
    try {
      const removed = await bridge.clearLookupHistory();
      setItems([]);
      setNotice({ tone: 'info', text: `已清空 ${removed} 条查词历史` });
      void load();
    } catch (error) {
      setNotice({ tone: 'error', text: `清空失败：${error}` });
    }
  };

  const filtering = query.trim() !== '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <TextInput
          label="搜索查词历史"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索查过的词、释义或来源"
          leading={<SearchIcon size={13} />}
          wrapperClassName="w-72"
        />
        <span className="text-xs text-ink-subtle">
          {filtering ? `匹配 ${visible.length} / ${total} 条` : `共 ${total} 条`}
        </span>
        {notice ? (
          <span
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={classNames('truncate text-xs', notice.tone === 'error' ? 'text-danger' : 'text-accent')}
          >
            {notice.text}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          icon={<Trash2Icon size={13} />}
          disabled={total === 0}
          onClick={clear}
        >
          清空历史
        </Button>
      </div>

      {recording ? null : (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-4 py-2 text-xs text-ink-muted"
        >
          <span>查词历史已关闭，新的查词不会被记录；已有的记录仍可查看和删除。</span>
          <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}>
            去设置开启
          </Button>
        </div>
      )}

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-surface">
        {items === null ? (
          <p className="py-20 text-center text-sm text-ink-subtle">正在读取查词历史…</p>
        ) : null}

        {loadError ? (
          <div role="alert" className="flex items-center justify-center gap-3 px-4 py-6 text-sm text-danger">
            <span>读取查词历史失败：{loadError}</span>
            <Button size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : null}

        {items !== null && visible.length === 0 && !loadError ? (
          <p className="py-20 text-center text-sm text-ink-subtle">
            {filtering
              ? `没有匹配「${query.trim()}」的查词记录`
              : recording
                ? '还没有查词记录。选中文字查词后，会出现在这里。'
                : '还没有查词记录。'}
          </p>
        ) : null}

        {days.map((day) => (
          <section key={day.key} aria-label={day.label}>
            <h3 className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-1.5 text-xs font-medium text-ink-muted">
              {day.label}
              <span className="ml-2 font-normal text-ink-subtle">{day.items.length} 条</span>
            </h3>
            <ul>
              {day.items.map((entry) => {
                const source = [entry.sourceApp, entry.sourceTitle].filter(Boolean).join(' · ');
                return (
                  <li
                    key={entry.id}
                    className="group flex items-start gap-3 border-b border-line px-4 py-2.5 hover:bg-raised"
                  >
                    <span className="w-10 shrink-0 pt-0.5 font-mono text-2xs text-ink-subtle">
                      {timeOfDay(entry.lastAt)}
                    </span>
                    <button
                      type="button"
                      title="再次查看"
                      aria-label={`再次查看 ${preview(entry.selection)}`}
                      onClick={() => reopen(entry)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          title={entry.selection}
                          className="min-w-0 truncate font-serif text-sm font-semibold text-ink"
                        >
                          {entry.selection}
                        </span>
                        {showsLemma(entry) ? (
                          <span className="shrink-0 text-xs text-ink-subtle">→ {entry.lemma}</span>
                        ) : null}
                        {entry.kind !== 'word' ? (
                          <span className="shrink-0 rounded bg-sunken px-1.5 text-2xs text-ink-muted">
                            {KIND_LABEL[entry.kind] ?? entry.kind}
                          </span>
                        ) : null}
                        {entry.count > 1 ? (
                          <span
                            title={`共查询 ${entry.count} 次`}
                            className="shrink-0 rounded bg-sunken px-1.5 text-2xs text-ink-muted"
                          >
                            ×{entry.count}
                          </span>
                        ) : null}
                        {isSavedLookup(entry, savedKeys) ? (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-accent">
                            <BookmarkCheckIcon size={11} aria-hidden="true" />
                            已收藏
                          </span>
                        ) : null}
                      </span>
                      {entry.translation ? (
                        <span className="mt-0.5 line-clamp-2 block text-xs text-ink-muted">
                          {entry.translation}
                        </span>
                      ) : null}
                      {source ? (
                        <span className="mt-0.5 block truncate text-2xs text-ink-subtle">{source}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      title="从历史中删除"
                      aria-label={`删除「${preview(entry.selection)}」的查词记录`}
                      onClick={() => remove(entry)}
                      className="mt-0.5 shrink-0 rounded p-1 text-ink-subtle opacity-0 transition-opacity hover:bg-sunken hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <XIcon size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
