import React from 'react';
import { RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { parseLookupError } from '../../lib/lookup-errors';

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[11px] text-ink hover:bg-sunken';

interface LookupErrorStateProps {
  /** The raw `[code] message` string the backend produced. */
  error: string | null;
  onRetry: () => void;
  onOpenSettings: () => void;
}

/** What went wrong with a lookup, what to do about it, and the one or two buttons that do it. */
export function LookupErrorState({ error, onRetry, onOpenSettings }: LookupErrorStateProps) {
  const info = parseLookupError(error);

  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center">
      <p className="text-[13px] font-medium text-danger">{info.title}</p>
      <p className="max-w-[26rem] text-[11px] leading-relaxed text-ink-subtle">{info.hint}</p>

      {info.detail &&
        (info.showDetailInline ? (
          <p className="max-w-[26rem] break-words rounded-md bg-sunken px-2.5 py-1.5 text-left text-[10px] leading-relaxed text-ink-muted">
            {info.detail}
          </p>
        ) : (
          <details className="max-w-[26rem] text-[10px] text-ink-subtle">
            <summary className="cursor-pointer select-none">详细信息</summary>
            <p className="mt-1 break-words text-left leading-relaxed">{info.detail}</p>
          </details>
        ))}

      <div className="mt-1 flex items-center gap-2">
        {info.action === 'settings' && (
          <button type="button" onClick={onOpenSettings} className={BUTTON}>
            <SettingsIcon size={12} /> {info.code === 'no_key' ? '去设置 API Key' : '去设置检查'}
          </button>
        )}
        {info.retryable && (
          <button type="button" onClick={onRetry} className={BUTTON}>
            <RefreshCwIcon size={12} /> 重试
          </button>
        )}
      </div>
    </div>
  );
}
