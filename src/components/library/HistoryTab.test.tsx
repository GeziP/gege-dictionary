import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import type { LookupHistoryItem, SavedWord } from '../../types/lexnote';
import { HistoryTab } from './HistoryTab';

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
  getLookupHistory: vi.fn(),
  deleteLookupHistory: vi.fn(),
  clearLookupHistory: vi.fn(),
  reopenLookupFromHistory: vi.fn(),
}));

// "Now" is 7 October 2026, 15:30 local time; entries are placed relative to it.
const at = (daysAgo: number, hour: number, minute = 0) =>
  new Date(2026, 9, 7 - daysAgo, hour, minute).toISOString();

const entry = (overrides: Partial<LookupHistoryItem> = {}): LookupHistoryItem => ({
  id: 1,
  selection: 'run',
  lemma: 'run',
  translation: '跑',
  kind: 'word',
  sourceApp: '',
  sourceTitle: '',
  count: 1,
  firstAt: at(0, 9),
  lastAt: at(0, 9),
  ...overrides,
});

const RUNNING = entry({
  id: 3,
  selection: 'running',
  lemma: 'run',
  translation: '奔跑',
  sourceApp: 'chrome.exe',
  sourceTitle: 'A Long Read',
  count: 3,
  firstAt: at(2, 10),
  lastAt: at(0, 14, 5),
});
const SERENDIPITY = entry({
  id: 2,
  selection: 'serendipity',
  lemma: 'serendipity',
  translation: '意外发现珍奇事物的运气',
  lastAt: at(0, 9, 30),
});
const SENTENCE = entry({
  id: 1,
  selection: 'Time flies like an arrow.',
  lemma: 'Time flies like an arrow.',
  translation: '光阴似箭。',
  kind: 'sentence',
  lastAt: at(1, 22, 10),
});

/** The backend, as far as the history is concerned. */
let stored: LookupHistoryItem[];
let doneHandlers: Array<(event: never) => void>;

