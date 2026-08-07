import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlignJustifyIcon,
  BookmarkPlusIcon,
  CheckCircle2Icon,
  ListIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  Undo2Icon,
  Volume2Icon,
  XIcon,
  PinIcon,
} from 'lucide-react';
import { useLexNote } from '../contexts/LexNoteContext';
import { Skeleton } from '../components/ui/Skeleton';
import { SpeakButton } from '../components/card/SpeakButton';
import type { SavedWord } from '../types/lexnote';
import { classNames } from '../utils/format';
import { RichText } from '../components/ui/RichText';
import * as bridge from '../lib/tauri-bridge';

export function Lookup() {
  const {
    lookupStatus,
    lookupResult,
    lookupError,
    lookupSelection,
    lookupContext,
    lookupSourceApp,
    lookupSourceTitle,
    settings,
    findByLemma,
    saveWord: ctxSaveWord,
    triggerLookup,
    countLookup,
  } = useLexNote();

  const [saved, setSaved] = useState(false);
  const [undoTimer, setUndoTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [pinned, setPinned] = useState(false);
  const [initDone, setInitDone] = useState(false);

  const [emptyHint, setEmptyHint] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [interleave, setInterleave] = useState(true);
  const fontUp = () => setFontSize((s) => Math.min(s + 1, 18));
  const fontDown = () => setFontSize((s) => Math.max(s - 1, 10));

  useEffect(() => {
    if (initDone) return;
    setInitDone(true);

    const doInit = async () => {
      try {
        const capture = await bridge.getLastCapture();
        if (capture && capture.selection && capture.selection.trim()) {
          setTimeout(() => {
            triggerLookup(
              capture.selection,
              capture.context || '',
              capture.kind || 'word',
              capture.sourceApp,
              capture.sourceTitle,
            );
          }, 80);
        } else {
          setEmptyHint(true);
        }
      } catch {
        setEmptyHint(true);
      }
    };
    doInit();
  }, [initDone, triggerLookup]);

  const entry = lookupResult;
  const existing = entry ? findByLemma(entry.lemma) : undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pinned) {
        bridge.closeLookupWindow();
      }
      if (e.key === 'Enter' && entry && !saved) {
        handleSave();
      }
      if (e.key === ' ' && entry) {
        e.preventDefault();
        bridge.speakText(entry.lemma, settings.ttsVoice, settings.ttsRate);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [entry, saved, pinned]);

  useEffect(() => {
    if (pinned) return;
    if (lookupStatus !== 'done' && lookupStatus !== 'error') return;

    const handler = () => {
      setTimeout(() => {
        if (!document.hasFocus() && !pinned) {
          bridge.closeLookupWindow();
        }
      }, 500);
    };
    window.addEventListener('blur', handler);
    return () => window.removeEventListener('blur', handler);
  }, [pinned, lookupStatus]);

  const handleSave = useCallback(() => {
    if (!entry) return;
    const word: SavedWord = {
      ...entry,
      id: existing?.id || `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      savedAt: new Date().toISOString(),
      context: lookupContext,
      sourceApp: lookupSourceApp,
      sourceTitle: lookupSourceTitle,
      tags: tagInput.trim() ? [tagInput.trim().toLowerCase()] : [],
      mastery: 'new',
      lookups: (existing?.lookups || 0) + 1,
      note: existing?.note || '',
    };
    ctxSaveWord(word);
    setSaved(true);
    countLookup(0);
    const timer = setTimeout(() => setUndoTimer(null), 5000);
    setUndoTimer(timer);
  }, [entry, existing, lookupContext, lookupSourceApp, lookupSourceTitle, tagInput, ctxSaveWord, countLookup]);

  const handleRetry = () => {
    if (lookupSelection) {
      const wc = lookupSelection.split(/\s+/).length;
      const kind = wc >= 30 ? 'paragraph' : wc >= 6 ? 'sentence' : lookupSelection.includes(' ') ? 'phrase' : 'word';
      triggerLookup(lookupSelection, lookupContext, kind);
    }
  };

  return (
    <div className="h-full w-full overflow-hidden bg-surface text-ink">
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="flex-1 truncate text-[11px] text-ink-subtle">
            {lookupSourceApp && `${lookupSourceApp} · `}
            {lookupSelection || '等待取词…'}
          </span>
          <div className="flex items-center gap-0.5 rounded border border-line px-0.5">
            <button type="button" title="缩小字体" onClick={fontDown}
              className="flex h-4 w-4 items-center justify-center rounded text-ink-subtle hover:text-ink">
              <MinusIcon size={9} />
            </button>
            <span className="text-[9px] text-ink-subtle">{fontSize}</span>
            <button type="button" title="放大字体" onClick={fontUp}
              className="flex h-4 w-4 items-center justify-center rounded text-ink-subtle hover:text-ink">
              <PlusIcon size={9} />
            </button>
          </div>
          {entry?.kind === 'paragraph' && (
            <button
              type="button"
              title={interleave ? '整段显示' : '逐句对照'}
              onClick={() => setInterleave(!interleave)}
              className={classNames(
                'flex h-5 w-5 items-center justify-center rounded transition-colors',
                interleave ? 'text-accent' : 'text-ink-subtle hover:text-ink'
              )}
            >
              {interleave ? <ListIcon size={11} /> : <AlignJustifyIcon size={11} />}
            </button>
          )}
          <button
            type="button"
            title={pinned ? '取消钉住' : '钉住窗口'}
            onClick={() => setPinned(!pinned)}
            className={classNames(
              'flex h-5 w-5 items-center justify-center rounded transition-colors',
              pinned ? 'text-accent' : 'text-ink-subtle hover:text-ink'
            )}
          >
            <PinIcon size={11} />
          </button>
          <button
            type="button"
            title="关闭 (Esc)"
            onClick={() => bridge.closeLookupWindow()}
            className="flex h-5 w-5 items-center justify-center rounded text-ink-subtle hover:text-ink"
          >
            <XIcon size={12} />
          </button>
        </div>

        {/* Content */}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2.5" style={{ fontSize: `${fontSize}px` }}>
          {(lookupStatus === 'idle' && !entry) && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[12px] text-ink-subtle">
              {emptyHint ? (
                <>
                  <p className="text-[14px] font-medium text-ink">未获取到文本</p>
                  <p>请在任意应用中选中英文文本后按 Ctrl+C 复制</p>
                </>
              ) : (
                <p>等待剪贴板中的英文文本…</p>
              )}
            </div>
          )}

          {(lookupStatus === 'loading' || lookupStatus === 'streaming') && !entry && (
            <div className="space-y-3">
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {lookupStatus === 'error' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <p className="text-[12px] text-danger">{lookupError}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[11px] text-ink hover:bg-sunken"
              >
                <RefreshCwIcon size={12} /> 重试
              </button>
            </div>
          )}

          {entry && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-2.5"
            >
              {/* Primary: Word + IPA + Speak */}
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-bold text-ink">{entry.lemma}</span>
                  <span className="text-[12px] text-ink-subtle">{entry.pos}</span>
                </div>
                {(entry.ipaUS || entry.ipaUK) && (
                  <div className="mt-0.5 flex items-center gap-3 text-[12px]">
                    {entry.ipaUS && (
                      <span className="font-ipa text-ink-muted">
                        US <span className="text-ink">{entry.ipaUS}</span>
                      </span>
                    )}
                    {entry.ipaUK && (
                      <span className="font-ipa text-ink-muted">
                        UK <span className="text-ink">{entry.ipaUK}</span>
                      </span>
                    )}
                    <SpeakButton text={entry.lemma} size="sm" />
                  </div>
                )}
              </div>

              {/* Translation */}
              {entry.kind === 'paragraph' && interleave && entry.translationPairs && entry.translationPairs.length > 0 ? (
                <InterleavedParagraph pairs={entry.translationPairs} />
              ) : entry.kind === 'paragraph' && interleave && lookupSelection ? (
                <InterleavedParagraph pairs={buildFallbackPairs(lookupSelection, entry.translation)} />
              ) : (
                <>
                  <div className="rounded-md bg-accent-soft px-2.5 py-2 leading-relaxed text-ink">
                    {entry.contextMeaning || entry.translation}
                  </div>
                  {entry.translation && entry.contextMeaning && (
                    <p className="text-[0.92em] text-ink-muted">
                      <span className="font-medium text-ink-subtle">翻译：</span>
                      <RichText>{entry.translation}</RichText>
                    </p>
                  )}
                </>
              )}

              {/* Explanation */}
              {entry.explanation && (
                <div>
                  <SectionTitle>深度解析</SectionTitle>
                  <div className="mt-0.5">
                    <RichText>{entry.explanation}</RichText>
                  </div>
                </div>
              )}

              {/* Senses */}
              {entry.senses && entry.senses.length > 0 && (
                <div>
                  <SectionTitle>常见义项</SectionTitle>
                  <ul className="mt-0.5 space-y-0.5">
                    {entry.senses.map((s, i) => (
                      <li key={i} className="text-[0.92em] text-ink-muted">
                        <span className="font-medium text-accent">{s.pos}</span>{' '}
                        {s.gloss} — <span className="font-medium text-ink">{s.translation}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Associations */}
              {entry.associations && entry.associations.length > 0 && (
                <div>
                  <SectionTitle>领域知识</SectionTitle>
                  <div className="mt-0.5 space-y-1">
                    {entry.associations.map((a, i) => (
                      <div key={i} className="rounded border border-line bg-raised px-2 py-1.5">
                        <span className="text-[0.85em] font-semibold text-accent">
                          {a.kind === 'root' ? '知识点' : a.kind === 'synonym' ? '近义辨析' : a.kind === 'confusable' ? '易混词' : '扩展'}
                        </span>
                        <span className="ml-1.5 text-[0.85em] font-bold text-ink">{a.title}</span>
                        <div className="mt-0.5">
                          <RichText>{a.detail}</RichText>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Examples */}
              {entry.examples && entry.examples.length > 0 && (
                <div>
                  <SectionTitle>例句</SectionTitle>
                  <div className="mt-0.5 space-y-1.5">
                    {entry.examples.map((ex, i) => (
                      <div key={i} className="group text-[0.92em]">
                        <p className="leading-relaxed text-ink">
                          <HighlightWord text={ex.en} word={entry.lemma} />
                          <button
                            type="button"
                            onClick={() => bridge.speakText(ex.en, settings.ttsVoice, settings.ttsRate)}
                            className="ml-1 inline opacity-0 transition-opacity group-hover:opacity-100"
                            title="朗读例句"
                          >
                            <Volume2Icon size={11} className="text-ink-subtle" />
                          </button>
                        </p>
                        <p className="text-ink-muted">{ex.zh}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Collocations */}
              {entry.collocations && entry.collocations.length > 0 && (
                <div>
                  <SectionTitle>常见搭配</SectionTitle>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {entry.collocations.map((c, i) => (
                      <span
                        key={i}
                        className="rounded-full border border-line bg-raised px-2 py-0.5 text-[0.77em] text-ink-muted"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Register */}
              {entry.register && (
                <span className="inline-block rounded-full bg-sunken px-2 py-0.5 text-[10px] text-ink-subtle">
                  {entry.register === 'formal' && '正式'}
                  {entry.register === 'neutral' && '中性'}
                  {entry.register === 'spoken' && '口语'}
                  {entry.register === 'slang' && '俚语'}
                  {entry.register === 'technical' && '技术'}
                </span>
              )}

              {/* AI disclaimer */}
              <p className="mt-1 border-t border-line pt-1.5 text-[10px] text-ink-subtle/60">
                AI 生成内容，专业术语和代码请以官方文档为准
              </p>

              {/* Syntax (for sentences) */}
              {entry.syntax && entry.syntax.length > 0 && (
                <div>
                  <SectionTitle>句法拆解</SectionTitle>
                  <div className="mt-0.5 space-y-0.5">
                    {entry.syntax.map((s, i) => (
                      <div key={i} className="text-[0.92em]">
                        <span className="font-bold text-accent">{s.part}</span>
                        <span className="ml-1.5 text-ink-muted">{s.note}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Key Terms (for sentences) */}
              {entry.keyTerms && entry.keyTerms.length > 0 && (
                <div>
                  <SectionTitle>关键词汇</SectionTitle>
                  <div className="mt-0.5 space-y-0.5">
                    {entry.keyTerms.map((kt, i) => (
                      <div key={i} className="text-[0.92em]">
                        <span className="font-bold text-accent">{kt.term}</span>
                        <span className="ml-1.5 text-ink-muted">{kt.gloss}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </div>

        {/* Template & Model Info */}
        {entry && lookupStatus === 'done' && (
          <div className="flex items-center gap-2 border-t border-line bg-sunken/50 px-3 py-1 text-[10px] text-ink-subtle">
            <span>模板: <span className="font-medium text-ink-muted">{(entry as any)._templateName || '未知'}</span></span>
            <span className="ml-auto">{settings.provider.model}</span>
          </div>
        )}

        {/* Save Bar */}
        {entry && (
          <div className="border-t border-line bg-raised px-3 py-2">
            {!saved ? (
              <div className="flex items-center gap-2">
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="标签（可选，回车保存）"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                  }}
                  className="h-7 flex-1 rounded border border-line bg-surface px-2 text-[11px] text-ink placeholder:text-ink-subtle outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={handleSave}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-ink hover:bg-accent-hover"
                >
                  <BookmarkPlusIcon size={12} />
                  {existing ? '更新解析' : '加入生词库'}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-positive">
                  <CheckCircle2Icon size={12} /> 已收藏
                </span>
                {undoTimer && (
                  <button
                    type="button"
                    onClick={() => {
                      setSaved(false);
                      if (undoTimer) clearTimeout(undoTimer);
                      setUndoTimer(null);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-ink-subtle hover:text-ink"
                  >
                    <Undo2Icon size={11} /> 撤销
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[0.85em] font-semibold uppercase tracking-wider text-ink-subtle">{children}</p>;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildFallbackPairs(original: string, translation: string): { en: string; zh: string }[] {
  const origSentences = splitSentences(original);
  const transSentences = splitSentences(translation);
  return origSentences.map((en, i) => ({
    en,
    zh: transSentences[i] || '',
  }));
}

function InterleavedParagraph({ pairs }: { pairs: { en: string; zh: string }[] }) {
  return (
    <div className="space-y-0.5">
      {pairs.map((pair, i) => (
        <div key={i} className="rounded border border-line/60 bg-raised px-2.5 py-1.5">
          <p className="leading-relaxed text-ink">{pair.en}</p>
          {pair.zh && (
            <p className="mt-0.5 leading-relaxed text-accent">{pair.zh}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function HighlightWord({ text, word }: { text: string; word: string }) {
  if (!word) return <>{text}</>;
  const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <span key={i} className="rounded bg-highlight px-0.5 font-medium">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}
