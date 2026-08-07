import React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { classNames } from '../../utils/format';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: {value: string;label: string;}[];
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <div className={classNames('relative', className)}>
      <select
        className="h-9 w-full appearance-none rounded-lg border border-line bg-surface pl-2.5 pr-8 text-sm text-ink outline-none transition-colors focus:border-accent"
        {...rest}>
        
        {options.map((option) =>
        <option key={option.value} value={option.value}>
            {option.label}
          </option>
        )}
      </select>
      <ChevronDownIcon
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
      
    </div>);

}