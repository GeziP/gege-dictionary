import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  ChartColumnIcon,
  LibraryBigIcon,
  MonitorIcon,
  MoonIcon,
  BrainIcon,
  SettingsIcon,
  SunIcon,
} from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { classNames } from '../../utils/format';
import { SegmentedControl } from '../ui/SegmentedControl';
import { bundledVersion } from '../../lib/version';

const NAV = [
  { to: '/library', label: '生词库', icon: LibraryBigIcon },
  { to: '/review', label: '今日回顾', icon: BrainIcon },
  { to: '/insights', label: '学习洞察', icon: ChartColumnIcon },
  { to: '/settings', label: '设置', icon: SettingsIcon },
];

const THEMES = [
  { value: 'light' as const, label: '浅色', icon: <SunIcon size={13} aria-hidden="true" /> },
  { value: 'dark' as const, label: '深色', icon: <MoonIcon size={13} aria-hidden="true" /> },
  { value: 'system' as const, label: '跟随系统', icon: <MonitorIcon size={13} aria-hidden="true" /> },
];

interface WindowFrameProps {
  /** What the page is called; it names the page for screen readers (the window's own title bar is the system's). */
  title: string;
  children: React.ReactNode;
}

/**
 * The shell of the main window's pages: the navigation on the left and the page beside it. The
 * window keeps its system title bar, which already minimises, maximises, drags and closes (to the
 * tray); a second bar of the same kind inside it only took room and did less.
 */
export function WindowFrame({ title, children }: WindowFrameProps) {
  const { usage, words, settings, updateSettings } = useLexNote();

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas">
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
          <p className="px-1 text-2xs text-ink-subtle">鸽鸽词典 v{bundledVersion}</p>
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

      <main aria-label={title} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
