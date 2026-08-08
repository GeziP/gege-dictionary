import React from 'react';
import { Loader2Icon } from 'lucide-react';
import { classNames } from '../../utils/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  fullWidth?: boolean;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'border border-transparent bg-accent text-accent-ink hover:bg-accent-hover',
  secondary: 'border border-line bg-surface text-ink hover:border-line-strong hover:bg-raised',
  ghost: 'border border-transparent bg-transparent text-ink-muted hover:bg-sunken hover:text-ink',
  danger: 'border border-line bg-transparent text-danger hover:border-danger hover:bg-danger hover:text-accent-ink',
};

const SIZES: Record<Size, string> = {
  sm: 'h-control gap-1.5 rounded-md px-2.5 text-xs',
  md: 'h-control-lg gap-2 rounded-md px-3.5 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  fullWidth,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classNames(
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? <Loader2Icon size={14} className="animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}