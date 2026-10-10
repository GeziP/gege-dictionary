import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WeeklyCard } from '../components/insights/WeeklyCard';
import { WindowFrame } from '../components/shell/WindowFrame';
import { Button } from '../components/ui/Button';
import { MASTERY_META } from '../components/ui/MasteryBadge';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { useRefreshWhenActive } from '../hooks/useRefreshWhenActive';
import {
  accuracyPercent,
  busiestDay,
  busiestReviewDay,
  calendarWeeks,
  chartBars,
  dayLabel,
  describeAnswers,
  describeCalendar,
  describeCounts,
  describeDay,
  describeHardWord,
  describeReviewDay,
  hardWordWeight,
  isBlank,
  masterySegments,
  RANGES,
  rankShare,
  streakNote,
  type HeatLevel,
  type RangeDays,
} from '../lib/insights';
import * as bridge from '../lib/tauri-bridge';
import type { LearningInsights, Mastery, ReviewCalendar } from '../types/lexnote';
import { classNames } from '../utils/format';

const RANGE_OPTIONS = RANGES.map((days) => ({ value: String(days), label: `${days} 天` }));

/** What the chart's bars are made of, bottom to top, and how the legend names them. */
const SERIES = [
  { key: 'lookups', label: '查词', unit: '次', bar: 'bg-accent' },
  { key: 'saved', label: '收藏', unit: '个', bar: 'bg-warn' },
  { key: 'reviews', label: '复习', unit: '张', bar: 'bg-ink-subtle' },
] as const;

/** From not known to known, so the bar reads as progress from left to right. */
const MASTERY_BAR: Record<Mastery, string> = {
  new: 'bg-ink-subtle',
  learning: 'bg-warn',
  familiar: 'bg-accent',
  mastered: 'bg-positive',
};

/** The review boxes and when a card in each comes back (see `submit_review`). */
const BOXES = [
  { label: '第 1 档', hint: '1 天后再见' },
  { label: '第 2 档', hint: '3 天后再见' },
  { label: '第 3 档', hint: '7 天后再见' },
];

/** From no cards answered to the busiest day, so that the calendar reads as more from left to right. */
const HEAT: Record<HeatLevel, string> = {
  0: 'bg-sunken',
  1: 'bg-accent/25',
  2: 'bg-accent/50',
  3: 'bg-accent/75',
  4: 'bg-accent',
};
const HEAT_LEVELS: HeatLevel[] = [0, 1, 2, 3, 4];
/** Monday to Sunday; only some days are named, which is enough to find the others. */
const WEEKDAYS = ['一', '', '三', '', '五', '', '日'];

export function Insights() {
  const [days, setDays] = useState<RangeDays>(30);
  const [data, setData] = useState<LearningInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reads overlap (the range changes, the window gets focus, a lookup finishes) and may come
  // back out of order: only the read that started last may be shown, since it also saw
  // everything that happened before it started.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await bridge.getLearningInsights(days);
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (reason) {
      if (mine !== generation.current) return;
      setError(String(reason));
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);
  useRefreshWhenActive(load);

  return (
    <WindowFrame title="学习洞察">
      <div className="thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5">
        <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-ink">学习洞察</h1>
              <p className="mt-0.5 text-xs text-ink-subtle">
                根据你的查词、收藏和复习记录统计，数据只保存在这台电脑上。
              </p>
            </div>
            <SegmentedControl
              label="统计范围"
              options={RANGE_OPTIONS}
              value={String(days)}
              onChange={(value) => setDays(Number(value) as RangeDays)}
              className="w-52"
            />
          </header>

          {error ? (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger"
            >
              <span className="min-w-0 flex-1">
                {data ? '刷新失败，下面显示的是上一次读取的结果：' : '读取学习洞察失败：'}
                {error}
              </span>
              <Button size="sm" onClick={() => void load()}>
                重试
              </Button>
            </div>
          ) : null}

          {data === null && !error ? (
            <p className="py-20 text-center text-sm text-ink-subtle">正在统计…</p>
          ) : null}

          {data && isBlank(data) ? <Blank /> : null}
          {data && !isBlank(data) ? <Report data={data} /> : null}
        </div>
      </div>
    </WindowFrame>
  );
}

function Blank() {
  return (
    <div className="rounded-xl border border-line bg-surface px-8 py-14 text-center shadow-panel">
      <h2 className="text-base font-semibold text-ink">还没有学习记录</h2>
      <p className="mt-2 text-sm text-ink-muted">
        选中文字查几个词、把生词收藏起来、做几次今日回顾，这里就会出现你的学习曲线、连续天数和掌握程度。
      </p>
    </div>
  );
}

