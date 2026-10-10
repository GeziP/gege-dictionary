import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { ReviewAnswer, ReviewState, SavedWord } from '../types/lexnote';
import { Review } from './Review';

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
  getReviewQueue: vi.fn(),
  getReviewStats: vi.fn(),
  submitReview: vi.fn(),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));

const word = (lemma: string, overrides: Record<string, unknown> = {}): SavedWord =>
  ({
    id: lemma,
    selection: lemma,
    lemma,
    pos: 'n.',
    ipaUS: '',
    ipaUK: '',
    translation: `${lemma}的释义`,
    contextMeaning: `${lemma} 在语境中的意思`,
    explanation: '',
    senses: [],
    associations: [],
    examples: [],
    collocations: [],
    register: 'neutral',
    kind: 'word',
    savedAt: '2026-10-05T08:00:00Z',
    context: '',
    sourceApp: 'Chrome',
    sourceTitle: '',
    tags: [],
    mastery: 'new',
    lookups: 1,
    note: '',
    reviewState: { wordId: lemma, box: 1, dueAt: '2026-10-07', correctCount: 0, hardCount: 0, wrongCount: 0 },
    ...overrides,
  }) as unknown as SavedWord;

/** What the backend answers once a card has been answered: where the card went. */
const outcome = (wordId: string, lastResult: ReviewAnswer, box: 1 | 2 | 3, previousBox: 1 | 2 | 3): ReviewState => ({
  wordId,
  box,
  previousBox,
  lastResult,
  dueAt: '2026-10-08',
  correctCount: 0,
  hardCount: 0,
  wrongCount: 0,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/review']}>
      <LexNoteProvider>
        <Routes>
          <Route path="/review" element={<Review />} />
        </Routes>
      </LexNoteProvider>
    </MemoryRouter>,
  );
}

const SPACE = { key: ' ', code: 'Space' };
const key = (digit: '1' | '2' | '3') => ({ key: digit, code: `Digit${digit}` });
const press = (event: { key: string; code: string }) => fireEvent.keyDown(window, event);
const turnOver = () => userEvent.click(screen.getByRole('button', { name: '翻面' }));
const answerWith = (label: string) => userEvent.click(screen.getByRole('button', { name: label }));
const card = (lemma: string) => screen.findByRole('heading', { name: lemma });

const CORRECT = '认识（1）';
const HARD = '有点难（2）';
const WRONG = '不认识（3）';

