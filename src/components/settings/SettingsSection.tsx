import React from 'react';

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-subtle">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>);

}