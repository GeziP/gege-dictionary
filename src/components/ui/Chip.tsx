import React from 'react';
import { XIcon } from 'lucide-react';
import { classNames } from '../../utils/format';

interface ChipProps {
  label: string;
  tone?: 'default' | 'accent' | 'muted';
  onRemove?: () => void;
  onClick?: () => void;
  active?: boolean;
}

export function Chip({ label, tone = 'default', onRemove, onClick, active }: ChipProps) {
  const base =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-5 transition-colors';
  const tones = {
    default: 'border-line bg-raised text-ink-muted',
    accent: 'border-accent-line bg-accent-soft text-accent',
    muted: 'border-transparent bg-sunken text-ink-subtle'
  };
  const Element = onClick ? 'button' : 'span';
  return (
    <Element
      {...onClick ? { type: 'button' as const, onClick } : {}}
      className={classNames(
        base,
        tones[tone],
        active && 'border-accent bg-accent-soft text-accent',
        onClick && 'hover:border-line-strong'
      )}>
      
      {label}
      {onRemove ?
      <button
        type="button"
        aria-label={`移除标签 ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="text-ink-subtle hover:text-danger">
        
          <XIcon size={11} />
        </button> :
      null}
    </Element>);

}