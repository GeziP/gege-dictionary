import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3Icon, Trash2Icon } from 'lucide-react';
import * as bridge from '../../lib/tauri-bridge';
import type { LocalMetrics } from '../../types/lexnote';
import { Button } from '../ui/Button';
import { SettingsSection } from './SettingsSection';

function pct(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${Math.round(value * 100)}%`;
}

export function LocalStatsSection() {
  const [metrics, setMetrics] = useState<LocalMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await bridge.getLocalMetrics(7);
      setMetrics(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleClear = async () => {
    setClearing(true);
    try {
      await bridge.clearLocalMetrics();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  };

  const reasons = metrics
    ? Object.entries(metrics.filteredByReason || {}).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="space-y-3">
      <SettingsSection
        title="本地统计"
        description="近 7 日查词与过滤情况，仅保存在本机，不会上传。"
      >
        {error && <p className="mb-2 text-[11px] text-danger">{error}</p>}
        {!metrics && !error && (
          <p className="text-[12px] text-ink-muted">加载中…</p>
        )}
        {metrics && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="近 7 日查词" value={String(metrics.queries)} />
              <StatCard label="今日查词" value={String(metrics.todayQueries)} />
              <StatCard label="缓存命中率" value={pct(metrics.cacheHitRate)} />
              <StatCard label="已过滤" value={String(metrics.filtered)} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="缓存命中" value={String(metrics.cacheHit)} />
              <StatCard label="缓存未命中" value={String(metrics.cacheMiss)} />
              <StatCard label="流式降级" value={String(metrics.streamFallback)} />
              <StatCard label="复习答题" value={String(metrics.reviewAnswered)} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatCard label="阅读会话查看" value={String(metrics.sessionsViewed)} />
              <StatCard label="术语命中" value={String(metrics.glossaryApplied)} />
              <StatCard
                label="流式首字段 ≤1s"
                value={String(
                  (metrics.streamFirstFieldBuckets?.['0-500'] || 0) +
                    (metrics.streamFirstFieldBuckets?.['500-1000'] || 0)
                )}
              />
            </div>
            {Object.keys(metrics.streamFirstFieldBuckets || {}).length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-medium text-ink-muted">流式首字段耗时分桶</p>
                <ul className="space-y-1 text-[11px] text-ink-muted">
                  {Object.entries(metrics.streamFirstFieldBuckets || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([bucket, count]) => (
                      <li
                        key={bucket}
                        className="flex items-center justify-between rounded bg-sunken px-2 py-1"
                      >
                        <span className="font-mono">{bucket}ms</span>
                        <span>{count}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {reasons.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
                  <BarChart3Icon size={12} /> 过滤原因分布
                </p>
                <ul className="space-y-1 text-[11px] text-ink-muted">
                  {reasons.map(([reason, count]) => (
                    <li key={reason} className="flex items-center justify-between rounded bg-sunken px-2 py-1">
                      <span className="font-mono">{reason}</span>
                      <span>{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" onClick={handleClear} disabled={clearing}>
                <Trash2Icon size={12} className="mr-1" />
                清除本地统计
              </Button>
            </div>
          </>
        )}
        <p className="mt-2 text-[10px] text-ink-subtle">
          事件按日聚合，不含选中原文、译文或 API Key。
        </p>
      </SettingsSection>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-raised px-2.5 py-2">
      <div className="text-[10px] text-ink-subtle">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}
