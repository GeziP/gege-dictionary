import React from 'react';
import { CheckCircle2Icon, CircleDashedIcon, CircleDotIcon } from 'lucide-react';
import { classNames } from '../../utils/format';
import type { Mastery } from '../../types/lexnote';

export const MASTERY_META: Record<Mastery, { label: string; icon: typeof CircleDashedIcon; tone: string }> = {
  new: { label: '新词', icon: CircleDashedIcon, tone: 'text-danger' },
  familiar: { label: '熟悉', icon: CircleDotIcon, tone: 'text-warn' },
  mastered: { label: '已掌握', icon: CheckCircle2Icon, tone: 'text-positive' },
};

export const MASTERY_ORDER: Mastery[] = ['new', 'familiar', 'mastered'];

interface MasteryBadgeProps {
  mastery: Mastery;
  compact?: boolean;
}

export function MasteryBadge({ mastery, compact = false }: MasteryBadgeProps) {
  const meta = MASTERY_META[mastery];
  const Icon = meta.icon;
  return (
    <span
      className={classNames('inline-flex items-center gap-1.5 text-2xs text-ink-muted', meta.tone)}
      title={compact ? meta.label : undefined}
    >
      <Icon size={13} aria-hidden="true" />
      <span className={compact ? 'sr-only' : 'text-ink-muted'}>{meta.label}</span>
    </span>
  );
}
