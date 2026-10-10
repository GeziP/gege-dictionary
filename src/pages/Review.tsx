import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckIcon, ClockIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { WindowFrame } from '../components/shell/WindowFrame';
import { Button } from '../components/ui/Button';
import { CardDetails } from '../components/card/CardDetails';
import { SpeakButton } from '../components/card/SpeakButton';
import { useLexNote } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { ReviewAnswer, ReviewState, ReviewStats, SavedWord } from '../types/lexnote';
import { dueText } from '../utils/format';

/**
 * The ways to answer a card, left to right and by the keys 1, 2 and 3. "认识" is still 1, where
 * it always was; "有点难" is the new middle: not forgotten, so it stays in its box, but not
 * easy either, so it comes back tomorrow.
 */
const ANSWERS: Array<{ answer: ReviewAnswer; key: string; label: string; icon: React.ReactNode; hint: string }> = [
  { answer: 'correct', key: '1', label: '认识', icon: <CheckIcon size={15} />, hint: '升一档，隔更久再见' },
  { answer: 'hard', key: '2', label: '有点难', icon: <ClockIcon size={15} />, hint: '留在原档，明天再见' },
  { answer: 'wrong', key: '3', label: '不认识', icon: <XIcon size={15} />, hint: '回到第 1 档，明天再见' },
];

