import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { WindowFrame } from '../components/shell/WindowFrame';
import { Button } from '../components/ui/Button';
import { CardDetails } from '../components/card/CardDetails';
import { SpeakButton } from '../components/card/SpeakButton';
import { useLexNote } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { ReviewState, SavedWord } from '../types/lexnote';

export function Review() {
  const { settings, refreshWords } = useLexNote();
  const [queue, setQueue] = useState<SavedWord[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<ReviewState[]>([]);

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
  const answer = useCallback(async (correct: boolean) => {
    if (!current || !flipped) return;
    try {
      const state = await bridge.submitReview(current.id, correct);
      setAnswers((previous) => [...previous, state]);
    } catch (reason) {
      if (!String(reason).includes('删除')) setError(String(reason));
    }
    setIndex((previous) => previous + 1);
    setFlipped(false);
    refreshWords();
  }, [current, flipped, refreshWords]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        if (current) setFlipped(true);
      } else if (flipped && event.key === '1') {
        event.preventDefault();
        answer(true);
      } else if (flipped && event.key === '2') {
        event.preventDefault();
        answer(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer, current, flipped]);

  const correct = answers.filter((item) => item.lastResult === 'correct').length;
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
              <button
                type="button"
                className="block min-h-64 w-full px-8 py-10 text-center"
                onClick={() => setFlipped(true)}
                aria-label={flipped ? '卡片背面' : '翻面'}
              >
                <p className="text-xs text-ink-subtle">{index + 1} / {queue.length} · Box {current.reviewState?.box ?? 1}</p>
                <div className="mt-8 flex items-center justify-center gap-3">
                  <h2 className="font-serif text-4xl font-bold text-ink">{current.lemma}</h2>
                  <SpeakButton text={current.lemma} label={`朗读 ${current.lemma}`} />
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
              </button>
              {flipped ? <CardDetails entry={current} revealed={6} streaming={false} /> : null}
              {flipped ? (
                <div className="flex gap-3 border-t border-line p-4">
                  <Button fullWidth icon={<CheckIcon size={15} />} onClick={() => answer(true)}>认识（1）</Button>
                  <Button fullWidth icon={<XIcon size={15} />} onClick={() => answer(false)}>不认识（2）</Button>
                </div>
              ) : null}
            </article>
          ) : null}
          {!loading && !current ? (
            <div className="rounded-xl border border-line bg-surface px-8 py-14 text-center">
              <h2 className="text-xl font-semibold text-ink">{answers.length ? '本次回顾完成' : '今天没有到期词'}</h2>
              {answers.length ? (
                <p className="mt-3 text-sm text-ink-muted">共 {answers.length} 词，答对 {correct}，升档 {promoted}，回落 {reset}</p>
              ) : <p className="mt-3 text-sm text-ink-muted">可以安心阅读，新收藏会从明天开始出现。</p>}
              <Button className="mt-6" icon={<RotateCcwIcon size={15} />} onClick={() => load(true)}>继续复习全部到期词</Button>
            </div>
          ) : null}
        </div>
      </div>
    </WindowFrame>
  );
}
