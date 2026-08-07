import React from 'react';
import { classNames } from '../../utils/format';

interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  invalid?: boolean;
}

export function TextInput({ leading, trailing, invalid, className, ...rest }: TextInputProps) {
  return (
    <div
      className={classNames(
        'flex items-center gap-2 rounded-lg border bg-surface px-2.5 h-9 transition-colors focus-within:border-accent',
        invalid ? 'border-danger' : 'border-line',
        className
      )}>
      
      {leading ? <span className="text-ink-subtle shrink-0">{leading}</span> : null}
      <input
        className="w-full bg-transparent text-sm text-ink placeholder:text-ink-subtle outline-none"
        {...rest} />
      
      {trailing ? <span className="text-ink-subtle shrink-0">{trailing}</span> : null}
    </div>);

}