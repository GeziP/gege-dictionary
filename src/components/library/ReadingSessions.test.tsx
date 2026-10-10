import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../../lib/tauri-bridge';
import type { ReadingSession, SavedWord } from '../../types/lexnote';
import { ReadingSessions } from './ReadingSessions';

const context = vi.hoisted(() => ({
  settings: { sessionGapMinutes: 30 },
  refreshWords: vi.fn(),
}));

vi.mock('../../contexts/LexNoteContext', () => ({
  useLexNote: () => context,
}));

vi.mock('../../lib/tauri-bridge', () => ({
  getReadingSessions: vi.fn(),
  getSessionWords: vi.fn(),
  tagSession: vi.fn(),
  exportWordsData: vi.fn(),
  saveFileDialog: vi.fn(),
  addSessionToReview: vi.fn(),
}));

const session = (overrides: Partial<ReadingSession> = {}): ReadingSession => ({
  id: 's1',
  sourceApp: 'Chrome',
  sourceTitle: 'The Economist',
  startAt: '2026-03-02T09:00:00.000Z',
  endAt: '2026-03-02T09:20:00.000Z',
  wordCount: 2,
  preview: ['alpha', 'beta'],
  wordIds: ['w1', 'w2'],
  ...overrides,
});

const word = (lemma: string, translation: string) => ({ id: lemma, lemma, translation }) as unknown as SavedWord;