describe('the review page', () => {
  beforeEach(() => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
    } as never);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.listenLookupDone).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    vi.mocked(bridge.getReviewQueue).mockResolvedValue([word('alpha'), word('beta')]);
    vi.mocked(bridge.getReviewStats).mockResolvedValue({ dueCount: 0, boxCounts: [0, 0, 0], total: 2, nextDueAt: null });
    vi.mocked(bridge.submitReview).mockImplementation(async (wordId, answer) => outcome(wordId, answer, 1, 1));
    vi.mocked(bridge.speakText).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('asks for the queue of the day and shows its first card with the meaning hidden', async () => {
    renderPage();

    await card('alpha');
    expect(bridge.getReviewQueue).toHaveBeenCalledTimes(1);
    expect(bridge.getReviewQueue).toHaveBeenCalledWith(20);
    expect(screen.getByText('1 / 2 · 第 1 档')).toBeInTheDocument();
    expect(screen.getByText('先回忆含义，点击或按空格翻面')).toBeInTheDocument();
    expect(screen.queryByText('alpha 在语境中的意思')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CORRECT })).not.toBeInTheDocument();
  });

  it('turns the card over by a click and offers the three answers, 认识 first and 不认识 last', async () => {
    renderPage();
    await card('alpha');

    await turnOver();

    expect(screen.getByText('alpha 在语境中的意思')).toBeInTheDocument();
    expect(screen.queryByText('先回忆含义，点击或按空格翻面')).not.toBeInTheDocument();
    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text) => [CORRECT, HARD, WRONG].includes(text ?? ''));
    expect(labels).toEqual([CORRECT, HARD, WRONG]);
  });

  it('turns the card over by the space bar', async () => {
    renderPage();
    await card('alpha');

    press(SPACE);

    expect(await screen.findByRole('button', { name: HARD })).toBeInTheDocument();
    expect(screen.getByText('alpha 在语境中的意思')).toBeInTheDocument();
  });

  it('does not give the meaning away when the word is played to be recalled', async () => {
    renderPage();
    await card('alpha');

    await userEvent.click(screen.getByRole('button', { name: '朗读 alpha' }));

    expect(bridge.speakText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bridge.speakText).mock.calls[0][0]).toBe('alpha');
    expect(screen.getByText('先回忆含义，点击或按空格翻面')).toBeInTheDocument();
    expect(screen.queryByText('alpha 在语境中的意思')).not.toBeInTheDocument();
  });

  const BUTTONS: Array<[string, ReviewAnswer]> = [
    [CORRECT, 'correct'],
    [HARD, 'hard'],
    [WRONG, 'wrong'],
  ];

  it.each(BUTTONS)('records %s as the answer %s, refreshes the library and goes on to the next card', async (label, answer) => {
    renderPage();
    await card('alpha');
    await waitFor(() => expect(bridge.getAllWords).toHaveBeenCalledTimes(1));
    await turnOver();

    await answerWith(label);

    expect(await screen.findByText('2 / 2 · 第 1 档')).toBeInTheDocument();
    expect(bridge.submitReview).toHaveBeenCalledWith('alpha', answer);
    expect(screen.getByRole('heading', { name: 'beta' })).toBeInTheDocument();
    // The next card is shown face down again.
    expect(screen.getByText('先回忆含义，点击或按空格翻面')).toBeInTheDocument();
    await waitFor(() => expect(bridge.getAllWords).toHaveBeenCalledTimes(2));
  });

  const KEYS: Array<['1' | '2' | '3', ReviewAnswer]> = [
    ['1', 'correct'],
    ['2', 'hard'],
    ['3', 'wrong'],
  ];

  it.each(KEYS)('records the key %s as the answer %s', async (digit, answer) => {
    renderPage();
    await card('alpha');
    press(SPACE);
    await screen.findByRole('button', { name: HARD });

    press(key(digit));

    expect(await screen.findByText('2 / 2 · 第 1 档')).toBeInTheDocument();
    expect(bridge.submitReview).toHaveBeenCalledTimes(1);
    expect(bridge.submitReview).toHaveBeenCalledWith('alpha', answer);
  });

  it('ignores the answer keys while the card is still face down', async () => {
    renderPage();
    await card('alpha');

    press(key('1'));
    press(key('2'));
    press(key('3'));

    expect(bridge.submitReview).not.toHaveBeenCalled();
    expect(screen.getByText('1 / 2 · 第 1 档')).toBeInTheDocument();
  });

  it('records an answer once, however often the key is hit while it is being saved', async () => {
    let finish: (state: ReviewState) => void = () => undefined;
    vi.mocked(bridge.submitReview).mockImplementation(
      () =>
        new Promise<ReviewState>((resolve) => {
          finish = resolve;
        }),
    );
    renderPage();
    await card('alpha');
    press(SPACE);
    await screen.findByRole('button', { name: CORRECT });

    press(key('1'));
    press(key('1'));
    press(key('2'));
    await userEvent.click(screen.getByRole('button', { name: WRONG }));
    expect(bridge.submitReview).toHaveBeenCalledTimes(1);

    await act(async () => finish(outcome('alpha', 'correct', 2, 1)));

    // It went on by one card, not by the four answers: beta is still to be seen.
    expect(await screen.findByText('2 / 2 · 第 1 档')).toBeInTheDocument();
    expect(bridge.submitReview).toHaveBeenCalledTimes(1);
  });

  it('stays on the card when the answer could not be saved, says why, and lets it be given again', async () => {
    vi.mocked(bridge.submitReview).mockRejectedValueOnce('database is locked');
    renderPage();
    await card('alpha');
    await turnOver();

    await answerWith(HARD);

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(screen.getByText('1 / 2 · 第 1 档')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: HARD })).toBeInTheDocument();

    await answerWith(HARD);

    expect(await screen.findByText('2 / 2 · 第 1 档')).toBeInTheDocument();
    expect(screen.queryByText('database is locked')).not.toBeInTheDocument();
    expect(bridge.submitReview).toHaveBeenCalledTimes(2);
    expect(bridge.submitReview).toHaveBeenLastCalledWith('alpha', 'hard');
  });

  it('moves on without a complaint from a card whose word was deleted meanwhile', async () => {
    vi.mocked(bridge.submitReview).mockRejectedValueOnce('生词已被删除，这张卡片无需再复习');
    renderPage();
    await card('alpha');
    await turnOver();

    await answerWith(CORRECT);

    expect(await screen.findByText('2 / 2 · 第 1 档')).toBeInTheDocument();
    expect(screen.queryByText(/已被删除/)).not.toBeInTheDocument();
  });

  it('sums up the session at the end, with the hard answers counted apart', async () => {
    vi.mocked(bridge.getReviewQueue).mockResolvedValue([word('alpha'), word('beta'), word('gamma')]);
    vi.mocked(bridge.submitReview)
      .mockResolvedValueOnce(outcome('alpha', 'correct', 2, 1))
      .mockResolvedValueOnce(outcome('beta', 'hard', 1, 1))
      .mockResolvedValueOnce(outcome('gamma', 'wrong', 1, 2));
    renderPage();

    for (const [lemma, label] of [
      ['alpha', CORRECT],
      ['beta', HARD],
      ['gamma', WRONG],
    ]) {
      await card(lemma);
      await turnOver();
      await answerWith(label);
    }

    expect(await screen.findByRole('heading', { name: '本次回顾完成' })).toBeInTheDocument();
    // Moved up by one, left in its box by one, back to the first box by one.
    expect(screen.getByText('共 3 词，答对 1，有点难 1，升档 1，回落 1')).toBeInTheDocument();
  });

  it('leaves the hard answers out of the summary when there were none', async () => {
    vi.mocked(bridge.getReviewQueue).mockResolvedValue([word('alpha')]);
    vi.mocked(bridge.submitReview).mockResolvedValueOnce(outcome('alpha', 'correct', 2, 1));
    renderPage();
    await card('alpha');
    await turnOver();

    await answerWith(CORRECT);

    expect(await screen.findByText('共 1 词，答对 1，升档 1，回落 0')).toBeInTheDocument();
  });

  describe('when the queue is through', () => {
    const TODAY = new Date();
    const dayFromNow = (days: number): string => {
      const date = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + days);
      const pad = (value: number) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };

    it('says that nothing is due and when the next word is, without a button that could do nothing', async () => {
      vi.mocked(bridge.getReviewQueue).mockResolvedValueOnce([]);
      vi.mocked(bridge.getReviewStats).mockResolvedValue({
        dueCount: 0,
        boxCounts: [2, 0, 0],
        total: 2,
        nextDueAt: dayFromNow(1),
      });
      renderPage();

      expect(await screen.findByRole('heading', { name: '今天没有到期词' })).toBeInTheDocument();
      expect(await screen.findByText('下次复习：明天')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '继续复习全部到期词' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: '回到生词库' })).toHaveAttribute('href', '/library');
    });

    it('says how far away the next word is when it is days off', async () => {
      vi.mocked(bridge.getReviewQueue).mockResolvedValueOnce([]);
      vi.mocked(bridge.getReviewStats).mockResolvedValue({
        dueCount: 0,
        boxCounts: [0, 0, 2],
        total: 2,
        nextDueAt: dayFromNow(5),
      });
      renderPage();

      expect(await screen.findByText('下次复习：5 天后')).toBeInTheDocument();
    });

    it('goes through everything that is due when more words are due than the queue held', async () => {
      vi.mocked(bridge.getReviewQueue).mockResolvedValueOnce([word('alpha')]);
      vi.mocked(bridge.getReviewStats).mockResolvedValue({ dueCount: 7, boxCounts: [7, 0, 0], total: 30 });
      renderPage();
      await card('alpha');
      await turnOver();
      await answerWith(CORRECT);

      expect(await screen.findByRole('heading', { name: '本次回顾完成' })).toBeInTheDocument();
      expect(await screen.findByText('还有 7 个词已经到期。')).toBeInTheDocument();

      vi.mocked(bridge.getReviewQueue).mockResolvedValueOnce([word('delta')]);
      await userEvent.click(screen.getByRole('button', { name: '继续复习全部到期词' }));

      await card('delta');
      expect(bridge.getReviewQueue).toHaveBeenLastCalledWith(0);
    });

    it('offers nothing to go on with when the session took in everything that was due', async () => {
      vi.mocked(bridge.getReviewQueue).mockResolvedValueOnce([word('alpha')]);
      renderPage();
      await card('alpha');
      await turnOver();
      await answerWith(CORRECT);

      expect(await screen.findByRole('heading', { name: '本次回顾完成' })).toBeInTheDocument();
      await waitFor(() => expect(bridge.getReviewStats).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: '继续复习全部到期词' })).not.toBeInTheDocument();
    });
  });

  it('leaves the space bar to a button that has the focus, so that the answer is not given away or lost', async () => {
    renderPage();
    await card('alpha');

    // The speaker is pressed with the space bar: it speaks, and the card stays face down.
    const speaker = screen.getByRole('button', { name: '朗读 alpha' });
    speaker.focus();
    expect(fireEvent.keyDown(speaker, SPACE)).toBe(true);
    expect(screen.queryByRole('button', { name: CORRECT })).not.toBeInTheDocument();

    // Pointed at nothing in particular, it turns the card over.
    press(SPACE);
    expect(await screen.findByRole('button', { name: CORRECT })).toBeInTheDocument();
  });

  it('shows the box a card is in', async () => {
    vi.mocked(bridge.getReviewQueue).mockResolvedValue([
      word('alpha', { reviewState: { wordId: 'alpha', box: 3, dueAt: '2026-10-07', correctCount: 4, hardCount: 0, wrongCount: 0 } }),
    ]);
    renderPage();

    expect(await screen.findByText('1 / 1 · 第 3 档')).toBeInTheDocument();
  });

  it('says why the queue could not be made, instead of showing an empty day', async () => {
    vi.mocked(bridge.getReviewQueue).mockRejectedValue('queue failed');
    renderPage();

    expect(await screen.findByText('queue failed')).toBeInTheDocument();
  });
});
