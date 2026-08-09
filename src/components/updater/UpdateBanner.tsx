import React, { useEffect, useState } from 'react';
import { DownloadIcon, XIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { checkForUpdates, dismissUpdate, getUpdaterState, installPendingUpdate, subscribeUpdater } from '../../lib/updater';
import { isTauri } from '../../lib/tauri-bridge';
import { Button } from '../ui/Button';

export function UpdateBanner() {
  const { settings, updateSettings } = useLexNote();
  const [state, setState] = useState(getUpdaterState());
  useEffect(() => subscribeUpdater(setState), []);
  useEffect(() => {
    if (!isTauri() || settings.autoCheckUpdates === false) return;
    const timer = window.setTimeout(() => {
      checkForUpdates(settings.skippedUpdateVersion).catch(() => undefined);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [settings.autoCheckUpdates, settings.skippedUpdateVersion]);

  if (!['available', 'downloading', 'installed', 'error'].includes(state.status)) return null;
  return (
    <div className="absolute inset-x-0 top-0 z-[100] flex items-center gap-3 border-b border-accent-line bg-accent-soft px-4 py-2 shadow-card">
      <DownloadIcon size={16} className="text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-ink">
          {state.status === 'available' ? `发现新版本 ${state.version}` : state.message}
        </p>
        {state.status === 'available' && state.notes ? <p className="truncate text-[11px] text-ink-muted">{state.notes}</p> : null}
        {state.status === 'downloading' ? <div className="mt-1 h-1 overflow-hidden rounded bg-sunken"><div className="h-full bg-accent" style={{ width: `${state.progress}%` }} /></div> : null}
      </div>
      {state.status === 'available' ? (
        <>
          <Button size="sm" variant="primary" onClick={() => installPendingUpdate()}>下载并安装</Button>
          <Button size="sm" variant="ghost" onClick={dismissUpdate}>稍后提醒</Button>
          <Button size="sm" variant="ghost" onClick={() => { updateSettings({ skippedUpdateVersion: state.version ?? '' }); dismissUpdate(); }}>跳过此版本</Button>
        </>
      ) : null}
      {state.status !== 'downloading' ? <button type="button" aria-label="关闭更新提示" onClick={dismissUpdate}><XIcon size={15} /></button> : null}
    </div>
  );
}
