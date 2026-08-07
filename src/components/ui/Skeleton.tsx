import React from 'react';
import { classNames } from '../../utils/format';

export function Skeleton({ className }: {className?: string;}) {
  return (
    <div
      aria-hidden="true"
      className={classNames('skeleton-line animate-shimmer rounded', className)} />);


}