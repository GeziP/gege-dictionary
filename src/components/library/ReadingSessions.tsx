import React, { useEffect, useMemo, useState } from 'react';
import { BookOpenIcon, ChevronDownIcon, DownloadIcon, PlusCircleIcon, TagsIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import type { ReadingSession, SavedWord } from '../../types/lexnote';
import { classNames, errorText } from '../../utils/format';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';

interface Notice {
  tone: 'ok' | 'error';
  text: string;
}

export function ReadingSessions() {
  const { settings, refreshWords } = useLexNote();
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessionWords, setSessionWords] = useState<Record<string, SavedWord[]>>({});
  const [source, setSource] = useState('');
  const [tag, setTag] = useState('');
  const [message, setMessage] = useState<Notice | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const gap = settings.sessionGapMinutes ?? 30;

  const say = (text: string) => setMessage({ tone: 'ok', text });

  // Every action below talks to the backend: when it fails the user is told so, instead of the
  // click silently doing nothing.
  const attempt = async (what: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      setMessage({ tone: 'error', text: `${what}失败：${errorText(error)}` });
    }
  };

  useEffect(() => {
    let current = true;
    bridge.getReadingSessions(gap, 50, 0)
      .then((page) => {
        if (!current) return;
        setSessions(page);
        setHasMore(page.length === 50);
        setMessage((shown) => (shown?.tone === 'error' ? null : shown));
      })
      .catch((error) => {
        if (current) setMessage({ tone: 'error', text: `读取阅读会话失败：${errorText(error)}` });
      })
      .finally(() => {
        if (current) setLoaded(true);
      });
    return () => {
      current = false;
    };
  }, [gap]);

  const loadMore = () =>
    attempt('加载更多会话', async () => {
      const page = await bridge.getReadingSessions(gap, 50, sessions.length);
      setSessions((previous) => [...previous, ...page]);
      setHasMore(page.length === 50);
    });

  const sources = useMemo(() => Array.from(new Set(sessions.map((item) => item.sourceApp || '未知来源'))), [sessions]);
  const visible = source ? sessions.filter((item) => (item.sourceApp || '未知来源') === source) : sessions;

  const openSession = (session: ReadingSession) =>
    attempt('读取会话词条', async () => {
      if (expanded === session.id) {
        setExpanded(null);
        return;
      }
      setExpanded(session.id);
      if (!sessionWords[session.id]) {
        const words = await bridge.getSessionWords(session.id);
        setSessionWords((previous) => ({ ...previous, [session.id]: words }));
      }
    });

  const applyTag = (session: ReadingSession) =>
    attempt('添加标签', async () => {
      const value = tag.trim().toLowerCase();
      if (!value) return;
      const count = await bridge.tagSession(session.id, [value]);
      say(`已为 ${count} 个词添加标签「${value}」`);
      setTag('');
      void refreshWords();
    });

  const exportSession = (session: ReadingSession) =>
    attempt('导出会话', async () => {
      const content = await bridge.exportWordsData(session.wordIds, 'markdown');
      const path = await bridge.saveFileDialog(`阅读会话-${session.startAt.slice(0, 10)}.md`, content, 'Markdown', ['md']);
      if (path) say(`已导出到 ${path}`);
    });

  const addReview = (session: ReadingSession) =>
    attempt('加入复习', async () => {
      const count = await bridge.addSessionToReview(session.id);
      say(count ? `已将 ${count} 个词加入复习队列` : '该会话词条已在复习队列中');
    });

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <Select
          aria-label="按来源应用筛选"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          options={[{ value: '', label: '全部来源' }, ...sources.map((item) => ({ value: item, label: item }))]}
          className="w-48"
        />
        <span className="text-xs text-ink-subtle">相邻查词间隔 {gap} 分钟内自动聚合</span>
        {message ? (
          <span
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={classNames('ml-auto truncate text-xs', message.tone === 'error' ? 'text-danger' : 'text-accent')}
            title={message.text}
          >
            {message.text}
          </span>
        ) : null}
      </div>
      <div className="space-y-3">
        {visible.map((session) => (
          <article key={session.id} className="rounded-lg border border-line bg-surface">
            <button
              type="button"
              className="flex w-full items-center gap-3 p-4 text-left"
              aria-expanded={expanded === session.id}
              onClick={() => void openSession(session)}
            >
              <span className="rounded-lg bg-accent-soft p-2 text-accent"><BookOpenIcon size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">{session.sourceTitle || session.sourceApp || '未知阅读来源'}</span>
                <span className="mt-0.5 block text-xs text-ink-subtle">
                  {new Date(session.startAt).toLocaleString()} – {new Date(session.endAt).toLocaleTimeString()} · {session.wordCount} 词
                </span>
                <span className="mt-1 block truncate text-xs text-ink-muted">{session.preview.join(' · ')}</span>
              </span>
              <ChevronDownIcon size={16} aria-hidden="true" className={expanded === session.id ? 'rotate-180 text-accent' : 'text-ink-subtle'} />
            </button>
            {expanded === session.id ? (
              <div className="border-t border-line p-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {(sessionWords[session.id] ?? []).map((word) => (
                    <div key={word.id} className="rounded border border-line bg-raised px-3 py-2">
                      <span className="font-serif font-semibold text-ink">{word.lemma}</span>
                      <span className="ml-2 text-xs text-ink-muted">{word.translation}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <input
                    value={tag}
                    onChange={(event) => setTag(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) void applyTag(session);
                    }}
                    aria-label="批量标签"
                    placeholder="批量标签"
                    className="h-8 rounded border border-line bg-surface px-2 text-xs outline-none focus:border-accent"
                  />
                  <Button size="sm" icon={<TagsIcon size={13} />} onClick={() => void applyTag(session)}>添加标签</Button>
                  <Button size="sm" icon={<DownloadIcon size={13} />} onClick={() => void exportSession(session)}>导出会话</Button>
                  <Button size="sm" icon={<PlusCircleIcon size={13} />} onClick={() => void addReview(session)}>加入复习</Button>
                </div>
              </div>
            ) : null}
          </article>
        ))}
        {loaded && !visible.length && message?.tone !== 'error' ? (
          <p className="py-20 text-center text-sm text-ink-subtle">
            {sessions.length
              ? '这个来源下还没有阅读会话'
              : `还没有阅读会话。连续查词（相邻两次不超过 ${gap} 分钟）会自动归为一个会话。`}
          </p>
        ) : null}
      </div>
      {hasMore ? <Button className="mx-auto mt-4 flex" onClick={() => void loadMore()}>加载更多</Button> : null}
    </div>
  );
}
