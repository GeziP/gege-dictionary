/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import { CheckCircle2Icon, CircleDashedIcon, CircleDotIcon } from 'lucide-react';
import { MASTERY_LABELS, MASTERY_LEVELS } from '../../lib/insights';
import { classNames } from '../../utils/format';
import type { Mastery } from '../../types/lexnote';

/** The levels in the order a word goes through them: that is the order the lists and menus show them in. */
export const MASTERY_META: Record<Mastery, { label: string; icon: typeof CircleDashedIcon; tone: string }> = {
  new: { label: MASTERY_LABELS.new, icon: CircleDashedIcon, tone: 'text-danger' },
  learning: { label: MASTERY_LABELS.learning, icon: CircleDotIcon, tone: 'text-warn' },
  familiar: { label: MASTERY_LABELS.familiar, icon: CircleDotIcon, tone: 'text-warn' },
  mastered: { label: MASTERY_LABELS.mastered, icon: CheckCircle2Icon, tone: 'text-positive' },
};

/** All four levels, so that a word can be put at, and found by, each of them. */
export const MASTERY_ORDER: Mastery[] = MASTERY_LEVELS;

interface MasteryBadgeProps {
  mastery: Mastery;
  compact?: boolean;
}

export function MasteryBadge({ mastery, compact = false }: MasteryBadgeProps) {
  const meta = MASTERY_META[mastery] ?? MASTERY_META.new;
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
