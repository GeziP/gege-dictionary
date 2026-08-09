import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BookMarkedIcon,
  LibraryBigIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  BrainIcon,
  SettingsIcon,
  SquareIcon,
  SunIcon,
  XIcon,
} from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { classNames } from '../../utils/format';
import { SegmentedControl } from '../ui/SegmentedControl';
import { isTauri } from '../../lib/tauri-bridge';

const NAV = [
  { to: '/library', label: '生词库', icon: LibraryBigIcon },
  { to: '/review', label: '今日回顾', icon: BrainIcon },
  { to: '/settings', label: '设置', icon: SettingsIcon },
];

const THEMES = [
  { value: 'light' as const, label: '浅色', icon: <SunIcon size={13} aria-hidden="true" /> },
  { value: 'dark' as const, label: '深色', icon: <MoonIcon size={13} aria-hidden="true" /> },
  { value: 'system' as const, label: '跟随系统', icon: <MonitorIcon size={13} aria-hidden="true" /> },
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
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  }
}

async function closeWindow() {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/api/webviewWindow');
      const win = mod.getCurrentWebviewWindow();
      await win.hide();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  }
}

export function WindowFrame({ title, children }: WindowFrameProps) {
  const navigate = useNavigate();
  const { usage, words, settings, updateSettings } = useLexNote();
  const inTauri = isTauri();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      <header
        className="flex h-titlebar shrink-0 items-center gap-2 border-b border-line bg-surface pl-3"
        data-tauri-drag-region={inTauri ? '' : undefined}
      >
        <BookMarkedIcon size={15} className="text-accent" aria-hidden="true" />
        <span className="text-xs font-medium text-ink">鸽鸽词典</span>
        <span className="text-xs text-ink-subtle" aria-hidden="true">— {title}</span>
        <div className="ml-auto flex items-center self-stretch text-ink-subtle">
          <WindowButton label="最小化到托盘" onClick={() => (inTauri ? minimizeWindow() : navigate('/'))}>
            <MinusIcon size={14} aria-hidden="true" />
          </WindowButton>
          <WindowButton label="最大化窗口" disabled>
            <SquareIcon size={11} aria-hidden="true" />
          </WindowButton>
          <WindowButton label="关闭窗口" tone="danger" onClick={() => (inTauri ? closeWindow() : navigate('/'))}>
            <XIcon size={14} aria-hidden="true" />
          </WindowButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="主导航" className="flex w-rail shrink-0 flex-col gap-0.5 border-r border-line bg-surface p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                classNames(
                  'relative flex h-control-lg items-center gap-2.5 rounded-md pl-3 pr-2.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-muted hover:bg-sunken hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    aria-hidden="true"
                    className={classNames(
                      'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-sm',
                      isActive ? 'bg-accent' : 'bg-transparent',
                    )}
                  />
                  <item.icon size={15} aria-hidden="true" />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}

          <div className="mt-auto space-y-2 border-t border-line pt-2">
            <dl className="space-y-0.5 px-1 text-2xs text-ink-subtle">
              <div className="flex justify-between gap-2">
                <dt>生词</dt>
                <dd className="font-medium text-ink-muted">{words.length} 条</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>今日查询</dt>
                <dd className="font-medium text-ink-muted">{usage.today} 次</dd>
              </div>
            </dl>
            <SegmentedControl
              label="外观主题"
              iconOnly
              options={THEMES}
              value={settings.theme}
              onChange={(theme) => updateSettings({ theme })}
              className="justify-between"
            />
          </div>
        </nav>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}

function WindowButton({
  label,
  tone = 'default',
  children,
  onClick,
  disabled,
}: {
  label: string;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={classNames(
        'flex h-full w-11 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-50',
        tone === 'danger' ? 'hover:bg-danger hover:text-accent-ink' : 'hover:bg-sunken hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
