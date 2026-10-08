import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import { blankInsights, insightsFixture, reviewCalendarFixture } from '../lib/insights.fixture';
import * as bridge from '../lib/tauri-bridge';
import type { LearningInsights } from '../types/lexnote';
import { Insights } from './Insights';

vi.mock('../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn(),
  getSettings: vi.fn(),
  getTemplates: vi.fn(),
  getUsage: vi.fn(),
  getStartupWarnings: vi.fn(),
  saveSettings: vi.fn(),
  listenLookupDone: vi.fn(),
  listenLookupError: vi.fn(),
  listenLookupDelta: vi.fn(),
  getLearningInsights: vi.fn(),
  saveFileDialog: vi.fn(),
  copyText: vi.fn(),
}));

/** What the backend would answer next, by window length. */
let answer: (days: number) => LearningInsights;
let doneHandlers: Array<(event: never) => void>;

function lookupFinishedElsewhere() {
  act(() => {
    // The provider listens as well; it ignores events of requests it did not start.
    for (const handler of [...doneHandlers]) handler({ requestId: 'elsewhere' } as never);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/insights']}>
      <LexNoteProvider>
        <Routes>
          <Route path="/insights" element={<Insights />} />
          <Route path="/review" element={<p>回顾页</p>} />
          <Route path="/library" element={<p>生词库页</p>} />
        </Routes>
      </LexNoteProvider>
    </MemoryRouter>,
  );
}

const stat = (name: string) => within(screen.getByRole('group', { name }));
const card = (name: string) => within(screen.getByRole('region', { name }));

describe('the learning-insights page', () => {
  beforeEach(() => {
    answer = (days) => insightsFixture({ days });
    doneHandlers = [];
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
    } as never);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.listenLookupDone).mockImplementation(async (handler) => {
      doneHandlers.push(handler as (event: never) => void);
      return () => {
        doneHandlers = doneHandlers.filter((item) => item !== handler);
      };
    });
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    vi.mocked(bridge.getLearningInsights).mockImplementation(async (days) => answer(days));
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('asks for the last 30 days at first, and says that it is working until they arrive', async () => {
    renderPage();

    expect(screen.getByText('正在统计…')).toBeInTheDocument();
    await screen.findByRole('group', { name: '生词库' });
    expect(bridge.getLearningInsights).toHaveBeenCalledWith(30);
    expect(screen.queryByText('正在统计…')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '学习洞察' })).toHaveAttribute('href', '/insights');
    expect(screen.getByRole('link', { name: '学习洞察' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the library, the streak, what is due and the lookups at a glance', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    expect(stat('生词库').getByText('40')).toBeInTheDocument();
    // the last seven days, which is not the calendar week the weekly card is about
    expect(stat('生词库').getByText('近 7 天新增 2 个')).toBeInTheDocument();

    expect(stat('连续学习').getByText('4')).toBeInTheDocument();
    expect(stat('连续学习').getByText('最长连续 6 天')).toBeInTheDocument();

    expect(stat('今日待复习').getByText('5')).toBeInTheDocument();
    expect(stat('今日待复习').getByText('复习库共 38 张')).toBeInTheDocument();

    // 4 today, 1 two days ago and 2 three days ago
    expect(stat('近 30 天查词').getByText('7')).toBeInTheDocument();
    expect(stat('近 30 天查词').getByText('累计查词 156 次')).toBeInTheDocument();
  });

  it('shows this week day by day, with a goal to set, below the figures', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    const weekly = card('每周回顾');
    expect(weekly.getAllByRole('listitem')).toHaveLength(7);
    expect(weekly.getByText('本周学习了 3 天：查词 5 次，收藏 2 个，复习 3 张')).toBeInTheDocument();
    expect(weekly.getByLabelText('每周目标')).toHaveDisplayValue('不设目标');
    // reading the page takes one request; the report asks for its own, and only when it is asked for
    expect(bridge.getLearningInsights).toHaveBeenCalledTimes(1);
  });

  it('keeps the week the same whichever range is chosen, since the week is the calendar\u2019s', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    await userEvent.click(screen.getByRole('radio', { name: '7 天' }));
    await screen.findByRole('region', { name: '近 7 天的学习活动' });
    expect(card('每周回顾').getByText('本周学习了 3 天：查词 5 次，收藏 2 个，复习 3 张')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: '90 天' }));
    await screen.findByRole('region', { name: '近 90 天的学习活动' });
    expect(card('每周回顾').getByText('本周学习了 3 天：查词 5 次，收藏 2 个，复习 3 张')).toBeInTheDocument();
  });

  it('saves the report from the last 14 days, whatever range the page is showing', async () => {
    vi.mocked(bridge.saveFileDialog).mockResolvedValue('D:\\笔记\\周报.md');
    renderPage();
    await screen.findByRole('group', { name: '生词库' });
    await userEvent.click(screen.getByRole('radio', { name: '90 天' }));
    await screen.findByRole('region', { name: '近 90 天的学习活动' });

    await userEvent.click(screen.getByRole('button', { name: '保存周报' }));

    expect(await screen.findByText('已保存到 D:\\笔记\\周报.md')).toBeInTheDocument();
    expect(bridge.getLearningInsights).toHaveBeenLastCalledWith(14);
    expect(vi.mocked(bridge.saveFileDialog).mock.calls[0][0]).toBe('鸽鸽词典周报-2026-10-05.md');
    // the page itself still shows the range that was chosen
    expect(screen.getByRole('region', { name: '近 90 天的学习活动' })).toBeInTheDocument();
  });

  it('asks for something today when only the unfinished day keeps the streak alive', async () => {
    answer = (days) => {
      const base = insightsFixture({ days });
      const daily = base.daily.map((day, index) =>
        index === base.daily.length - 1 ? { ...day, lookups: 0, saved: 0, reviews: 0 } : day,
      );
      return { ...base, daily };
    };
    renderPage();

    expect(await screen.findByText('今天还没有学习，继续就不会断（最长 6 天）')).toBeInTheDocument();
  });

  it('draws a column for every day with that day\u2019s numbers, and the totals of the window', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    const chart = screen.getByRole('img', { name: '近 30 天：查词 7 次，收藏 2 个，复习 3 张' });
    expect(within(chart).getAllByTitle(/：/)).toHaveLength(30);
    expect(within(chart).getByTitle('10月7日 周三：查词 4 次，收藏 1 个')).toBeInTheDocument();
    expect(within(chart).getByTitle('10月6日 周二：收藏 1 个，复习 3 张')).toBeInTheDocument();
    expect(within(chart).getByTitle('10月3日 周六：没有记录')).toBeInTheDocument();

    // The busiest day fills the chart; what was done is stacked in it, lookups at the bottom.
    const today = within(chart).getByTitle('10月7日 周三：查词 4 次，收藏 1 个');
    const stack = today.firstElementChild as HTMLElement;
    expect(stack.style.height).toBe('100%');
    expect(Array.from(stack.children).map((part) => part.className)).toEqual(['bg-accent', 'bg-warn']);
    // A day without anything is only a line.
    expect((within(chart).getByTitle('10月3日 周六：没有记录').firstElementChild as HTMLElement).style.height).toBe('');

    const section = card('近 30 天的学习活动');
    expect(section.getByText('9月8日 周二')).toBeInTheDocument();
    expect(section.getByText('10月7日 周三')).toBeInTheDocument();
    expect(section.getByText('查词 7 次')).toBeInTheDocument();
    expect(section.getByText('收藏 2 个')).toBeInTheDocument();
    expect(section.getByText('复习 3 张')).toBeInTheDocument();
    expect(section.getByText('单日最多 5 项')).toBeInTheDocument();
  });

  it('shows how well the words are known, level by level', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    expect(
      screen.getByRole('img', { name: '新词 20 个，巩固中 10 个，熟悉 6 个，已掌握 4 个' }),
    ).toBeInTheDocument();
    const mastery = card('掌握程度');
    for (const [label, count, percent] of [
      ['新词', '20', '50%'],
      ['巩固中', '10', '25%'],
      ['熟悉', '6', '15%'],
      ['已掌握', '4', '10%'],
    ]) {
      const row = mastery.getByText(label).closest('li') as HTMLElement;
      expect(within(row).getByText(count)).toBeInTheDocument();
      expect(within(row).getByText(percent)).toBeInTheDocument();
    }
  });

  it('shows the share of right answers and where the cards are', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    const review = card('复习');
    expect(review.getByText('75%')).toBeInTheDocument();
    expect(review.getByText('答对 75 次，有点难 10 次，答错 15 次')).toBeInTheDocument();
    const boxes = within(review.getByRole('list', { name: '复习档位分布' })).getAllByRole('listitem');
    // the box, how many cards are in it, and when its cards come back, as one run of text
    expect(boxes.map((box) => box.textContent)).toEqual([
      '第 1 档20 张 · 1 天后再见',
      '第 2 档12 张 · 3 天后再见',
      '第 3 档6 张 · 7 天后再见',
    ]);
  });

  it('ranks the words that are looked up often, the ones that are missed, and where words come from', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    const often = card('常查的词');
    expect(often.getByText('ubiquitous')).toBeInTheDocument();
    expect(often.getByText('5 次')).toBeInTheDocument();
    expect(often.getByText('run')).toBeInTheDocument();
    expect(often.getByText('3 次')).toBeInTheDocument();

    const hard = card('易错的词');
    expect(hard.getByText('serendipity')).toBeInTheDocument();
    expect(hard.getByText('答错 4 次')).toBeInTheDocument();
    expect(hard.getByText('ephemeral')).toBeInTheDocument();
    expect(hard.getByText('答错 1 次 · 有点难 3 次')).toBeInTheDocument();

    const sources = card('生词来源');
    expect(sources.getByText('chrome.exe')).toBeInTheDocument();
    expect(sources.getByText('12 个词')).toBeInTheDocument();
    expect(sources.getByText('Kindle.exe')).toBeInTheDocument();
    expect(sources.getByText('4 个词')).toBeInTheDocument();
  });

  it('draws a calendar of the last twelve weeks, shaded by how many cards were answered each day', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    const calendar = screen.getByRole('img', { name: '近 12 周复习了 13 张，分布在 3 天' });
    // One square for each day, from the Monday of the first week up to today.
    expect(within(calendar).getAllByTitle(/：/)).toHaveLength(80);
    const busiest = within(calendar).getByTitle('10月1日 周四：复习 8 张（答对 5，有点难 2，答错 1）');
    expect(busiest).toHaveAttribute('data-level', '4');
    expect(within(calendar).getByTitle('10月6日 周二：复习 3 张（答对 2，有点难 1）')).toHaveAttribute('data-level', '2');
    expect(within(calendar).getByTitle('10月7日 周三：没有复习')).toHaveAttribute('data-level', '0');

    const section = card('近 12 周的复习日历');
    expect(section.getByText('7月20日 周一')).toBeInTheDocument();
    expect(section.getByText('10月7日 周三')).toBeInTheDocument();
    expect(section.getByText('单日最多 8 张')).toBeInTheDocument();
  });

  it('says that nothing was reviewed, rather than drawing a calendar that looks like data', async () => {
    answer = (days) => ({ ...insightsFixture({ days }), reviewCalendar: reviewCalendarFixture({}) });
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    expect(screen.getByRole('img', { name: '近 12 周没有复习' })).toBeInTheDocument();
    expect(card('近 12 周的复习日历').getByText('这段时间还没有复习')).toBeInTheDocument();
  });

  it('says so, rather than showing empty rankings as data, when there is nothing to rank yet', async () => {
    answer = (days) => ({
      ...insightsFixture({ days }),
      oftenLookedUp: [],
      hardWords: [],
      topSources: [],
      review: { dueToday: 0, total: 0, boxCounts: [0, 0, 0], correct: 0, hard: 0, wrong: 0 },
    });
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    expect(card('常查的词').getByText('还没有查过两次以上的词')).toBeInTheDocument();
    expect(card('易错的词').getByText('还没有答错或觉得难的词')).toBeInTheDocument();
    expect(card('生词来源').getByText('还没有记录下来源')).toBeInTheDocument();
    expect(card('复习').getByText('—')).toBeInTheDocument();
    expect(card('复习').getByText('还没有答题记录')).toBeInTheDocument();
    expect(card('复习').getByText(/还没有词加入复习/)).toBeInTheDocument();
  });

  it('leads to the review when cards are due, and offers nothing when none are', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    await userEvent.click(screen.getByRole('button', { name: '复习 5 个到期词' }));
    expect(await screen.findByText('回顾页')).toBeInTheDocument();

    cleanup();
    answer = (days) => ({
      ...insightsFixture({ days }),
      review: { dueToday: 0, total: 38, boxCounts: [20, 12, 6], correct: 75, hard: 0, wrong: 25 },
    });
    renderPage();
    await screen.findByRole('group', { name: '生词库' });
    expect(screen.queryByRole('button', { name: /到期词/ })).not.toBeInTheDocument();
  });

  it('shows another window when asked, and labels it with the days it covers', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    await userEvent.click(screen.getByRole('radio', { name: '7 天' }));

    expect(await screen.findByRole('region', { name: '近 7 天的学习活动' })).toBeInTheDocument();
    expect(bridge.getLearningInsights).toHaveBeenLastCalledWith(7);
    expect(within(screen.getByRole('img', { name: /^近 7 天：/ })).getAllByTitle(/：/)).toHaveLength(7);
    expect(screen.getByRole('group', { name: '近 7 天查词' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '7 天' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: '90 天' }));
    expect(await screen.findByRole('region', { name: '近 90 天的学习活动' })).toBeInTheDocument();
    expect(bridge.getLearningInsights).toHaveBeenLastCalledWith(90);
  });

  it('welcomes somebody who has not done anything yet instead of showing a page of zeros', async () => {
    answer = (days) => blankInsights(days);
    renderPage();

    expect(await screen.findByText('还没有学习记录')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '生词库' })).not.toBeInTheDocument();
    // The range can still be chosen; the page does not become a dead end.
    expect(screen.getByRole('radio', { name: '30 天' })).toBeInTheDocument();
  });

  it('says why nothing is shown when the figures cannot be read, and tries again on request', async () => {
    vi.mocked(bridge.getLearningInsights).mockReset();
    vi.mocked(bridge.getLearningInsights)
      .mockRejectedValueOnce('数据库被占用')
      .mockImplementation(async (days) => answer(days));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('读取学习洞察失败：数据库被占用');
    expect(screen.queryByText('正在统计…')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('group', { name: '生词库' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the last figures, and says they are old, when reading them again fails', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });

    vi.mocked(bridge.getLearningInsights).mockRejectedValueOnce('数据库被占用');
    fireEvent.focus(window);

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败，下面显示的是上一次读取的结果：数据库被占用');
    expect(stat('生词库').getByText('40')).toBeInTheDocument();
  });

  it('reads again when the user comes back, and when a lookup has finished', async () => {
    renderPage();
    await screen.findByRole('group', { name: '生词库' });
    expect(stat('生词库').getByText('40')).toBeInTheDocument();

    answer = (days) => insightsFixture({ days, totals: { words: 41, lookups: 160 } });
    fireEvent.focus(window);
    await waitFor(() => expect(stat('生词库').getByText('41')).toBeInTheDocument());

    answer = (days) => insightsFixture({ days, totals: { words: 42, lookups: 161 } });
    lookupFinishedElsewhere();
    await waitFor(() => expect(stat('生词库').getByText('42')).toBeInTheDocument());
  });

  it('never lets a slow read that was overtaken replace a newer one', async () => {
    let finishSlowRead: (value: LearningInsights) => void = () => undefined;
    const slowRead = new Promise<LearningInsights>((resolve) => {
      finishSlowRead = resolve;
    });
    vi.mocked(bridge.getLearningInsights).mockReset();
    vi.mocked(bridge.getLearningInsights)
      .mockImplementationOnce(() => slowRead) // the read when the page opens
      .mockImplementation(async (days) => answer(days));
    renderPage();
    await waitFor(() => expect(bridge.getLearningInsights).toHaveBeenCalledTimes(1));

    answer = (days) => insightsFixture({ days, totals: { words: 41, lookups: 160 } });
    fireEvent.focus(window); // a newer read, which finishes first
    await waitFor(() => expect(stat('生词库').getByText('41')).toBeInTheDocument());

    await act(async () => {
      finishSlowRead(insightsFixture({ totals: { words: 3, lookups: 3 } })); // what was true before
      await slowRead;
    });
    expect(stat('生词库').getByText('41')).toBeInTheDocument();
    expect(stat('生词库').queryByText('3')).not.toBeInTheDocument();
  });

  it('stops listening when it goes away', async () => {
    const view = renderPage();
    await screen.findByRole('group', { name: '生词库' });
    expect(doneHandlers.length).toBeGreaterThan(0);

    view.unmount();

    expect(doneHandlers).toHaveLength(0);
  });
});
