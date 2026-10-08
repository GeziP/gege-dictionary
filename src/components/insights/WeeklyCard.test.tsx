import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../../contexts/LexNoteContext';
import { insightsFixture } from '../../lib/insights.fixture';
import * as bridge from '../../lib/tauri-bridge';
import type { LearningInsights } from '../../types/lexnote';
import { WeeklyCard } from './WeeklyCard';

vi.mock('../../lib/tauri-bridge', () => ({
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

const MAIN = { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '••••••••' };

function stubSettings(settings: Record<string, unknown>) {
  vi.mocked(bridge.getSettings).mockResolvedValue({ provider: MAIN, ...settings } as never);
}

/** What the page has: 30 days up to Wednesday 7 October, of which Monday to Wednesday are this week. */
function renderCard(data: LearningInsights = insightsFixture({ days: 30 })) {
  return render(
    <LexNoteProvider>
      <WeeklyCard data={data} />
    </LexNoteProvider>,
  );
}

const goal = () => screen.getByLabelText('每周目标') as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: '保存周报' });
const copyButton = () => screen.getByRole('button', { name: '复制周报' });
const status = () => screen.getByRole('status');
const days = () => within(screen.getByRole('list', { name: '本周每天的学习情况' })).getAllByRole('listitem');

/** A promise that is settled when the test says so, standing in for a slow request. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('the weekly card of the insights page', () => {
  beforeEach(() => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.listenLookupDone).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    vi.mocked(bridge.getLearningInsights).mockResolvedValue(insightsFixture({ days: 14 }));
    vi.mocked(bridge.saveFileDialog).mockResolvedValue('C:\\笔记\\周报.md');
    vi.mocked(bridge.copyText).mockResolvedValue(undefined);
    stubSettings({});
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  describe('the week', () => {
    it('shows the days from Monday to Sunday, with what happened on each', () => {
      renderCard();

      expect(screen.getByRole('region', { name: '每周回顾' })).toBeInTheDocument();
      expect(screen.getByText('本周：10月5日 周一 至 10月11日 周日')).toBeInTheDocument();
      expect(days().map((day) => day.getAttribute('title'))).toEqual([
        '10月5日 周一：查词 1 次',
        '10月6日 周二：收藏 1 个，复习 3 张',
        '10月7日 周三（今天）：查词 4 次，收藏 1 个',
        '10月8日 周四：还没到',
        '10月9日 周五：还没到',
        '10月10日 周六：还没到',
        '10月11日 周日：还没到',
      ]);
      // screen readers get the same words as the tooltip
      expect(within(days()[2]).getByText('10月7日 周三（今天）：查词 4 次，收藏 1 个')).toBeInTheDocument();
      expect(screen.getByText('本周学习了 3 天：查词 5 次，收藏 2 个，复习 3 张')).toBeInTheDocument();
    });

    it('tells apart a day that was done, one that was not, today when it is still to do, and the days to come', () => {
      const data = insightsFixture({ days: 30 });
      const quiet = {
        ...data,
        daily: data.daily.map((day) =>
          day.date === '2026-10-06' || day.date === '2026-10-07' ? { ...day, lookups: 0, saved: 0, reviews: 0 } : day,
        ),
      };
      renderCard(quiet);

      expect(days().map((day) => day.querySelector('[data-state]')?.getAttribute('data-state'))).toEqual([
        'done',
        'idle',
        'today',
        'upcoming',
        'upcoming',
        'upcoming',
        'upcoming',
      ]);
      expect(days()[1]).toHaveAttribute('title', '10月6日 周二：没有记录');
      expect(screen.getByText('本周学习了 1 天：查词 1 次')).toBeInTheDocument();
    });

    it('says that nothing has been done, rather than a sentence of zeros', () => {
      const data = insightsFixture({ days: 30 });
      renderCard({ ...data, daily: data.daily.map((day) => ({ ...day, lookups: 0, saved: 0, reviews: 0 })) });

      expect(screen.getByText('本周还没有学习记录')).toBeInTheDocument();
      expect(days().map((day) => day.querySelector('[data-state]')?.getAttribute('data-state'))).toEqual([
        'idle',
        'idle',
        'today',
        'upcoming',
        'upcoming',
        'upcoming',
        'upcoming',
      ]);
    });

    it('says that the week cannot be told when the figures do not reach back to its Monday, and still offers the report', () => {
      renderCard(insightsFixture({ days: 30, daily: [] }));

      expect(screen.getByText('没有读到本周每天的记录，所以这里没有统计。')).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: '本周每天的学习情况' })).not.toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
    });

    it('is made of a window of seven days as well, which is the shortest the page offers', () => {
      renderCard(insightsFixture({ days: 7 }));

      expect(days()).toHaveLength(7);
      expect(screen.getByText('本周学习了 3 天：查词 5 次，收藏 2 个，复习 3 张')).toBeInTheDocument();
    });
  });

  describe('the goal', () => {
    it('is not set at first, and the card says what counts as a day instead of showing an empty bar', () => {
      renderCard();

      expect(goal()).toHaveDisplayValue('不设目标');
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByText('选一个每周目标，查词、收藏或复习过，就算学习了一天。')).toBeInTheDocument();
    });

    it('can be no goal, one to six days a week, or every day', () => {
      renderCard();

      expect(Array.from(goal().options).map((option) => option.text)).toEqual([
        '不设目标',
        '每周 1 天',
        '每周 2 天',
        '每周 3 天',
        '每周 4 天',
        '每周 5 天',
        '每周 6 天',
        '每天',
      ]);
    });

    it('is saved when it is chosen, and the week is held up against it', async () => {
      renderCard();

      await userEvent.selectOptions(goal(), '每周 5 天');

      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ weeklyGoalDays: 5 })),
      );
      expect(goal()).toHaveDisplayValue('每周 5 天');
      const bar = screen.getByRole('progressbar', { name: '本周目标进度' });
      expect(bar).toHaveAttribute('aria-valuenow', '3');
      expect(bar).toHaveAttribute('aria-valuemax', '5');
      expect(bar).toHaveAttribute('aria-valuetext', '已学习 3 天，目标 5 天');
      expect((bar.firstElementChild as HTMLElement).style.width).toBe('60%');
      expect(screen.getByText('每周目标 5 天，已学习 3 天，还差 2 天，本周还有 4 天可以学')).toBeInTheDocument();
      expect(screen.queryByText(/选一个每周目标/)).not.toBeInTheDocument();
    });

    it('is saved as no goal again when the choice is taken back', async () => {
      stubSettings({ weeklyGoalDays: 4 });
      renderCard();
      await waitFor(() => expect(goal()).toHaveDisplayValue('每周 4 天'));

      await userEvent.selectOptions(goal(), '不设目标');

      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ weeklyGoalDays: 0 })),
      );
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('is shown as met, and the bar full, once the days were done', async () => {
      stubSettings({ weeklyGoalDays: 3 });
      renderCard();

      await waitFor(() => expect(goal()).toHaveDisplayValue('每周 3 天'));
      expect(screen.getByText('每周目标 3 天，已达成（学习了 3 天）')).toBeInTheDocument();
      const bar = screen.getByRole('progressbar', { name: '本周目标进度' });
      expect(bar).toHaveAttribute('aria-valuenow', '3');
      expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
      expect(bar.firstElementChild).toHaveClass('bg-positive');
    });

    it('never overfills the bar, however many days were done', async () => {
      stubSettings({ weeklyGoalDays: 1 });
      renderCard();

      await waitFor(() => expect(goal()).toHaveDisplayValue('每周 1 天'));
      const bar = screen.getByRole('progressbar', { name: '本周目标进度' });
      expect(bar).toHaveAttribute('aria-valuenow', '1');
      expect(bar).toHaveAttribute('aria-valuemax', '1');
      expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
    });

    it('is shown as out of reach when the days that are left are fewer than the days that are missing', async () => {
      const data = insightsFixture({ days: 30 });
      // Only Monday was done: on Wednesday, 7 October, five days are left, one short of what every day needs.
      const lonely = {
        ...data,
        daily: data.daily.map((day) =>
          day.date >= '2026-10-06' ? { ...day, lookups: 0, saved: 0, reviews: 0 } : day,
        ),
      };
      stubSettings({ weeklyGoalDays: 7 });
      renderCard(lonely);

      await waitFor(() => expect(goal()).toHaveDisplayValue('每天'));
      expect(screen.getByText('每周目标 7 天，已学习 1 天，剩下的日子不够补到 7 天了，下周再来')).toBeInTheDocument();
      expect(screen.getByRole('progressbar', { name: '本周目标进度' })).toHaveAttribute('aria-valuenow', '1');
    });
  });

  describe('the report', () => {
    it('is made of fresh figures, whatever the page is showing, and saved under the Monday it starts on', async () => {
      renderCard();

      await userEvent.click(saveButton());

      expect(await screen.findByText('已保存到 C:\\笔记\\周报.md')).toBeInTheDocument();
      expect(bridge.getLearningInsights).toHaveBeenCalledTimes(1);
      expect(bridge.getLearningInsights).toHaveBeenCalledWith(14);
      expect(bridge.saveFileDialog).toHaveBeenCalledTimes(1);
      const [fileName, markdown, filterName, extensions] = vi.mocked(bridge.saveFileDialog).mock.calls[0];
      expect(fileName).toBe('鸽鸽词典周报-2026-10-05.md');
      expect(markdown).toContain('# 鸽鸽词典周报');
      expect(markdown).toContain('2026-10-05（周一）至 2026-10-11（周日） · 本周，数据截至 2026-10-07（周三）');
      expect(markdown).toContain('- 查词 5 次，收藏 2 个，复习 3 张');
      expect([filterName, extensions]).toEqual(['Markdown', ['md']]);
      expect(status()).toHaveTextContent('已保存到 C:\\笔记\\周报.md');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(bridge.copyText).not.toHaveBeenCalled();
    });

    it('holds the week up against the goal that is set', async () => {
      stubSettings({ weeklyGoalDays: 3 });
      renderCard();
      await waitFor(() => expect(goal()).toHaveDisplayValue('每周 3 天'));

      await userEvent.click(saveButton());

      await waitFor(() => expect(bridge.saveFileDialog).toHaveBeenCalled());
      expect(vi.mocked(bridge.saveFileDialog).mock.calls[0][1]).toContain('- 每周目标 3 天，已达成（学习了 3 天）');
    });

    it('is the one of last week when that is chosen', async () => {
      renderCard();

      await userEvent.click(screen.getByRole('radio', { name: '上周' }));
      expect(screen.getByRole('radio', { name: '上周' })).toHaveAttribute('aria-checked', 'true');
      await userEvent.click(saveButton());

      await waitFor(() => expect(bridge.saveFileDialog).toHaveBeenCalled());
      const [fileName, markdown] = vi.mocked(bridge.saveFileDialog).mock.calls[0];
      expect(fileName).toBe('鸽鸽词典周报-2026-09-28.md');
      expect(markdown).toContain('2026-09-28（周一）至 2026-10-04（周日） · 上周');
      expect(markdown).not.toContain('数据截至');
    });

    it('is the one of this week at first', () => {
      renderCard();

      expect(screen.getByRole('radio', { name: '本周' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: '上周' })).toHaveAttribute('aria-checked', 'false');
    });

    it('says nothing when the dialog was closed without saving, and can be saved again', async () => {
      vi.mocked(bridge.saveFileDialog).mockResolvedValueOnce(null);
      renderCard();

      await userEvent.click(saveButton());

      await waitFor(() => expect(bridge.saveFileDialog).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(saveButton()).toBeEnabled());
      expect(status()).toBeEmptyDOMElement();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await userEvent.click(saveButton());
      expect(await screen.findByText('已保存到 C:\\笔记\\周报.md')).toBeInTheDocument();
    });

    it('can be copied instead, without a dialog', async () => {
      renderCard();

      await userEvent.click(copyButton());

      expect(await screen.findByText('已复制周报，可以直接粘贴到笔记或聊天里')).toBeInTheDocument();
      expect(bridge.copyText).toHaveBeenCalledTimes(1);
      expect(vi.mocked(bridge.copyText).mock.calls[0][0]).toContain('# 鸽鸽词典周报');
      expect(bridge.saveFileDialog).not.toHaveBeenCalled();
    });

    it('says why it could not be saved, with the reason the system gave', async () => {
      vi.mocked(bridge.saveFileDialog).mockRejectedValueOnce('磁盘已满');
      renderCard();

      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('没能保存周报：磁盘已满');
      expect(status()).toBeEmptyDOMElement();
      await waitFor(() => expect(saveButton()).toBeEnabled());
    });

    it('says why it could not be copied', async () => {
      vi.mocked(bridge.copyText).mockRejectedValueOnce(new Error('剪贴板被占用'));
      renderCard();

      await userEvent.click(copyButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('没能复制周报：剪贴板被占用');
    });

    it('is not made when the figures cannot be read, and says why', async () => {
      vi.mocked(bridge.getLearningInsights).mockRejectedValueOnce('数据库被占用');
      renderCard();

      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('没能保存周报：数据库被占用');
      expect(bridge.saveFileDialog).not.toHaveBeenCalled();
    });

    it('is not made of figures that miss a day of the week, and says so', async () => {
      vi.mocked(bridge.getLearningInsights).mockResolvedValue(insightsFixture({ days: 7 }));
      renderCard();

      await userEvent.click(screen.getByRole('radio', { name: '上周' }));
      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('没能保存周报：读到的记录没有覆盖这一周');
      expect(bridge.saveFileDialog).not.toHaveBeenCalled();
    });

    it('cannot be asked for twice while it is being made', async () => {
      const figures = deferred<LearningInsights>();
      vi.mocked(bridge.getLearningInsights).mockReturnValueOnce(figures.promise);
      renderCard();

      await userEvent.click(saveButton());

      expect(saveButton()).toBeDisabled();
      expect(saveButton()).toHaveAttribute('aria-busy', 'true');
      expect(copyButton()).toBeDisabled();
      await userEvent.click(copyButton());
      expect(bridge.getLearningInsights).toHaveBeenCalledTimes(1);

      figures.resolve(insightsFixture({ days: 14 }));
      expect(await screen.findByText('已保存到 C:\\笔记\\周报.md')).toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
      expect(copyButton()).toBeEnabled();
      expect(bridge.copyText).not.toHaveBeenCalled();
    });

    it('forgets what happened the last time when the other week is chosen', async () => {
      renderCard();
      await userEvent.click(saveButton());
      expect(await screen.findByText('已保存到 C:\\笔记\\周报.md')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('radio', { name: '上周' }));

      expect(status()).toBeEmptyDOMElement();
    });
  });
});
