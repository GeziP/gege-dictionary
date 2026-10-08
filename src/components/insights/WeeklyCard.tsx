import React, { useMemo, useState } from 'react';
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { dayLabel, describeCounts } from '../../lib/insights';
import * as bridge from '../../lib/tauri-bridge';
import {
  GOAL_CHOICES,
  REPORT_WINDOW_DAYS,
  buildWeeklyReport,
  describeGoal,
  effectiveGoalDays,
  goalProgress,
  weekOf,
  type WeekChoice,
  type WeekDay,
} from '../../lib/weekly';
import type { LearningInsights } from '../../types/lexnote';
import { classNames } from '../../utils/format';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';

const GOAL_OPTIONS = GOAL_CHOICES.map((days) => ({
  value: String(days),
  label: days === 0 ? '不设目标' : days === 7 ? '每天' : `每周 ${days} 天`,
}));

const REPORT_WEEKS: Array<{ value: WeekChoice; label: string }> = [
  { value: 'this', label: '本周' },
  { value: 'last', label: '上周' },
];

/** What a day looks like in the strip: done, still to do today, yet to come, or a day without anything. */
function markerClass(day: WeekDay): string {
  if (day.active) return 'border-transparent bg-accent text-accent-ink';
  if (day.upcoming) return 'border-dashed border-line text-ink-subtle';
  if (day.today) return 'border-accent text-accent';
  return 'border-line bg-sunken text-ink-subtle';
}

function describeWeekDay(day: WeekDay): string {
  return `${dayLabel(day.date)}${day.today ? '（今天）' : ''}：${day.upcoming ? '还没到' : describeCounts(day.counts)}`;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * This week day by day, the goal for the week and how far it is, and the week (this one or the
 * last) as a Markdown report to save or copy. The strip is made of the page's own figures, which
 * always reach back to Monday; the report asks for fresh figures that also reach last week.
 */
export function WeeklyCard({ data }: { data: LearningInsights }) {
  const { settings, updateSettings } = useLexNote();
  const goalSetting = settings.weeklyGoalDays;
  const goalDays = effectiveGoalDays(goalSetting);
  const week = useMemo(() => weekOf(data, 'this'), [data]);
  const progress = week ? goalProgress(week, goalSetting) : null;

  const [reportWeek, setReportWeek] = useState<WeekChoice>('this');
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const exportReport = async (how: 'save' | 'copy') => {
    setBusy(how);
    setOutcome(null);
    let result: Outcome | null = null;
    try {
      const fresh = await bridge.getLearningInsights(REPORT_WINDOW_DAYS);
      const report = buildWeeklyReport(fresh, reportWeek, goalSetting);
      if (!report) throw new Error('读到的记录没有覆盖这一周');
      if (how === 'save') {
        // No path means that the dialog was closed without saving, which needs no message.
        const path = await bridge.saveFileDialog(report.fileName, report.markdown, 'Markdown', ['md']);
        if (path) result = { ok: true, text: `已保存到 ${path}` };
      } else {
        await bridge.copyText(report.markdown);
        result = { ok: true, text: '已复制周报，可以直接粘贴到笔记或聊天里' };
      }
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      result = { ok: false, text: `没能${how === 'save' ? '保存' : '复制'}周报：${detail}` };
    }
    setOutcome(result);
    setBusy(null);
  };

  return (
    <section
      aria-labelledby="insights-weekly"
      className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="insights-weekly" className="text-sm font-semibold text-ink">
            每周回顾
          </h2>
          <p className="mt-0.5 text-2xs text-ink-subtle">
            {week ? `本周：${dayLabel(week.start)} 至 ${dayLabel(week.end)}` : '本周'}
          </p>
        </div>
        <label className="block text-xs text-ink-muted">
          每周目标
          <Select
            className="mt-1 w-32"
            value={String(goalDays)}
            onChange={(event) => updateSettings({ weeklyGoalDays: Number(event.target.value) })}
            options={GOAL_OPTIONS}
          />
        </label>
      </div>

      {week ? (
        <>
          <ol aria-label="本周每天的学习情况" className="mt-3 grid grid-cols-7 gap-1.5">
            {week.days.map((day) => {
              const text = describeWeekDay(day);
              return (
                <li key={day.date} title={text} className="flex flex-col items-center gap-1">
                  <span
                    aria-hidden="true"
                    className={classNames('text-2xs', day.today ? 'font-medium text-ink' : 'text-ink-subtle')}
                  >
                    {day.name}
                  </span>
                  <span
                    aria-hidden="true"
                    data-state={day.active ? 'done' : day.upcoming ? 'upcoming' : day.today ? 'today' : 'idle'}
                    className={classNames(
                      'flex h-7 w-7 items-center justify-center rounded-full border',
                      markerClass(day),
                    )}
                  >
                    {day.active ? <CheckIcon size={14} /> : null}
                  </span>
                  <span className="sr-only">{text}</span>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-ink-muted">
            {week.activeDays === 0 ? '本周还没有学习记录' : `本周学习了 ${week.activeDays} 天：${describeCounts(week)}`}
          </p>
          {progress ? (
            <div className="mt-3">
              <div
                role="progressbar"
                aria-label="本周目标进度"
                aria-valuemin={0}
                aria-valuemax={progress.goal}
                aria-valuenow={Math.min(progress.done, progress.goal)}
                aria-valuetext={`已学习 ${progress.done} 天，目标 ${progress.goal} 天`}
                className="h-1.5 overflow-hidden rounded-full bg-sunken"
              >
                <div
                  className={classNames('h-full rounded-full', progress.state === 'met' ? 'bg-positive' : 'bg-accent')}
                  style={{ width: `${Math.min(100, (progress.done / progress.goal) * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-ink-muted">{describeGoal(week, progress)}</p>
            </div>
          ) : (
            <p className="mt-3 text-2xs text-ink-subtle">
              选一个每周目标，查词、收藏或复习过，就算学习了一天。
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-subtle">没有读到本周每天的记录，所以这里没有统计。</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
        <span className="text-xs text-ink-muted">周报（Markdown）</span>
        <SegmentedControl
          label="周报范围"
          options={REPORT_WEEKS}
          value={reportWeek}
          onChange={(value) => {
            setReportWeek(value);
            setOutcome(null);
          }}
          className="w-32"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            icon={<DownloadIcon size={13} aria-hidden="true" />}
            loading={busy === 'save'}
            disabled={busy !== null}
            onClick={() => void exportReport('save')}
          >
            保存周报
          </Button>
          <Button
            size="sm"
            icon={<CopyIcon size={13} aria-hidden="true" />}
            loading={busy === 'copy'}
            disabled={busy !== null}
            onClick={() => void exportReport('copy')}
          >
            复制周报
          </Button>
        </div>
      </div>
      <p role="status" className={outcome?.ok ? 'mt-2 break-all text-xs text-positive' : 'sr-only'}>
        {outcome?.ok ? outcome.text : ''}
      </p>
      {outcome && !outcome.ok ? (
        <p role="alert" className="mt-2 break-all text-xs text-danger">
          {outcome.text}
        </p>
      ) : null}
    </section>
  );
}
