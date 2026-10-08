import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../../lib/tauri-bridge';
import type { ReviewStats } from '../../types/lexnote';
import { ReviewOverview } from './ReviewOverview';

vi.mock('../../lib/tauri-bridge', () => ({
  getReviewStats: vi.fn(),
}));

const stats = (overrides: Partial<ReviewStats> = {}): ReviewStats => ({
  dueCount: 0,
  boxCounts: [0, 0, 0],
  total: 10,
  nextDueAt: null,
  ...overrides,
});

function show() {
  return render(
    <MemoryRouter>
      <ReviewOverview />
    </MemoryRouter>,
  );
}

const line = () => screen.getByRole('link', { name: /今日回顾/ });

describe('the line in the library that leads to the review', () => {
  beforeEach(() => {
    // Only the clock is faked: the answers of the backend are promises, which still have to arrive.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('says how many words wait, and leads to the review', async () => {
    vi.mocked(bridge.getReviewStats).mockResolvedValue(stats({ dueCount: 7 }));
    show();

    expect(await screen.findByText('7 个词等待复习')).toBeInTheDocument();
    expect(line()).toHaveAttribute('href', '/review');
    expect(line()).toHaveTextContent('去复习');
  });

  it('says when the next words are due, when none wait today', async () => {
    vi.mocked(bridge.getReviewStats).mockResolvedValue(stats({ nextDueAt: '2026-10-09' }));
    show();

    expect(await screen.findByText('今天没有到期的词，下次复习：明天')).toBeInTheDocument();
    expect(line()).toHaveTextContent('查看');
    expect(line()).not.toHaveTextContent('去复习');
  });

  it('counts the days to the next review when it is not tomorrow', async () => {
    vi.mocked(bridge.getReviewStats).mockResolvedValue(stats({ nextDueAt: '2026-10-12' }));
    show();

    expect(await screen.findByText('今天没有到期的词，下次复习：4 天后')).toBeInTheDocument();
  });

  it('says that no word is due when there is none to wait for either', async () => {
    vi.mocked(bridge.getReviewStats).mockResolvedValue(stats());
    show();

    expect(await screen.findByText('暂无到期词')).toBeInTheDocument();
  });

  it('is there, saying nothing, before the backend has answered', () => {
    vi.mocked(bridge.getReviewStats).mockReturnValue(new Promise(() => undefined));
    show();

    expect(line()).toHaveAttribute('href', '/review');
    expect(line()).not.toHaveTextContent('等待复习');
    expect(line()).not.toHaveTextContent('暂无到期词');
  });

  it('is still there to lead to the review when the numbers cannot be read', async () => {
    vi.mocked(bridge.getReviewStats).mockRejectedValue('database is locked');
    show();

    await vi.waitFor(() => expect(bridge.getReviewStats).toHaveBeenCalledTimes(1));
    expect(line()).toHaveAttribute('href', '/review');
    expect(line()).toHaveTextContent('查看');
  });
});
