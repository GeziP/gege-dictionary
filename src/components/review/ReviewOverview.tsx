import React, { useEffect, useState } from 'react';
import { ArrowRightIcon, BrainIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as bridge from '../../lib/tauri-bridge';
import type { ReviewStats } from '../../types/lexnote';

export function ReviewOverview() {
  const [stats, setStats] = useState<ReviewStats | null>(null);
  useEffect(() => {
    bridge.getReviewStats().then(setStats).catch(() => undefined);
  }, []);
  return (
    <Link to="/review" className="mx-3 mt-3 flex items-center gap-3 rounded-lg border border-accent-line bg-accent-soft px-4 py-3 hover:border-accent">
      <span className="rounded-full bg-accent p-2 text-accent-ink"><BrainIcon size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">今日回顾</span>
        <span className="text-xs text-ink-muted">
          {stats?.dueCount ? `${stats.dueCount} 个词等待复习` : stats?.nextDueAt ? `下次复习：${stats.nextDueAt}` : '暂无到期词'}
        </span>
      </span>
      <ArrowRightIcon size={16} className="text-accent" />
    </Link>
  );
}
