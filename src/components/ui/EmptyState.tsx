import React from 'react';

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  hint?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full bg-sunken text-ink-subtle"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="space-y-1">
        <p className="text-base font-medium text-ink">{title}</p>
        <p className="max-w-sm text-xs leading-relaxed text-ink-subtle">{description}</p>
      </div>
      {action}
      {hint ? <div className="text-2xs text-ink-subtle">{hint}</div> : null}
    </div>
  );
}