function lookupFinishedElsewhere() {
  act(() => {
    // The provider listens as well; it ignores events of requests it did not start.
    for (const handler of [...doneHandlers]) handler({ requestId: 'elsewhere' } as never);
  });
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route
          path="/library"
          element={
            <LexNoteProvider>
              <HistoryTab />
            </LexNoteProvider>
          }
        />
        <Route path="/settings" element={<p>设置页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const row = (selection: string) => screen.getByRole('button', { name: `再次查看 ${selection}` });

describe('the lookup history tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 15, 30));

    stored = [RUNNING, SERENDIPITY, SENTENCE];
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
    vi.mocked(bridge.getLookupHistory).mockImplementation(async () => stored.map((item) => ({ ...item })));
    vi.mocked(bridge.deleteLookupHistory).mockImplementation(async (ids) => {
      const before = stored.length;
      stored = stored.filter((item) => !ids.includes(item.id));
      return before - stored.length;
    });
    vi.mocked(bridge.clearLookupHistory).mockImplementation(async () => {
      const removed = stored.length;
      stored = [];
      return removed;
    });
    vi.mocked(bridge.reopenLookupFromHistory).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('lists the lookups newest first, grouped by day, with how often and where', async () => {
    renderTab();

    expect(await screen.findByRole('heading', { name: /今天/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /昨天/ })).toBeInTheDocument();

    const today = within(screen.getByRole('region', { name: '今天' }));
    const names = today.getAllByRole('button', { name: /^再次查看/ }).map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['再次查看 running', '再次查看 serendipity']);
    expect(today.getByText('14:05')).toBeInTheDocument();
    expect(today.getByText('→ run')).toBeInTheDocument();
    expect(today.getByText('×3')).toBeInTheDocument();
    expect(today.getByText('chrome.exe · A Long Read')).toBeInTheDocument();

    const yesterday = within(screen.getByRole('region', { name: '昨天' }));
    expect(yesterday.getByText('句子')).toBeInTheDocument();
    expect(screen.getByText('共 3 条')).toBeInTheDocument();
  });

  it('marks the lookups that are already saved in the library', async () => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([
      { id: 'w', lemma: 'Run', kind: 'word' } as unknown as SavedWord,
    ]);
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    await waitFor(() => expect(within(row('running')).getByText('已收藏')).toBeInTheDocument());
    expect(within(row('serendipity')).queryByText('已收藏')).not.toBeInTheDocument();
  });

  it('opens the lookup again, exactly as it was asked, when a row is clicked', async () => {
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    await userEvent.click(row('serendipity'));

    expect(bridge.reopenLookupFromHistory).toHaveBeenCalledWith(2);
  });

  it('says so, and reads the list again, when the entry has meanwhile disappeared', async () => {
    vi.mocked(bridge.reopenLookupFromHistory).mockRejectedValue('这条历史记录已经不存在了');
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });
    const reads = vi.mocked(bridge.getLookupHistory).mock.calls.length;

    await userEvent.click(row('serendipity'));

    expect(await screen.findByRole('alert')).toHaveTextContent('这条历史记录已经不存在了');
    await waitFor(() => expect(vi.mocked(bridge.getLookupHistory).mock.calls.length).toBeGreaterThan(reads));
  });

  it('forgets a single entry and leaves the others', async () => {
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    await userEvent.click(screen.getByRole('button', { name: '删除「serendipity」的查词记录' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '再次查看 serendipity' })).not.toBeInTheDocument());
    expect(bridge.deleteLookupHistory).toHaveBeenCalledWith([2]);
    expect(row('running')).toBeInTheDocument();
    expect(row('Time flies like an arrow.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('共 2 条')).toBeInTheDocument());
  });

  it('keeps the entry and says why when forgetting it fails', async () => {
    vi.mocked(bridge.deleteLookupHistory).mockRejectedValue('数据库被占用');
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    await userEvent.click(screen.getByRole('button', { name: '删除「serendipity」的查词记录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败：数据库被占用');
    expect(row('serendipity')).toBeInTheDocument();
  });

  it('asks before forgetting everything, and does nothing when the answer is no', async () => {
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    await userEvent.click(screen.getByRole('button', { name: '清空历史' }));

    expect(ask).toHaveBeenCalledWith(expect.stringContaining('3 条'));
    expect(bridge.clearLookupHistory).not.toHaveBeenCalled();
    expect(row('running')).toBeInTheDocument();
  });

  it('forgets everything on confirmation, and says how much', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    await userEvent.click(screen.getByRole('button', { name: '清空历史' }));

    expect(await screen.findByText('已清空 3 条查词历史')).toBeInTheDocument();
    expect(screen.getByText(/还没有查词记录/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清空历史' })).toBeDisabled();
  });

  it('searches by text, translation and source, and says when nothing matches', async () => {
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });
    const search = screen.getByRole('textbox', { name: '搜索查词历史' });

    await userEvent.type(search, 'chrome');
    expect(screen.getByText('匹配 1 / 3 条')).toBeInTheDocument();
    expect(row('running')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '再次查看 serendipity' })).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, '光阴');
    expect(row('Time flies like an arrow.')).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(screen.getByText('没有匹配「zzz」的查词记录')).toBeInTheDocument();
  });

  it('shows a lookup that finishes in another window, and one that was made while away', async () => {
    renderTab();
    await screen.findByRole('heading', { name: /今天/ });

    stored = [entry({ id: 9, selection: 'ephemeral', lemma: 'ephemeral', translation: '短暂的', lastAt: at(0, 15, 20) }), ...stored];
    lookupFinishedElsewhere();
    expect(await screen.findByRole('button', { name: '再次查看 ephemeral' })).toBeInTheDocument();

    stored = [entry({ id: 10, selection: 'lucid', lemma: 'lucid', translation: '清晰的', lastAt: at(0, 15, 25) }), ...stored];
    fireEvent.focus(window);
    expect(await screen.findByRole('button', { name: '再次查看 lucid' })).toBeInTheDocument();
  });

  it('never lets a slow read that was overtaken replace a newer one', async () => {
    let finishSlowRead: (list: LookupHistoryItem[]) => void = () => undefined;
    const slowRead = new Promise<LookupHistoryItem[]>((resolve) => {
      finishSlowRead = resolve;
    });
    vi.mocked(bridge.getLookupHistory).mockReset();
    vi.mocked(bridge.getLookupHistory)
      .mockImplementationOnce(() => slowRead) // the read when the tab opens
      .mockImplementation(async () => stored.map((item) => ({ ...item })));
    renderTab();
    await waitFor(() => expect(bridge.getLookupHistory).toHaveBeenCalledTimes(1));

    stored = [SERENDIPITY];
    fireEvent.focus(window); // a newer read, which finishes first
    await screen.findByRole('button', { name: '再次查看 serendipity' });

    await act(async () => {
      finishSlowRead([SENTENCE]); // the old read comes back late with what was true before
      await slowRead;
    });
    expect(row('serendipity')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /再次查看 Time flies/ })).not.toBeInTheDocument();
  });

  it('explains an empty history', async () => {
    stored = [];
    renderTab();

    expect(await screen.findByText(/还没有查词记录。选中文字查词后/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清空历史' })).toBeDisabled();
  });

  it('says it could not read the history, and reads again on request', async () => {
    vi.mocked(bridge.getLookupHistory).mockReset();
    vi.mocked(bridge.getLookupHistory)
      .mockRejectedValueOnce('数据库被占用')
      .mockImplementation(async () => stored.map((item) => ({ ...item })));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('读取查词历史失败：数据库被占用');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('button', { name: '再次查看 running' })).toBeInTheDocument();
    expect(screen.queryByText(/读取查词历史失败/)).not.toBeInTheDocument();
  });

  it('tells the user when recording is off, keeps what is there, and leads to the setting', async () => {
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
      historyEnabled: false,
    } as never);
    renderTab();

    expect(await screen.findByText(/查词历史已关闭，新的查词不会被记录/)).toBeInTheDocument();
    expect(row('running')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '去设置开启' }));
    expect(await screen.findByText('设置页')).toBeInTheDocument();
  });

  it('stops listening when it goes away', async () => {
    const view = renderTab();
    await screen.findByRole('heading', { name: /今天/ });
    const listening = doneHandlers.length;
    expect(listening).toBeGreaterThan(0);

    view.unmount();

    expect(doneHandlers).toHaveLength(0);
  });
});
