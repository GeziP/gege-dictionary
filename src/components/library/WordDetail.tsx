import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlignJustifyIcon,
  CheckIcon,
  ListIcon,
  LoaderIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import type { Mastery, SavedWord } from '../../types/lexnote';
import { classNames, relativeTime } from '../../utils/format';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { SpeakButton } from '../card/SpeakButton';
import { EditableText } from './EditableText';
import { RichText } from '../ui/RichText';
import { DomainAnalysis } from '../domain/DomainAnalysis';

const MASTERY: { value: Mastery; label: string }[] = [
  { value: 'new', label: '新词' },
  { value: 'familiar', label: '熟悉' },
  { value: 'mastered', label: '已掌握' },
];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-0.5 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">
      {children}
    </h3>
  );
}

export function WordDetail({
  word,
  onClose,
  inline,
  fontSize: initialFontSize = 13,
}: {
  word: SavedWord | null;
  onClose?: () => void;
  inline?: boolean;
  fontSize?: number;
}) {
  const { updateWord, removeWords, settings, tags } = useLexNote();
  const [savedFlash, setSavedFlash] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [snapshot, setSnapshot] = useState<SavedWord | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [fontSize, setFontSize] = useState(initialFontSize);
  const [interleave, setInterleave] = useState(true);
  const flashTimer = useRef<number>();

  useEffect(() => {
    setSnapshot(null);
    setTagDraft('');
  }, [word?.id]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  if (!word) {
    return null;
  }

  const patch = (changes: Partial<SavedWord>) => {
    updateWord(word.id, changes);
    setSavedFlash(true);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
  };

  const reanalyze = () => {
    setSnapshot(word);
    setReanalyzing(true);
    window.setTimeout(() => {
      setReanalyzing(false);
      updateWord(word.id, { savedAt: new Date().toISOString(), lookups: word.lookups + 1 });
    }, 1300);
  };

  const rollback = () => {
    if (!snapshot) return;
    updateWord(word.id, snapshot);
    setSnapshot(null);
  };

  const suggestions = tags.filter(
    (tag) => !word.tags.includes(tag) && tag.startsWith(tagDraft.toLowerCase())
  );

  const asideClass = inline
    ? 'flex flex-col h-full'
    : 'thin-scroll flex h-full w-[368px] min-h-0 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface';

  return (
    <aside className={asideClass}>
      <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭详情"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-sunken"
            >
              <XIcon size={14} className="text-ink-subtle" />
            </button>
          )}
          <h2 className="font-serif text-[18px] font-bold leading-tight text-ink">{word.lemma}</h2>
          <span className="text-[11px] text-ink-subtle">{word.pos}</span>
          <span className="font-ipa text-[12px] text-ink-muted">{word.ipaUS}</span>
          <SpeakButton text={word.lemma} label={`朗读 ${word.lemma}`} size={13} />
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 rounded border border-line px-0.5">
              <button
                type="button"
                aria-label="缩小字体"
                title="缩小字体"
                onClick={() => setFontSize((s) => Math.max(10, s - 1))}
                className="flex h-5 w-5 items-center justify-center rounded text-ink-subtle hover:text-ink"
              >
                <MinusIcon size={10} />
              </button>
              <span className="min-w-[20px] text-center text-[9px] text-ink-muted">{fontSize}</span>
              <button
                type="button"
                aria-label="放大字体"
                title="放大字体"
                onClick={() => setFontSize((s) => Math.min(22, s + 1))}
                className="flex h-5 w-5 items-center justify-center rounded text-ink-subtle hover:text-ink"
              >
                <PlusIcon size={10} />
              </button>
            </div>
            {word.kind === 'paragraph' && (
              <button
                type="button"
                title={interleave ? '整段显示' : '逐句对照'}
                onClick={() => setInterleave(!interleave)}
                className={classNames(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors',
                  interleave ? 'text-accent' : 'text-ink-subtle hover:text-ink'
                )}
              >
                {interleave ? <ListIcon size={13} /> : <AlignJustifyIcon size={13} />}
              </button>
            )}
            <AnimatePresence>
              {savedFlash ? (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="inline-flex items-center gap-1 text-[11px] text-positive"
                >
                  <CheckIcon size={11} /> 已保存
                </motion.span>
              ) : null}
            </AnimatePresence>
            <Button
              size="sm"
              icon={
                reanalyzing ? (
                  <LoaderIcon size={12} className="animate-spin" />
                ) : (
                  <SparklesIcon size={12} />
                )
              }
              onClick={reanalyze}
              disabled={reanalyzing}
            >
              重新解析
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2Icon size={12} />}
              aria-label="删除该生词"
              onClick={() => removeWords([word.id])}
            />
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex gap-0.5 rounded-md border border-line p-0.5">
            {MASTERY.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => patch({ mastery: item.value })}
                className={classNames(
                  'rounded px-2 py-0.5 text-[10px] transition-colors',
                  word.mastery === item.value
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-sunken hover:text-ink'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-ink-subtle">查询 {word.lookups} 次</span>
        </div>
      </div>

      {snapshot && !reanalyzing ? (
        <div className="flex items-start gap-2 border-b border-line bg-accent-soft px-3 py-1.5">
          <SparklesIcon size={13} className="mt-0.5 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-ink">
              已用 {settings.provider.model} 重新解析
            </p>
          </div>
          <Button size="sm" icon={<RotateCcwIcon size={11} />} onClick={rollback}>
            回滚
          </Button>
        </div>
      ) : null}

      <div className="space-y-2 px-2 py-2" style={{ fontSize: `${fontSize}px` }}>
        {word.tags.length > 0 && (
          <section>
            <FieldLabel>标签</FieldLabel>
            <div className="flex flex-wrap items-center gap-1 px-2">
              {word.tags.map((tag) => (
                <Chip
                  key={tag}
                  label={tag}
                  tone="accent"
                  onRemove={() => patch({ tags: word.tags.filter((t) => t !== tag) })}
                />
              ))}
              <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5">
                <PlusIcon size={10} className="text-ink-subtle" />
                <input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && tagDraft.trim()) {
                      patch({
                        tags: [
                          ...word.tags,
                          (suggestions[0] ?? tagDraft).trim().toLowerCase(),
                        ],
                      });
                      setTagDraft('');
                    }
                  }}
                  placeholder="新标签"
                  aria-label="添加标签"
                  className="w-16 bg-transparent text-[11px] text-ink placeholder:text-ink-subtle outline-none"
                />
              </span>
            </div>
          </section>
        )}

        {word.kind === 'paragraph' && interleave ? (
          <section>
            <FieldLabel>逐句对照</FieldLabel>
            {word.translationPairs && word.translationPairs.length > 0 ? (
              <InterleavedParagraph pairs={word.translationPairs} />
            ) : word.context ? (
              <InterleavedParagraph pairs={buildFallbackPairs(word.context, word.translation)} />
            ) : (
              <div className="px-2 text-[0.92em] text-ink-muted">{word.translation}</div>
            )}
          </section>
        ) : (
          <>
            {word.translation && (
              <section>
                <FieldLabel>翻译</FieldLabel>
                <div className="px-2">
                  <RichText>{word.translation}</RichText>
                </div>
              </section>
            )}

            {word.contextMeaning && (
              <section>
                <FieldLabel>语境释义</FieldLabel>
                <div className="px-2">
                  <RichText className="text-ink-muted">{word.contextMeaning}</RichText>
                </div>
              </section>
            )}
          </>
        )}

        {word.explanation && (
          <section>
            <FieldLabel>详细解释</FieldLabel>
            <div className="px-2">
              <RichText className="text-ink-muted">{word.explanation}</RichText>
            </div>
          </section>
        )}

        <DomainAnalysis analysis={word.domainAnalysis} />

        {word.senses && word.senses.length > 0 && (
          <section>
            <FieldLabel>常见义项</FieldLabel>
            <ul className="space-y-0.5 px-2">
              {word.senses.map((s, i) => (
                <li key={i} className="text-[12px] text-ink-muted">
                  <span className="text-ink-subtle">{s.pos}</span>{' '}
                  {s.gloss} — <span className="text-ink">{s.translation}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {word.associations && word.associations.length > 0 && (
          <section>
            <FieldLabel>领域知识</FieldLabel>
            <div className="space-y-1 px-2">
              {word.associations.map((a, i) => (
                <div key={i} className="rounded border border-line bg-raised px-2 py-1">
                  <span className="text-[10px] font-medium text-accent">
                    {a.kind === 'root' ? '知识点' : a.kind === 'synonym' ? '近义' : a.kind === 'confusable' ? '易混' : '扩展'}
                  </span>
                  <span className="ml-1 text-[11px] font-medium text-ink">{a.title}</span>
                  <div className="mt-0.5">
                    <RichText className="text-[11px]">{a.detail}</RichText>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {word.examples.length > 0 ? (
          <section>
            <FieldLabel>例句</FieldLabel>
            <ul className="space-y-1 px-2">
              {word.examples.map((example, index) => (
                <li key={example.en} className="group flex items-start gap-1.5">
                  <span className="mt-0.5 text-[10px] text-ink-subtle">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-snug text-ink">{example.en}</p>
                    <p className="text-[11px] text-ink-subtle">{example.zh}</p>
                  </div>
                  <SpeakButton
                    text={example.en}
                    label="朗读例句"
                    size={12}
                    className="opacity-0 group-hover:opacity-100"
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {word.collocations && word.collocations.length > 0 && (
          <section>
            <FieldLabel>常见搭配</FieldLabel>
            <div className="flex flex-wrap gap-1 px-2">
              {word.collocations.map((c, i) => (
                <span key={i} className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] text-ink-muted">
                  {c}
                </span>
              ))}
            </div>
          </section>
        )}

        {word.register && (
          <section>
            <div className="px-2">
              <span className="inline-block rounded-full bg-sunken px-2 py-0.5 text-[10px] text-ink-subtle">
                {word.register === 'formal' && '正式'}
                {word.register === 'neutral' && '中性'}
                {word.register === 'spoken' && '口语'}
                {word.register === 'slang' && '俚语'}
                {word.register === 'technical' && '技术'}
              </span>
            </div>
          </section>
        )}

        <section>
          <FieldLabel>个人笔记</FieldLabel>
          <EditableText
            value={word.note}
            onCommit={(value) => patch({ note: value })}
            label="编辑个人笔记"
            multiline
            placeholder="写下你自己的理解…"
          />
        </section>

        <section>
          <FieldLabel>原始上下文</FieldLabel>
          <div className="mx-2 rounded-md border border-line bg-raised p-2">
            <p className="text-[11px] leading-relaxed text-ink-muted">"{word.context}"</p>
            <p className="mt-1 text-[10px] text-ink-subtle">
              {word.sourceApp} · {relativeTime(word.savedAt)}
            </p>
          </div>
        </section>
      </div>
    </aside>
  );
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
    <div className="space-y-0.5 px-2">
      {pairs.map((pair, i) => (
        <div key={i} className="rounded border border-line/60 bg-raised px-2 py-1.5">
          <p className="text-[0.95em] leading-relaxed text-ink">{pair.en}</p>
          {pair.zh && (
            <p className="mt-0.5 text-[0.9em] leading-relaxed text-accent">{pair.zh}</p>
          )}
        </div>
      ))}
    </div>
  );
}
