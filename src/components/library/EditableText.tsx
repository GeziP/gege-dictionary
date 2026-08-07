import React, { useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '../../utils/format';

interface EditableTextProps {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
}

export function EditableText({
  value,
  onCommit,
  label,
  multiline,
  placeholder,
  className,
}: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  const startEdit = () => {
    setEditing(true);
    setDraft(value);
    requestAnimationFrame(() => {
      if (multiline && textareaRef.current) {
        autoResize(textareaRef.current);
        textareaRef.current.focus();
      } else if (inputRef.current) {
        inputRef.current.focus();
      }
    });
  };

  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={startEdit}
        onKeyDown={(e) => { if (e.key === 'Enter') startEdit(); }}
        className={classNames(
          'w-full cursor-text rounded-md border border-transparent px-2 py-1 text-[13px] leading-relaxed transition-colors hover:border-line hover:bg-surface',
          !value && 'text-ink-subtle italic',
          className,
        )}
      >
        {value || placeholder || '点击编辑…'}
      </div>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={textareaRef}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          autoResize(e.target);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
        }}
        className={classNames(
          'w-full resize-none overflow-hidden rounded-md border border-accent bg-surface px-2 py-1 text-[13px] leading-relaxed text-ink outline-none',
          className,
        )}
      />
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') cancel();
      }}
      className={classNames(
        'w-full rounded-md border border-accent bg-surface px-2 py-1 text-[13px] leading-relaxed text-ink outline-none',
        className,
      )}
    />
  );
}
