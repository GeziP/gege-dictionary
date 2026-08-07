import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookMarkedIcon,
  FileTextIcon,
  GridIcon,
  LibraryBigIcon,
  MessageSquareIcon,
  PowerIcon,
  SettingsIcon,
  SparklesIcon,
  Volume2Icon,
  WifiIcon } from
'lucide-react';
import { format } from 'date-fns';
import { useLexNote } from '../../contexts/LexNoteContext';
import { classNames } from '../../utils/format';

interface TaskbarProps {
  activeApp: 'paper' | 'chat';
  onSelectApp: (app: 'paper' | 'chat') => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onRunOnboarding: () => void;
}

export function Taskbar({
  activeApp,
  onSelectApp,
  onOpenLibrary,
  onOpenSettings,
  onRunOnboarding
}: TaskbarProps) {
  const { usage, settings } = useLexNote();
  const [menuOpen, setMenuOpen] = useState(false);
  const now = new Date();

  const apps = [
  { id: 'paper' as const, label: 'Acrobat Reader', icon: FileTextIcon },
  { id: 'chat' as const, label: 'Slack', icon: MessageSquareIcon }];


  return (
    <div className="absolute inset-x-0 bottom-0 z-40 flex h-10 items-center gap-1 border-t border-line bg-surface/85 px-2 backdrop-blur-xl">
      <button
        type="button"
        aria-label="开始"
        className="flex h-8 w-8 items-center justify-center rounded text-ink-muted hover:bg-sunken">
        
        <GridIcon size={16} />
      </button>
      {apps.map((app) =>
      <button
        key={app.id}
        type="button"
        onClick={() => onSelectApp(app.id)}
        className={classNames(
          'relative flex h-8 items-center gap-1.5 rounded px-2.5 text-[11px] transition-colors',
          activeApp === app.id ? 'bg-sunken text-ink' : 'text-ink-muted hover:bg-sunken'
        )}>
        
          <app.icon size={13} />
          <span className="hidden sm:inline">{app.label}</span>
          <span
          className={classNames(
            'absolute inset-x-2 bottom-0.5 h-0.5 rounded-full',
            activeApp === app.id ? 'bg-accent' : 'bg-transparent'
          )} />
        
        </button>
      )}

      <div className="relative ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={classNames(
            'flex h-8 items-center gap-1.5 rounded px-2 text-[11px] transition-colors',
            menuOpen ? 'bg-sunken text-ink' : 'text-ink-muted hover:bg-sunken'
          )}>
          
          <BookMarkedIcon size={14} className="text-accent" />
          <span className="hidden sm:inline">鸽鸽词典</span>
        </button>
        <span className="flex items-center gap-2 px-1.5 text-ink-subtle" aria-hidden="true">
          <WifiIcon size={13} />
          <Volume2Icon size={13} />
        </span>
        <div className="px-2 text-right text-[10px] leading-tight text-ink-muted">
          <div>{format(now, 'HH:mm')}</div>
          <div>{format(now, 'yyyy/MM/dd')}</div>
        </div>

        <AnimatePresence>
          {menuOpen ?
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.14 }}
            role="menu"
            className="absolute bottom-11 right-0 w-56 overflow-hidden rounded-lg border border-line bg-surface shadow-float">
            
              <div className="border-b border-line px-3 py-2">
                <p className="text-xs font-medium text-ink">鸽鸽词典 正在后台运行</p>
                <p className="mt-0.5 text-[11px] text-ink-subtle">划词即查 · {settings.provider.model}</p>
              </div>
              {[
            { label: '打开生词库', icon: LibraryBigIcon, action: onOpenLibrary },
            { label: '设置', icon: SettingsIcon, action: onOpenSettings },
            { label: '重新运行首次引导', icon: SparklesIcon, action: onRunOnboarding }].
            map((item) =>
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                item.action();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-muted hover:bg-sunken hover:text-ink">
              
                  <item.icon size={13} />
                  {item.label}
                </button>
            )}
              <div className="border-t border-line px-3 py-2 text-[11px] text-ink-subtle">
                今日 {usage.today} 次查询 · 本月 {usage.month} 次
              </div>
              <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-xs text-ink-muted hover:bg-sunken hover:text-danger">
              
                <PowerIcon size={13} />
                退出 鸽鸽词典
              </button>
            </motion.div> :
          null}
        </AnimatePresence>
      </div>
    </div>);

}