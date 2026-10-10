import React, { useEffect, useRef, useState } from 'react';
import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';

/** How long "已保存" stays beside the tabs after a setting was stored. */
const SAVED_MS = 2_000;

/**
 * Whether the last change to a setting has reached the disk: a few words beside the tabs, which
 * are there on every tab, because a setting is changed on one of them and nothing else says it
 * has been kept.
 */
export function SettingsSaveBadge() {
  const { settingsSaveStatus } = useLexNote();
  const [justSaved, setJustSaved] = useState(false);
  const before = useRef(settingsSaveStatus);

  useEffect(() => {
    const was = before.current;
    before.current = settingsSaveStatus;
    if (was === 'saving' && settingsSaveStatus === 'idle') {
      setJustSaved(true);
      const timer = window.setTimeout(() => setJustSaved(false), SAVED_MS);
      return () => window.clearTimeout(timer);
    }
    if (settingsSaveStatus !== 'idle') setJustSaved(false);
    return undefined;
  }, [settingsSaveStatus]);

  return (
    // The region is always there, so that what appears in it is read out.
    <div role="status" aria-live="polite" className="flex h-full shrink-0 items-center pl-2 pr-3 text-[11px]">
      {settingsSaveStatus === 'saving' ? (
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <Loader2Icon size={12} className="animate-spin" aria-hidden="true" /> 保存中…
        </span>
      ) : justSaved ? (
        <span className="inline-flex items-center gap-1 text-positive">
          <CheckIcon size={12} aria-hidden="true" /> 已保存
        </span>
      ) : null}
    </div>
  );
}

/** Says that a change was not kept, and why; it stays until it is read and put away, or the next change. */
export function SettingsSaveError() {
  const { settingsSaveStatus, settingsSaveError, dismissSettingsSaveError } = useLexNote();
  if (settingsSaveStatus !== 'error' || !settingsSaveError) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/5 px-4 py-2 text-xs text-danger"
    >
      <p className="min-w-0 flex-1">设置保存失败，已恢复为改动之前的样子：{settingsSaveError}</p>
      <button
        type="button"
        aria-label="关闭保存失败的提示"
        onClick={dismissSettingsSaveError}
        className="shrink-0 rounded p-0.5 hover:bg-danger/10"
      >
        <XIcon size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
