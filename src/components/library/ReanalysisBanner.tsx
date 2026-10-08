import React from 'react';
import { RotateCcwIcon, SparklesIcon } from 'lucide-react';
import type { ReanalysisState } from '../../hooks/useReanalysis';
import { parseLookupError } from '../../lib/lookup-errors';
import { Button } from '../ui/Button';

interface ReanalysisBannerProps {
  state: ReanalysisState;
  onRollback: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}

/** What the last re-analysis of the open word did: a way back when it worked, the real reason when it did not. */
export function ReanalysisBanner({
  state,
  onRollback,
  onRetry,
  onOpenSettings,
}: ReanalysisBannerProps) {
  if (state.status === 'done') {
    return (
      <div
        role="status"
        className="flex items-start gap-2 border-b border-line bg-accent-soft px-3 py-1.5"
      >
        <SparklesIcon size={13} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-ink">
            已用 {state.model}
            {state.viaBackup ? '（备用模型）' : ''} 重新解析
          </p>
          {state.rollbackError ? (
            <p className="mt-0.5 break-words text-[10px] text-danger">
              回滚失败：{state.rollbackError}
            </p>
          ) : null}
        </div>
        <Button size="sm" icon={<RotateCcwIcon size={11} />} onClick={onRollback}>
          回滚
        </Button>
      </div>
    );
  }

  if (state.status === 'error') {
    const info = parseLookupError(state.error);
    return (
      <div role="alert" className="border-b border-danger/30 bg-danger/5 px-3 py-2">
        <p className="text-[11px] font-medium text-danger">重新解析失败，词条保持原样</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-ink-subtle">
          <span className="text-ink-muted">{info.title}。</span>
          {info.hint}
        </p>
        {info.detail &&
          (info.showDetailInline ? (
            <p className="mt-1 break-words rounded-md bg-sunken px-2 py-1 text-[10px] leading-relaxed text-ink-muted">
              {info.detail}
            </p>
          ) : (
            <details className="mt-1 text-[10px] text-ink-subtle">
              <summary className="cursor-pointer select-none">详细信息</summary>
              <p className="mt-1 break-words leading-relaxed">{info.detail}</p>
            </details>
          ))}
        <div className="mt-1.5 flex items-center gap-2">
          {info.action === 'settings' && (
            <Button size="sm" onClick={onOpenSettings}>
              {info.code === 'no_key' ? '去设置 API Key' : '去设置检查'}
            </Button>
          )}
          {info.retryable && (
            <Button size="sm" onClick={onRetry}>
              重试
            </Button>
          )}
        </div>
      </div>
    );
  }

  return null;
}
