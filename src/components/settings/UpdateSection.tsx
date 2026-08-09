import React, { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { RefreshCwIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { checkForUpdates, getUpdaterState, installPendingUpdate, subscribeUpdater } from '../../lib/updater';
import { isTauri } from '../../lib/tauri-bridge';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { SettingsSection } from './SettingsSection';

export function UpdateSection() {
  const { settings, updateSettings } = useLexNote();
  const [version, setVersion] = useState('1.2.0');
  const [state, setState] = useState(getUpdaterState());
  useEffect(() => subscribeUpdater(setState), []);
  useEffect(() => { if (isTauri()) getVersion().then(setVersion).catch(() => undefined); }, []);
  return (
    <SettingsSection title="应用更新" description="更新检查只请求 GitHub Releases 的版本文件，不上传用户数据或使用统计。">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div><p className="text-sm text-ink">当前版本</p><p className="text-xs text-ink-subtle">v{version}</p></div>
        <Button
          size="sm"
          loading={state.status === 'checking'}
          icon={<RefreshCwIcon size={14} />}
          onClick={() => checkForUpdates('', true)}
        >立即检查更新</Button>
      </div>
      <Toggle
        checked={settings.autoCheckUpdates !== false}
        onChange={(autoCheckUpdates) => updateSettings({ autoCheckUpdates })}
        label="自动检查更新"
        description="启动 30 秒后静默检查；关闭后仅在点击按钮时联网。"
      />
      {state.message ? <p className={`mt-2 text-xs ${state.status === 'error' ? 'text-danger' : 'text-accent'}`}>{state.message}</p> : null}
      {state.status === 'available' ? (
        <div className="mt-3 rounded border border-accent-line bg-accent-soft p-3">
          <p className="text-sm font-medium text-ink">可更新至 v{state.version}</p>
          {state.notes ? <p className="mt-1 text-xs text-ink-muted">{state.notes}</p> : null}
          <Button className="mt-3" size="sm" variant="primary" onClick={() => installPendingUpdate()}>下载并安装</Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}
