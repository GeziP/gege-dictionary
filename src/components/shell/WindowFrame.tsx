import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BookMarkedIcon,
  LibraryBigIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SquareIcon,
  SunIcon,
  XIcon,
} from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { classNames } from '../../utils/format';
import { isTauri } from '../../lib/tauri-bridge';

const NAV = [
  { to: '/library', label: '生词库', icon: LibraryBigIcon },
  { to: '/settings', label: '设置', icon: SettingsIcon },
];

const THEMES = [
  { value: 'light' as const, icon: SunIcon, label: '浅色' },
  { value: 'dark' as const, icon: MoonIcon, label: '深色' },
  { value: 'system' as const, icon: MonitorIcon, label: '跟随系统' },
];

interface WindowFrameProps {
  title: string;
  children: React.ReactNode;
}

async function minimizeWindow() {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/api/webviewWindow');
      const win = mod.getCurrentWebviewWindow();
      await win.hide();
    } catch {}
  }
}

async function closeWindow() {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/api/webviewWindow');
      const win = mod.getCurrentWebviewWindow();
      await win.hide();
    } catch {}
  }
}

export function WindowFrame({ title, children }: WindowFrameProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { usage, words, settings, updateSettings } = useLexNote();
  const inTauri = isTauri();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      <header
        className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-3"
        data-tauri-drag-region={inTauri ? '' : undefined}
      >
        <BookMarkedIcon size={14} className="text-accent" />
        <span className="text-xs font-medium text-ink">鸽鸽词典</span>
        <span className="text-xs text-ink-subtle">— {title}</span>
        <div className="ml-auto flex items-center text-ink-subtle">
          <button
            type="button"
            aria-label="最小化到托盘"
            onClick={() => (inTauri ? minimizeWindow() : navigate('/'))}
            className="flex h-8 w-10 items-center justify-center hover:bg-sunken"
          >
            <MinusIcon size={13} />
          </button>
          <span
            className="flex h-8 w-10 items-center justify-center"
            aria-hidden="true"
          >
            <SquareIcon size={10} />
          </span>
          <button
            type="button"
            aria-label="关闭窗口"
            onClick={() => (inTauri ? closeWindow() : navigate('/'))}
            className="flex h-8 w-10 items-center justify-center hover:bg-danger hover:text-white"
          >
            <XIcon size={13} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[164px] shrink-0 flex-col border-r border-line bg-surface p-2">
          {NAV.map((item) => {
            const active = location.pathname === item.to;
            return (
              <button
                key={item.to}
                type="button"
                onClick={() => navigate(item.to)}
                className={classNames(
                  'relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                  active
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-sunken hover:text-ink'
                )}
              >
                <span
                  className={classNames(
                    'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r',
                    active ? 'bg-accent' : 'bg-transparent'
                  )}
                />
                <item.icon size={15} />
                {item.label}
              </button>
            );
          })}

          <div className="mt-auto space-y-2 border-t border-line pt-2">
            <div className="px-2 text-[11px] leading-relaxed text-ink-subtle">
              <p>{words.length} 条生词</p>
              <p>今日查询 {usage.today} 次</p>
            </div>
            <div className="flex gap-1 rounded-md border border-line p-0.5">
              {THEMES.map((theme) => (
                <button
                  key={theme.value}
                  type="button"
                  aria-label={theme.label}
                  title={theme.label}
                  onClick={() => updateSettings({ theme: theme.value })}
                  className={classNames(
                    'flex h-6 flex-1 items-center justify-center rounded transition-colors',
                    settings.theme === theme.value
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-subtle hover:bg-sunken'
                  )}
                >
                  <theme.icon size={13} />
                </button>
              ))}
            </div>
          </div>
        </nav>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