async function openSession(name: RegExp | string = /The Economist/) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('the reading sessions page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    context.settings = { sessionGapMinutes: 30 };
    vi.mocked(bridge.getReadingSessions).mockResolvedValue([session()]);
    vi.mocked(bridge.getSessionWords).mockResolvedValue([word('alpha', '第一'), word('beta', '第二')]);
    vi.mocked(bridge.tagSession).mockResolvedValue(2);
    vi.mocked(bridge.exportWordsData).mockResolvedValue('# alpha\n# beta');
    vi.mocked(bridge.saveFileDialog).mockResolvedValue('C:\\notes\\session.md');
    vi.mocked(bridge.addSessionToReview).mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
  });

  describe('listing', () => {
    it('shows what each session was read in, and the words it was about', async () => {
      render(<ReadingSessions />);

      expect(await screen.findByText('The Economist')).toBeInTheDocument();
      expect(screen.getByText('alpha · beta')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /The Economist/ })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText(/相邻查词间隔 30 分钟内自动聚合/)).toBeInTheDocument();
    });

    it('falls back on the app, and on a placeholder, when a session has no title', async () => {
      vi.mocked(bridge.getReadingSessions).mockResolvedValue([
        session({ id: 'a', sourceTitle: '', sourceApp: 'Notepad' }),
        session({ id: 'b', sourceTitle: '', sourceApp: '' }),
      ]);
      render(<ReadingSessions />);

      const [first, second] = await screen.findAllByRole('article');
      expect(first).toHaveTextContent('Notepad');
      expect(second).toHaveTextContent('未知阅读来源');
    });

    it('narrows the list down to one source app', async () => {
      vi.mocked(bridge.getReadingSessions).mockResolvedValue([
        session({ id: 'a', sourceTitle: 'Article', sourceApp: 'Chrome' }),
        session({ id: 'b', sourceTitle: 'Report', sourceApp: 'Word' }),
      ]);
      render(<ReadingSessions />);
      await screen.findByText('Article');

      await userEvent.selectOptions(screen.getByLabelText('按来源应用筛选'), 'Word');

      expect(screen.queryByText('Article')).not.toBeInTheDocument();
      expect(screen.getByText('Report')).toBeInTheDocument();
    });

    it('asks for the next page when the last one was full, and stops asking when it was not', async () => {
      const firstPage = Array.from({ length: 50 }, (_, index) => session({ id: `s${index}`, sourceTitle: `Source ${index}` }));
      vi.mocked(bridge.getReadingSessions)
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([session({ id: 'last', sourceTitle: 'The last one' })]);
      render(<ReadingSessions />);

      await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));

      expect(await screen.findByText('The last one')).toBeInTheDocument();
      expect(bridge.getReadingSessions).toHaveBeenLastCalledWith(30, 50, 50);
      expect(screen.getByText('Source 0')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    });

    it('says so when the next page could not be had, and keeps what it has', async () => {
      const firstPage = Array.from({ length: 50 }, (_, index) => session({ id: `s${index}`, sourceTitle: `Source ${index}` }));
      vi.mocked(bridge.getReadingSessions).mockResolvedValueOnce(firstPage).mockRejectedValueOnce(new Error('timeout'));
      render(<ReadingSessions />);

      await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('加载更多会话失败：timeout');
      expect(screen.getByText('Source 0')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '加载更多' })).toBeInTheDocument();
    });
  });

  describe('when there is nothing to list', () => {
    it('explains what a session is, once it is known that there are none', async () => {
      vi.mocked(bridge.getReadingSessions).mockResolvedValue([]);
      render(<ReadingSessions />);

      expect(
        await screen.findByText('还没有阅读会话。连续查词（相邻两次不超过 30 分钟）会自动归为一个会话。'),
      ).toBeInTheDocument();
    });

    it('does not say there are none while they are still being read', () => {
      vi.mocked(bridge.getReadingSessions).mockReturnValue(new Promise<ReadingSession[]>(() => undefined));
      render(<ReadingSessions />);

      expect(screen.queryByText(/还没有阅读会话/)).not.toBeInTheDocument();
    });

    it('says what went wrong, and not that there are none, when they could not be read', async () => {
      vi.mocked(bridge.getReadingSessions).mockRejectedValue(new Error('数据库被占用'));
      render(<ReadingSessions />);

      expect(await screen.findByRole('alert')).toHaveTextContent('读取阅读会话失败：数据库被占用');
      expect(screen.queryByText(/还没有阅读会话/)).not.toBeInTheDocument();
    });

    it('says that the chosen source has none, when the sessions that were shown for it are gone', async () => {
      vi.mocked(bridge.getReadingSessions).mockResolvedValueOnce([
        session({ id: 'a', sourceTitle: 'Article', sourceApp: 'Chrome' }),
        session({ id: 'b', sourceTitle: 'Report', sourceApp: 'Word' }),
      ]);
      const view = render(<ReadingSessions />);
      await screen.findByText('Report');
      await userEvent.selectOptions(screen.getByLabelText('按来源应用筛选'), 'Word');

      // A shorter gap regroups the lookups, and the Word session is no longer among them.
      context.settings = { sessionGapMinutes: 10 };
      vi.mocked(bridge.getReadingSessions).mockResolvedValueOnce([
        session({ id: 'a', sourceTitle: 'Article', sourceApp: 'Chrome' }),
      ]);
      view.rerender(<ReadingSessions />);

      expect(await screen.findByText('这个来源下还没有阅读会话')).toBeInTheDocument();
      expect(bridge.getReadingSessions).toHaveBeenLastCalledWith(10, 50, 0);
    });
  });

  describe('opening a session', () => {
    it('shows the words that were looked up in it, and hides them again', async () => {
      render(<ReadingSessions />);

      await openSession();

      expect(await screen.findByText('第一')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /The Economist/ })).toHaveAttribute('aria-expanded', 'true');

      await userEvent.click(screen.getByRole('button', { name: /The Economist/ }));

      expect(screen.queryByText('第一')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /The Economist/ })).toHaveAttribute('aria-expanded', 'false');
    });

    it('asks for the words of a session only the first time it is opened', async () => {
      render(<ReadingSessions />);

      await openSession();
      await screen.findByText('第一');
      await userEvent.click(screen.getByRole('button', { name: /The Economist/ }));
      await userEvent.click(screen.getByRole('button', { name: /The Economist/ }));

      expect(await screen.findByText('第一')).toBeInTheDocument();
      expect(bridge.getSessionWords).toHaveBeenCalledTimes(1);
    });

    it('says what went wrong when the words could not be read', async () => {
      vi.mocked(bridge.getSessionWords).mockRejectedValue('词库暂时无法读取');
      render(<ReadingSessions />);

      await openSession();

      expect(await screen.findByRole('alert')).toHaveTextContent('读取会话词条失败：词库暂时无法读取');
    });
  });

  describe('tagging a session', () => {
    async function openAndType(text: string) {
      render(<ReadingSessions />);
      await openSession();
      await userEvent.type(screen.getByLabelText('批量标签'), text);
    }

    it('gives every word of the session the tag, on Enter, and tells how many got it', async () => {
      await openAndType('Economics{Enter}');

      await waitFor(() => expect(bridge.tagSession).toHaveBeenCalledWith('s1', ['economics']));
      expect(await screen.findByRole('status')).toHaveTextContent('已为 2 个词添加标签「economics」');
      expect(context.refreshWords).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('批量标签')).toHaveValue('');
    });

    it('keeps showing the words of the session once they are tagged', async () => {
      await openAndType('news{Enter}');

      expect(await screen.findByRole('status')).toBeInTheDocument();
      expect(await screen.findByText('第一')).toBeInTheDocument();
      expect(screen.getByText('第二')).toBeInTheDocument();
    });

    it('does the same from the button', async () => {
      await openAndType('news');

      await userEvent.click(screen.getByRole('button', { name: '添加标签' }));

      await waitFor(() => expect(bridge.tagSession).toHaveBeenCalledWith('s1', ['news']));
    });

    it('does nothing while the box is empty, or holds only spaces', async () => {
      await openAndType('   ');

      await userEvent.click(screen.getByRole('button', { name: '添加标签' }));
      await userEvent.type(screen.getByLabelText('批量标签'), '{Enter}');

      expect(bridge.tagSession).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('lets Enter pick a candidate of an input method, instead of tagging with half a word', async () => {
      await openAndType('ni');

      fireEvent.keyDown(screen.getByLabelText('批量标签'), { key: 'Enter', isComposing: true });

      expect(bridge.tagSession).not.toHaveBeenCalled();
    });

    it('says what went wrong, and leaves the box as it was, when the tag could not be added', async () => {
      vi.mocked(bridge.tagSession).mockRejectedValue(new Error('磁盘已满'));
      await openAndType('news{Enter}');

      expect(await screen.findByRole('alert')).toHaveTextContent('添加标签失败：磁盘已满');
      expect(screen.getByLabelText('批量标签')).toHaveValue('news');
      expect(context.refreshWords).not.toHaveBeenCalled();
    });

    it('replaces the complaint with the news when it works the second time', async () => {
      vi.mocked(bridge.tagSession).mockRejectedValueOnce(new Error('磁盘已满'));
      await openAndType('news{Enter}');
      await screen.findByRole('alert');

      await userEvent.type(screen.getByLabelText('批量标签'), '{Enter}');

      expect(await screen.findByRole('status')).toHaveTextContent('已为 2 个词添加标签「news」');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('exporting a session', () => {
    async function exportIt() {
      render(<ReadingSessions />);
      await openSession();
      await userEvent.click(screen.getByRole('button', { name: '导出会话' }));
    }

    it('saves the words of the session as Markdown, and tells where the file went', async () => {
      await exportIt();

      expect(await screen.findByRole('status')).toHaveTextContent('已导出到 C:\\notes\\session.md');
      expect(bridge.exportWordsData).toHaveBeenCalledWith(['w1', 'w2'], 'markdown');
      expect(bridge.saveFileDialog).toHaveBeenCalledWith('阅读会话-2026-03-02.md', '# alpha\n# beta', 'Markdown', ['md']);
    });

    it('says nothing when the save dialog was closed without a file', async () => {
      vi.mocked(bridge.saveFileDialog).mockResolvedValue(null);
      await exportIt();

      await waitFor(() => expect(bridge.saveFileDialog).toHaveBeenCalled());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says what went wrong when the words could not be exported', async () => {
      vi.mocked(bridge.exportWordsData).mockRejectedValue(new Error('导出失败了'));
      await exportIt();

      expect(await screen.findByRole('alert')).toHaveTextContent('导出会话失败：导出失败了');
      expect(bridge.saveFileDialog).not.toHaveBeenCalled();
    });
  });

  describe('adding a session to the review', () => {
    async function addIt() {
      render(<ReadingSessions />);
      await openSession();
      await userEvent.click(screen.getByRole('button', { name: '加入复习' }));
    }

    it('tells how many words joined the queue', async () => {
      await addIt();

      expect(await screen.findByRole('status')).toHaveTextContent('已将 2 个词加入复习队列');
      expect(bridge.addSessionToReview).toHaveBeenCalledWith('s1');
    });

    it('tells that there was nothing to add when all of them were in it already', async () => {
      vi.mocked(bridge.addSessionToReview).mockResolvedValue(0);
      await addIt();

      expect(await screen.findByRole('status')).toHaveTextContent('该会话词条已在复习队列中');
    });

    it('says what went wrong when they could not be added', async () => {
      vi.mocked(bridge.addSessionToReview).mockRejectedValue(new Error('队列已锁定'));
      await addIt();

      expect(await screen.findByRole('alert')).toHaveTextContent('加入复习失败：队列已锁定');
    });
  });

  it('marks a failure as an alert, and a success as a polite status', async () => {
    vi.mocked(bridge.addSessionToReview).mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('x'));
    render(<ReadingSessions />);
    await openSession();

    await userEvent.click(screen.getByRole('button', { name: '加入复习' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已将 3 个词加入复习队列');
    expect(screen.getByRole('status')).toHaveClass('text-accent');

    await userEvent.click(screen.getByRole('button', { name: '加入复习' }));
    expect(await screen.findByRole('alert')).toHaveClass('text-danger');
    expect(screen.getByRole('alert')).toHaveTextContent('加入复习失败：x');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
