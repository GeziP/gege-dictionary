import React from 'react';
import { MinusIcon, SquareIcon, XIcon } from 'lucide-react';
import { classNames } from '../../utils/format';

interface MockWindowChromeProps {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onFocus?: () => void;
  children: React.ReactNode;
}

export function MockWindowChrome({
  title,
  subtitle,
  icon,
  active = true,
  className,
  style,
  onFocus,
  children
}: MockWindowChromeProps) {
  return (
    <section
      onMouseDown={onFocus}
      style={style}
      className={classNames(
        'flex flex-col overflow-hidden rounded-lg border bg-surface transition-shadow',
        active ? 'border-line-strong shadow-window' : 'border-line shadow-panel',
        className
      )}>
      
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-raised px-3">
        <span className="text-ink-muted">{icon}</span>
        <span className="truncate text-xs font-medium text-ink">{title}</span>
        {subtitle ? <span className="truncate text-[11px] text-ink-subtle">— {subtitle}</span> : null}
        <div className="ml-auto flex items-center text-ink-subtle">
          <span className="flex h-7 w-9 items-center justify-center hover:bg-sunken" aria-hidden="true">
            <MinusIcon size={12} />
          </span>
          <span className="flex h-7 w-9 items-center justify-center hover:bg-sunken" aria-hidden="true">
            <SquareIcon size={10} />
          </span>
          <span className="flex h-7 w-9 items-center justify-center hover:bg-danger hover:text-white" aria-hidden="true">
            <XIcon size={12} />
          </span>
        </div>
      </div>
      {children}
    </section>);

}