function Report({ data }: { data: LearningInsights }) {
  const navigate = useNavigate();
  const { totals, review, window: sums, streak } = data;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="生词库" value={totals.words} unit="个" note={`近 7 天新增 ${data.savedThisWeek} 个`} />
        <Stat label="连续学习" value={streak.current} unit="天" note={streakNote(data)} />
        <Stat label="今日待复习" value={review.dueToday} unit="张" note={`复习库共 ${review.total} 张`} />
        <Stat
          label={`近 ${data.days} 天查词`}
          value={sums.lookups}
          unit="次"
          note={`累计查词 ${totals.lookups} 次`}
        />
      </div>

      <WeeklyCard data={data} />

      <ActivityCard data={data} />

      <div className="grid gap-4 md:grid-cols-2">
        <MasteryCard data={data} />
        <ReviewCard data={data} onReview={() => navigate('/review')} />
      </div>

      <ReviewCalendarCard calendar={data.reviewCalendar} />

      <div className="grid gap-4 md:grid-cols-3">
        <RankingCard
          title="常查的词"
          id="insights-often"
          empty="还没有查过两次以上的词"
          bar="bg-accent"
          rows={data.oftenLookedUp.map((item) => ({ name: item.lemma, value: item.count, text: `${item.count} 次` }))}
        />
        <RankingCard
          title="易错的词"
          id="insights-hard"
          empty="还没有答错或觉得难的词"
          bar="bg-danger"
          rows={data.hardWords.map((item) => ({
            name: item.lemma,
            value: hardWordWeight(item),
            text: describeHardWord(item),
          }))}
        />
        <RankingCard
          title="生词来源"
          id="insights-sources"
          empty="还没有记录下来源"
          bar="bg-warn"
          rows={data.topSources.map((item) => ({ name: item.source, value: item.count, text: `${item.count} 个词` }))}
        />
      </div>
    </>
  );
}

function Stat({ label, value, unit, note }: { label: string; value: number; unit: string; note: string }) {
  return (
    <div role="group" aria-label={label} className="rounded-xl border border-line bg-surface p-4 shadow-panel">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink">
        {value}
        <span className="ml-1 text-xs font-normal text-ink-subtle">{unit}</span>
      </p>
      <p className="mt-1 text-2xs text-ink-subtle">{note}</p>
    </div>
  );
}

