import React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  PauseIcon,
  PlayIcon,
  SettingsIcon,
  SparklesIcon,
  SquareIcon,
} from 'lucide-react';
import type { EnrichmentControl } from '../../hooks/useEnrichment';
import {
  dealtWith,
  estimateTokens,
  explainFailure,
  explainStop,
  formatTokens,
  isRunActive,
  isRunOver,
} from '../../lib/enrichment';
import type { EnrichmentProgress, EnrichmentStatus } from '../../types/lexnote';
import { Button } from '../ui/Button';

const PANEL = 'mx-3 mt-3 rounded-lg border border-accent-line bg-surface px-4 py-3';

function TokensToday({ status }: { status: EnrichmentStatus }) {
  const used = formatTokens(status.tokensToday);
  return (
    <span>
      {status.dailyLimit === null
        ? `今天已用约 ${used} tokens（没有设上限）`
        : `今天已用约 ${used} / ${formatTokens(status.dailyLimit)} tokens`}
    </span>
  );
}

function counts(progress: EnrichmentProgress): string {
  const parts = [`已补全 ${progress.done} / ${progress.total} 个`];
  if (progress.failed > 0) parts.push(`失败 ${progress.failed}`);
  if (progress.skipped > 0) parts.push(`已无需补全 ${progress.skipped}`);
  parts.push(`本轮约用 ${formatTokens(progress.tokens)} tokens`);
  return parts.join(' · ');
}

