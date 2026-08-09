import { check, type Update } from '@tauri-apps/plugin-updater';

export type UpdaterStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installed' | 'error';
export interface UpdaterState {
  status: UpdaterStatus;
  version?: string;
  notes?: string;
  progress: number;
  message?: string;
}

let state: UpdaterState = { status: 'idle', progress: 0 };
let pending: Update | null = null;
const listeners = new Set<(next: UpdaterState) => void>();

function publish(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener(state));
}

export function getUpdaterState() { return state; }
export function subscribeUpdater(listener: (next: UpdaterState) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function checkForUpdates(skippedVersion = '', manual = false): Promise<UpdaterState> {
  publish({ status: 'checking', progress: 0, message: undefined });
  try {
    pending?.close();
    pending = await check({ timeout: 15_000 });
    if (!pending) {
      publish({ status: 'idle', version: undefined, notes: undefined, message: manual ? '当前已是最新版本' : undefined });
    } else if (!manual && pending.version === skippedVersion) {
      pending.close();
      pending = null;
      publish({ status: 'idle', message: undefined });
    } else {
      publish({ status: 'available', version: pending.version, notes: pending.body ?? '', message: undefined });
    }
  } catch (error) {
    publish(manual
      ? { status: 'error', message: `检查更新失败：${String(error)}` }
      : { status: 'idle', message: undefined });
  }
  return state;
}

export async function installPendingUpdate() {
  if (!pending) throw new Error('没有可安装的更新');
  let downloaded = 0;
  let total = 0;
  publish({ status: 'downloading', progress: 0, message: '正在下载更新…' });
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      if (event.event === 'Progress') downloaded += event.data.chunkLength;
      if (event.event === 'Finished') publish({ progress: 100, message: '下载完成，正在安装…' });
      if (total > 0) publish({ progress: Math.min(99, Math.round(downloaded / total * 100)) });
    });
    publish({ status: 'installed', progress: 100, message: '更新已安装，请重新启动应用' });
  } catch (error) {
    publish({ status: 'error', message: `更新失败，当前版本仍可正常使用：${String(error)}` });
  }
}

export function dismissUpdate() {
  publish({ status: 'idle', message: undefined });
}
