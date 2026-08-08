import React, { useId } from 'react';
import { classNames } from '../../utils/format';

interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hideLabel?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  invalid?: boolean;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
}

export function TextInput({
  label,
  hideLabel = true,
  leading,
  trailing,
  invalid,
  error,
  hint,
  className,
  wrapperClassName,
  id,
  ...rest
}: TextInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const message = error ?? hint;
  const isInvalid = invalid || !!error;

  return (
    <div className={classNames('flex flex-col gap-1', wrapperClassName)}>
      {label ? (
        <label
          htmlFor={inputId}
          className={classNames(hideLabel ? 'sr-only' : 'text-xs font-medium text-ink-muted')}
        >
          {label}
        </label>
      ) : null}
      <div
        className={classNames(
          'flex h-control-lg items-center gap-2 rounded-md border bg-surface px-2.5 transition-colors focus-within:border-accent',
          isInvalid ? 'border-danger' : 'border-line',
          className,
        )}
      >
        {leading ? <span className="shrink-0 text-ink-subtle" aria-hidden="true">{leading}</span> : null}
        <input
          id={inputId}
          aria-invalid={isInvalid || undefined}
          aria-describedby={message ? messageId : undefined}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
          {...rest}
        />
        {trailing ? <span className="shrink-0 text-ink-subtle">{trailing}</span> : null}
      </div>
      {message ? (
        <p id={messageId} className={classNames('text-2xs', error ? 'text-danger' : 'text-ink-subtle')}>
          {message}
        </p>
      ) : null}
    </div>
  );
}