function ProgressBar({ progress }: { progress: EnrichmentProgress }) {
  const handled = dealtWith(progress);
  const percent = progress.total > 0 ? Math.min(100, Math.round((handled / progress.total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label="补全进度"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={handled}
      className="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken"
    >
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Heading({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <span className="mt-0.5 rounded-full bg-accent-soft p-2 text-accent">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {children}
      </div>
    </div>
  );
}

function Failures({ progress }: { progress: EnrichmentProgress }) {
  if (progress.failed === 0) return null;
  const unlisted = progress.failed - progress.failures.length;
  return (
    <details className="mt-2 text-[11px] text-ink-muted">
      <summary className="cursor-pointer select-none">没补成功的词（{progress.failed}）</summary>
      <ul className="mt-1.5 space-y-0.5">
        {progress.failures.map((failure) => (
          <li key={`${failure.lemma}-${failure.message}`}>
            <span className="font-medium text-ink">{failure.lemma}</span>：{explainFailure(failure)}
          </li>
        ))}
      </ul>
      {unlisted > 0 ? <p className="mt-1">另有 {unlisted} 个没有在这里列出。</p> : null}
    </details>
  );
}

/**
 * The batch enrichment in the library: what is waiting for it, how a run is going and, once it
 * has ended, how it ended and what to do next. It says nothing when there is nothing to say.
 */
export function EnrichmentPanel({ enrichment }: { enrichment: EnrichmentControl }) {
  const { status, error, busy, dismissed, start, pause, resume, stop, dismiss } = enrichment;
  const failure = error ? (
    <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p>
  ) : null;

  if (!status) return failure ? <div className={PANEL}>{failure}</div> : null;
  const { progress } = status;

  if (isRunActive(progress.state)) {
    const stopping = progress.state === 'stopping';
    const paused = progress.state === 'paused';
    return (
      <section aria-label="批量补全" className={PANEL}>
        <div className="flex items-start gap-3">
          <Heading
            icon={<SparklesIcon size={17} aria-hidden="true" />}
            title={stopping ? '正在停止…' : paused ? '补全已暂停' : '正在补全生词'}
          >
            <p className="text-xs text-ink-muted">
              {stopping
                ? progress.current
                  ? `等「${progress.current}」这个词完成后就停下`
                  : '马上停下'
                : paused
                  ? '点“继续”接着补全，或者停止这一轮'
                  : progress.current
                    ? `正在处理：${progress.current}`
                    : '准备下一个词…'}
            </p>
          </Heading>
          <div className="flex shrink-0 items-center gap-2">
            {paused ? (
              <Button size="sm" variant="primary" icon={<PlayIcon size={13} aria-hidden="true" />} onClick={() => void resume()} disabled={busy}>
                继续
              </Button>
            ) : (
              <Button size="sm" icon={<PauseIcon size={13} aria-hidden="true" />} onClick={() => void pause()} disabled={busy || stopping}>
                暂停
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<SquareIcon size={13} aria-hidden="true" />} onClick={() => void stop()} disabled={busy || stopping}>
              停止
            </Button>
          </div>
        </div>
        <ProgressBar progress={progress} />
        <p className="mt-2 text-[11px] text-ink-subtle">{counts(progress)}</p>
        <p className="mt-0.5 text-[11px] text-ink-subtle"><TokensToday status={status} /></p>
        {failure}
      </section>
    );
  }

  if (isRunOver(progress.state) && !dismissed) {
    const reason = progress.stoppedBecause;
    const why = reason ? explainStop(reason) : null;
    const finished = progress.state === 'finished';
    const title = why
      ? why.title
      : finished
        ? `补全完成：补好了 ${progress.done} 个词`
        : `已停止：补好了 ${progress.done} 个词`;
    return (
      <section aria-label="批量补全" className={PANEL}>
        <Heading
          icon={why ? <AlertTriangleIcon size={17} aria-hidden="true" /> : <CheckCircle2Icon size={17} aria-hidden="true" />}
          title={title}
        >
          {why ? <p className="text-xs text-ink-muted">{why.hint}</p> : null}
          <p className="mt-1 text-[11px] text-ink-subtle">
            {counts(progress)}
            {status.pending > 0 ? ` · 还有 ${status.pending} 个词没补全` : ''}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-subtle"><TokensToday status={status} /></p>
          <Failures progress={progress} />
          {failure}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {status.pending > 0 ? (
              <Button size="sm" variant="primary" icon={<PlayIcon size={13} aria-hidden="true" />} onClick={() => void start()} disabled={busy}>
                继续补全
              </Button>
            ) : null}
            {why?.toSettings ? (
              <Link
                to="/settings"
                className="inline-flex h-control items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink hover:border-line-strong hover:bg-raised"
              >
                <SettingsIcon size={13} aria-hidden="true" /> 去设置
              </Link>
            ) : null}
            <Button size="sm" variant="ghost" onClick={dismiss}>知道了</Button>
          </div>
        </Heading>
      </section>
    );
  }

  if (status.pending === 0) return failure ? <div className={PANEL}>{failure}</div> : null;

  return (
    <section aria-label="批量补全" className={PANEL}>
      <div className="flex items-start gap-3">
        <Heading icon={<SparklesIcon size={17} aria-hidden="true" />} title={`${status.pending} 个词还没有义项和例句`}>
          <p className="text-xs text-ink-muted">
            它们只有导入时的释义。可以让主模型逐个补全；只填空缺的部分，你写的释义、笔记、标签和复习进度都不会被改动。
          </p>
          <p className="mt-1 text-[11px] text-ink-subtle">
            全部补完约需 {formatTokens(estimateTokens(status.pending))} tokens。<TokensToday status={status} />
            {status.dailyLimit !== null && estimateTokens(status.pending) > status.dailyLimit
              ? '，额度用完会自动停下，剩下的明天可以接着补。'
              : '。'}
          </p>
          {failure}
        </Heading>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/settings"
            aria-label="补全的额度和节奏在设置里调整"
            title="补全的额度和节奏在设置里调整"
            className="inline-flex h-control items-center rounded-md border border-transparent px-2 text-ink-muted hover:bg-sunken hover:text-ink"
          >
            <SettingsIcon size={13} aria-hidden="true" />
          </Link>
          <Button size="sm" variant="primary" icon={<SparklesIcon size={13} aria-hidden="true" />} onClick={() => void start()} disabled={busy}>
            开始补全
          </Button>
        </div>
      </div>
    </section>
  );
}
