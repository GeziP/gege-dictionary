import React from 'react';
import { classNames } from '../../utils/format';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  iconOnly?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  iconOnly = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={classNames('flex items-center gap-0.5 rounded-md border border-line p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={classNames(
              'inline-flex h-control items-center justify-center gap-1.5 rounded-sm px-2 text-xs transition-colors',
              iconOnly ? 'w-control px-0' : 'flex-1',
              active
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-ink-subtle hover:bg-sunken hover:text-ink',
            )}
          >
            {option.icon}
            {iconOnly ? null : option.label}
          </button>
        );
      })}
    </div>
  );
}
