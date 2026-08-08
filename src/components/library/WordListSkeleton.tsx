import React from 'react';
import { Skeleton } from '../ui/Skeleton';

export function WordListSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-label="正在刷新生词库">
      <span className="sr-only">正在刷新生词库…</span>
      <div className="flex h-9 items-center gap-4 border-b border-line bg-raised px-3">
        <Skeleton className="h-2.5 w-4" />
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="ml-auto h-2.5 w-12" />
      </div>
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-line px-3 py-3">
          <Skeleton className="h-3.5 w-3.5 rounded-sm" />
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
