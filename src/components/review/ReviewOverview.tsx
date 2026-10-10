import React, { useEffect, useState } from 'react';
import { ArrowRightIcon, BrainIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as bridge from '../../lib/tauri-bridge';
import type { ReviewStats } from '../../types/lexnote';
import { dueText } from '../../utils/format';

/** What the review has to say today, in a few words. */
function reviewSummary(stats: ReviewStats | null): string {
  if (!stats) return '';
  if (stats.dueCount > 0) return `${stats.dueCount} 个词等待复习`;
  if (stats.nextDueAt) return `今天没有到期的词，下次复习：${dueText(stats.nextDueAt)}`;
  return '暂无到期词';
}

/** A line at the top of the library that leads to the review. */
export function ReviewOverview() {
  const [stats, setStats] = useState<ReviewStats | null>(null);
  useEffect(() => {
    bridge.getReviewStats().then(setStats).catch(() => undefined);
  }, []);
  const due = Boolean(stats?.dueCount);
  return (
    <Link
      to="/review"
      className="mx-3 mt-2 flex items-center gap-2.5 rounded-md border border-accent-line bg-accent-soft px-3 py-1.5 hover:border-accent"
    >
      <BrainIcon size={15} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="shrink-0 text-xs font-semibold text-ink">今日回顾</span>
      <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{reviewSummary(stats)}</span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
        {due ? '去复习' : '查看'}
        <ArrowRightIcon size={13} aria-hidden="true" />
      </span>
    </Link>
  );
}