function Card({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-panel">
      <h2 id={id} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ActivityCard({ data }: { data: LearningInsights }) {
  const bars = useMemo(() => chartBars(data.daily), [data.daily]);
  const busiest = busiestDay(data.daily);
  const first = data.daily[0];
  const last = data.daily[data.daily.length - 1];

  return (
    <Card title={`近 ${data.days} 天的学习活动`} id="insights-activity">
      <div
        role="img"
        aria-label={`近 ${data.days} 天：${describeCounts(data.window)}`}
        className="flex h-28 items-end gap-px"
      >
        {bars.map(({ day, height }) => (
          <div
            key={day.date}
            title={describeDay(day)}
            className="flex h-full min-w-0 flex-1 items-end rounded-sm hover:bg-sunken"
          >
            {height > 0 ? (
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${height * 100}%` }}>
                {SERIES.map(({ key, bar }) =>
                  day[key] > 0 ? <div key={key} className={bar} style={{ flex: `${day[key]} 1 0%` }} /> : null,
                )}
              </div>
            ) : (
              <div className="h-0.5 w-full bg-line" />
            )}
          </div>
        ))}
      </div>
      {first && last ? (
        <div className="mt-1 flex justify-between text-2xs text-ink-subtle">
          <span>{dayLabel(first.date)}</span>
          <span>{dayLabel(last.date)}</span>
        </div>
      ) : null}
      <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-muted">
        {SERIES.map(({ key, label, unit, bar }) => (
          <li key={key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={classNames('h-2 w-2 rounded-sm', bar)} />
            {label} {data.window[key]} {unit}
          </li>
        ))}
        {busiest > 0 ? <li className="ml-auto text-ink-subtle">单日最多 {busiest} 项</li> : null}
      </ul>
    </Card>
  );
}

function MasteryCard({ data }: { data: LearningInsights }) {
  const segments = masterySegments(data.mastery);
  const summary = segments.map((segment) => `${MASTERY_META[segment.level].label} ${segment.count} 个`).join('，');

  return (
    <Card title="掌握程度" id="insights-mastery">
      {data.totals.words === 0 ? (
        <p className="py-6 text-center text-xs text-ink-subtle">生词库还是空的</p>
      ) : (
        <>
          <div role="img" aria-label={summary} className="flex h-3 overflow-hidden rounded-full bg-sunken">
            {segments
              .filter((segment) => segment.count > 0)
              .map((segment) => (
                <div
                  key={segment.level}
                  className={MASTERY_BAR[segment.level]}
                  style={{ width: `${segment.share * 100}%` }}
                />
              ))}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {segments.map((segment) => (
              <li key={segment.level} className="flex items-center gap-1.5 text-ink-muted">
                <span aria-hidden="true" className={classNames('h-2 w-2 shrink-0 rounded-sm', MASTERY_BAR[segment.level])} />
                <span>{MASTERY_META[segment.level].label}</span>
                <span className="ml-auto font-medium text-ink">{segment.count}</span>
                <span className="w-9 text-right text-ink-subtle">{segment.percent}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function ReviewCard({ data, onReview }: { data: LearningInsights; onReview: () => void }) {
  const { review } = data;
  const accuracy = accuracyPercent(review.correct, review.wrong, review.hard);
  const largest = Math.max(...review.boxCounts);

  return (
    <Card title="复习" id="insights-review">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-ink-subtle">答对率</p>
          <p className="mt-0.5 text-2xl font-bold text-ink">{accuracy === null ? '—' : `${accuracy}%`}</p>
          <p className="mt-0.5 text-2xs text-ink-subtle">
            {accuracy === null ? '还没有答题记录' : describeAnswers(review)}
          </p>
        </div>
        {review.dueToday > 0 ? (
          <Button size="sm" variant="primary" onClick={onReview}>
            复习 {review.dueToday} 个到期词
          </Button>
        ) : null}
      </div>
      {review.total === 0 ? (
        <p className="mt-4 text-xs text-ink-subtle">还没有词加入复习，收藏的生词会从第二天起出现在今日回顾里。</p>
      ) : (
        <ul aria-label="复习档位分布" className="mt-4 space-y-2">
          {BOXES.map((box, index) => (
            <li key={box.label} className="flex items-center gap-2 text-xs">
              <span className="w-11 shrink-0 text-ink-muted">{box.label}</span>
              <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${rankShare(review.boxCounts[index], largest)}%` }}
                />
              </span>
              <span className="w-28 shrink-0 text-right text-ink-subtle">
                <span className="font-medium text-ink">{review.boxCounts[index]}</span> 张 · {box.hint}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReviewCalendarCard({ calendar }: { calendar: ReviewCalendar }) {
  const weeks = useMemo(() => calendarWeeks(calendar), [calendar]);
  const busiest = busiestReviewDay(calendar.days);
  const first = calendar.days[0];
  const last = calendar.days[calendar.days.length - 1];

  return (
    <Card title={`近 ${calendar.weeks} 周的复习日历`} id="insights-calendar">
      <div className="flex gap-2">
        <div aria-hidden="true" className="flex shrink-0 flex-col gap-[3px] text-2xs text-ink-subtle">
          {WEEKDAYS.map((name, index) => (
            <span key={index} className="flex h-[18px] items-center">
              {name}
            </span>
          ))}
        </div>
        <div role="img" aria-label={describeCalendar(calendar)} className="flex min-w-0 flex-1 gap-[3px]">
          {weeks.map((week) => (
            <div key={week[0].day.date} className="flex min-w-0 flex-1 flex-col gap-[3px]">
              {week.map(({ day, level }) => (
                <div
                  key={day.date}
                  title={describeReviewDay(day)}
                  data-level={level}
                  className={classNames('h-[18px] rounded-sm', HEAT[level])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {first && last ? (
        <div className="mt-1 flex justify-between pl-5 text-2xs text-ink-subtle">
          <span>{dayLabel(first.date)}</span>
          <span>{dayLabel(last.date)}</span>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span aria-hidden="true" className="flex items-center gap-1">
          少
          {HEAT_LEVELS.map((level) => (
            <span key={level} className={classNames('h-2.5 w-2.5 rounded-sm', HEAT[level])} />
          ))}
          多
        </span>
        <span className="ml-auto text-ink-subtle">
          {busiest > 0 ? `单日最多 ${busiest} 张` : '这段时间还没有复习'}
        </span>
      </div>
    </Card>
  );
}

interface RankingRow {
  name: string;
  value: number;
  text: string;
}

function RankingCard({
  title,
  id,
  rows,
  empty,
  bar,
}: {
  title: string;
  id: string;
  rows: RankingRow[];
  empty: string;
  bar: string;
}) {
  const largest = Math.max(0, ...rows.map((row) => row.value));

  return (
    <Card title={title} id={id}>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-subtle">{empty}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((row) => (
            <li key={row.name}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span title={row.name} className="min-w-0 truncate font-medium text-ink">
                  {row.name}
                </span>
                <span className="shrink-0 text-ink-subtle">{row.text}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
                <div className={classNames('h-full rounded-full', bar)} style={{ width: `${rankShare(row.value, largest)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
