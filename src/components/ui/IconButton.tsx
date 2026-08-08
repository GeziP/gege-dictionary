import React, { forwardRef } from 'react';
import { classNames } from '../../utils/format';

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  tone?: 'default' | 'danger';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, active = false, tone = 'default', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      className={classNames(
        'inline-flex h-control w-control shrink-0 items-center justify-center rounded-md transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-ink-subtle hover:bg-sunken hover:text-ink',
        tone === 'danger' && 'hover:bg-danger hover:text-accent-ink',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
