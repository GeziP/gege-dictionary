import React from 'react';
import { classNames } from '../../utils/format';

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}

export function Toggle({ checked, onChange, label, description }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {description ?
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-subtle">{description}</span> :
        null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={classNames(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-sunken'
        )}>
        
        <span
          className={classNames(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all',
            checked ? 'left-[18px] bg-accent-ink' : 'left-0.5 bg-ink-subtle'
          )} />
        
      </button>
    </label>);

}