export function Review() {
  const { settings, refreshWords } = useLexNote();
  const [queue, setQueue] = useState<SavedWord[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<ReviewState[]>([]);
  // What is left to review, asked for once the queue is through: whether more words are due than
  // the queue held, and if not, when the next one is.
  const [stats, setStats] = useState<ReviewStats | null>(null);

  const load = useCallback(async (unlimited = false) => {
    setLoading(true);
    setError('');
    try {
      const cards = await bridge.getReviewQueue(unlimited ? 0 : settings.reviewLimit);
      setQueue(cards);
      setIndex(0);
      setFlipped(false);
      setAnswers([]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [settings.reviewLimit]);

  useEffect(() => { load(); }, [load]);

  const current = queue[index];
  const queueDone = !loading && !current;
  const answered = answers.length;
  useEffect(() => {
    if (!queueDone) return undefined;
    let alive = true;
    setStats(null);
    bridge
      .getReviewStats()
      .then((next) => {
        if (alive) setStats(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [queueDone, answered]);
  const saving = useRef(false);
  const answer = useCallback(async (result: ReviewAnswer) => {
    // One answer at a time: a key held down or a double click would otherwise record the card
    // twice and move on past the next one without it being seen.
    if (!current || !flipped || saving.current) return;
    saving.current = true;
    try {
      const state = await bridge.submitReview(current.id, result);
      setAnswers((previous) => [...previous, state]);
    } catch (reason) {
      // A word deleted meanwhile has no card left to answer, so move on. Any other failure
      // means the answer was not recorded: stay on the card, say why, and let it be given again.
      if (!String(reason).includes('删除')) {
        setError(String(reason));
        return;
      }
    } finally {
      saving.current = false;
    }
    setError('');
    setIndex((previous) => previous + 1);
    setFlipped(false);
    refreshWords();
  }, [current, flipped, refreshWords]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        // On a button or a link the space bar presses it (the speaker, an answer, the way back);
        // it turns the card over only when it is not pointed at anything.
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('button, a, input, textarea, select')) return;
        event.preventDefault();
        if (current) setFlipped(true);
      } else if (flipped) {
        const chosen = ANSWERS.find((item) => item.key === event.key);
        if (chosen) {
          event.preventDefault();
          answer(chosen.answer);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer, current, flipped]);

  const correct = answers.filter((item) => item.lastResult === 'correct').length;
  const hard = answers.filter((item) => item.lastResult === 'hard').length;
  const promoted = answers.filter((item) => (item.previousBox ?? item.box) < item.box).length;
  const reset = answers.filter((item) => item.lastResult === 'wrong').length;
  const progress = useMemo(() => queue.length ? Math.min(100, index / queue.length * 100) : 0, [index, queue.length]);

  return (
    <WindowFrame title="今日回顾">
      <div className="thin-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-5">
        <div className="mx-auto w-full min-w-0 max-w-xl">
          <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          {loading ? <p className="py-20 text-center text-sm text-ink-subtle">正在生成今日队列…</p> : null}
          {error ? <p className="mb-3 rounded border border-danger/30 bg-danger/5 p-3 text-xs text-danger">{error}</p> : null}
          {!loading && current ? (
            <article className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
              <div className="relative min-h-64 px-8 py-10 text-center">
                {/*
                  The whole face turns the card over, except the speaker beside the word: hearing
                  the word is part of recalling it, and must not give the meaning away. So the
                  speaker is not inside the button that flips the card, but above it.
                */}
                <button
                  type="button"
                  className="absolute inset-0 h-full w-full"
                  onClick={() => setFlipped(true)}
                  aria-label={flipped ? '卡片背面' : '翻面'}
                />
                <div className="pointer-events-none relative">
                  <p className="text-xs text-ink-subtle">{index + 1} / {queue.length} · 第 {current.reviewState?.box ?? 1} 档</p>
                  <div className="mt-8 flex items-center justify-center gap-3">
                    <h2 className="font-serif text-4xl font-bold text-ink">{current.lemma}</h2>
                    <SpeakButton className="pointer-events-auto" text={current.lemma} label={`朗读 ${current.lemma}`} />
                  </div>
                  {current.ipaUS ? <p className="mt-2 font-ipa text-base text-ink-muted">{current.ipaUS}</p> : null}
                  {!flipped ? <p className="mt-12 text-sm text-ink-subtle">先回忆含义，点击或按空格翻面</p> : (
                    <div className="mt-8 border-l-2 border-accent bg-accent-soft p-4 text-left">
                      <p className="text-lg font-medium text-ink">{current.contextMeaning || current.translation}</p>
                      <p className="mt-1 text-sm text-ink-muted">{current.translation}</p>
                      {current.context ? <p className="mt-3 border-t border-accent-line pt-3 text-xs italic text-ink-muted">{current.context}</p> : null}
                      <p className="mt-2 text-[11px] text-ink-subtle">{current.sourceApp}{current.sourceTitle ? ` · ${current.sourceTitle}` : ''}</p>
                    </div>
                  )}
                </div>
              </div>
              {flipped ? <CardDetails entry={current} revealed={6} streaming={false} /> : null}
              {flipped ? (
                <div className="border-t border-line p-4">
                  <div className="flex gap-3">
                    {ANSWERS.map(({ answer: result, key, label, icon, hint }) => (
                      <Button key={result} fullWidth icon={icon} title={hint} onClick={() => answer(result)}>
                        {label}（{key}）
                      </Button>
                    ))}
                  </div>
                  <p className="mt-2 text-center text-2xs text-ink-subtle">
                    认识会升档；有点难留在原档，明天再见；不认识回到第 1 档。
                  </p>
                </div>
              ) : null}
            </article>
          ) : null}
          {queueDone ? (
            <div className="rounded-xl border border-line bg-surface px-8 py-14 text-center">
              <h2 className="text-xl font-semibold text-ink">{answers.length ? '本次回顾完成' : '今天没有到期词'}</h2>
              {answers.length ? (
                <p className="mt-3 text-sm text-ink-muted">
                  共 {answers.length} 词，答对 {correct}，{hard > 0 ? `有点难 ${hard}，` : ''}升档 {promoted}，回落 {reset}
                </p>
              ) : <p className="mt-3 text-sm text-ink-muted">可以安心阅读，新收藏会从明天开始出现。</p>}
              {stats?.dueCount ? (
                <p className="mt-2 text-sm text-ink-muted">还有 {stats.dueCount} 个词已经到期。</p>
              ) : stats?.nextDueAt ? (
                <p className="mt-2 text-sm text-ink-muted">下次复习：{dueText(stats.nextDueAt)}</p>
              ) : null}
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                {stats?.dueCount ? (
                  <Button variant="primary" icon={<RotateCcwIcon size={15} />} onClick={() => load(true)}>继续复习全部到期词</Button>
                ) : null}
                <Link
                  to="/library"
                  className="inline-flex h-control-lg items-center rounded-md border border-line bg-surface px-3.5 text-sm font-medium text-ink hover:border-line-strong hover:bg-raised"
                >
                  回到生词库
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </WindowFrame>
  );
}
