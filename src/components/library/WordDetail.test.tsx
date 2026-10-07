import { useState } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider, useLexNote } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import type { Entry, SavedWord } from '../../types/lexnote';
import { WordDetail } from './WordDetail';

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
  lookupWord: vi.fn(),
  saveWord: vi.fn(),
  restoreWord: vi.fn(),
  updateWord: vi.fn(),
  emitWordSaved: vi.fn(),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));

const saved = (overrides: Record<string, unknown> = {}): SavedWord =>
  ({
    id: 'w1',
    selection: 'running',
    lemma: 'run',
    pos: 'v.',
    ipaUS: '',
    ipaUK: '',
    kind: 'word',
    translation: '旧释义',
    contextMeaning: '',
    explanation: '',
    senses: [],
    associations: [],
    examples: [],
    collocations: [],
    register: 'neutral',
    context: 'He was running late.',
    savedAt: '2026-01-01T00:00:00.000Z',
    sourceApp: 'Reader',
    sourceTitle: 'A Book',
    tags: ['travel'],
    mastery: 'familiar',
    lookups: 3,
    note: '我的笔记',
    ...overrides,
  }) as unknown as SavedWord;

const NEW_ANSWER = {
  id: 'not-the-saved-id',
  selection: 'running',
  lemma: 'run',
  pos: 'v.',
  ipaUS: '',
  ipaUK: '',
  kind: 'word',
  translation: '新释义',
  contextMeaning: '',
  explanation: '',
  senses: [],
  associations: [],
  examples: [],
  collocations: [],
  register: 'neutral',
  syntax: [{ text: 'added', role: 'x', note: '' }],
} as unknown as Entry;

/** What the provider shows for the word with the given id, plus a way to switch to the other one. */
function Detail() {
  const { words } = useLexNote();
  const [id, setId] = useState('w1');
  return (
    <>
      <button type="button" onClick={() => setId('w2')}>
        show-w2
      </button>
      <WordDetail word={words.find((word) => word.id === id) ?? null} inline />
    </>
  );
}

function renderDetail(words: SavedWord[] = [saved()]) {
  vi.mocked(bridge.getAllWords).mockResolvedValue(words);
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route
          path="/library"
          element={
            <LexNoteProvider>
              <Detail />
            </LexNoteProvider>
          }
        />
        <Route path="/settings" element={<p>设置页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const reanalyzeButton = () => screen.getByRole('button', { name: '重新解析' });

async function shown(lemma: string) {
  await screen.findByRole('heading', { name: lemma });
}

describe('re-analysing a saved word', () => {
  beforeEach(() => {
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
    vi.mocked(bridge.lookupWord).mockResolvedValue(NEW_ANSWER);
    // The backend answers with the merged document and counts the lookup.
    vi.mocked(bridge.saveWord).mockImplementation(async (word) => ({
      ...word,
      lookups: word.lookups + 1,
    }));
    vi.mocked(bridge.restoreWord).mockResolvedValue(undefined);
    vi.mocked(bridge.updateWord).mockResolvedValue(undefined);
    vi.mocked(bridge.emitWordSaved).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('asks the model about the word as it was first collected, and says which model answered', async () => {
    const user = userEvent.setup();
    renderDetail();
    await shown('run');

    await user.click(reanalyzeButton());

    expect(await screen.findByText('已用 qwen-test 重新解析')).toBeInTheDocument();
    expect(bridge.lookupWord).toHaveBeenCalledTimes(1);
    expect(bridge.lookupWord).toHaveBeenCalledWith('running', 'He was running late.', 'word', true);
    expect(screen.getByText('新释义')).toBeInTheDocument();
    expect(screen.queryByText('旧释义')).not.toBeInTheDocument();
  });

  it('saves the new content without touching what the user owns or where the word came from', async () => {
    const user = userEvent.setup();
    renderDetail();
    await shown('run');

    await user.click(reanalyzeButton());
    await screen.findByText('已用 qwen-test 重新解析');

    expect(bridge.saveWord).toHaveBeenCalledTimes(1);
    expect(bridge.saveWord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'w1',
        translation: '新释义',
        savedAt: '2026-01-01T00:00:00.000Z',
        context: 'He was running late.',
        sourceApp: 'Reader',
        sourceTitle: 'A Book',
        mastery: 'familiar',
        tags: ['travel'],
        note: '我的笔记',
      }),
    );
  });

  it('shows the button as busy while the model works, and not usable twice', async () => {
    const user = userEvent.setup();
    let answer!: (entry: Entry) => void;
    vi.mocked(bridge.lookupWord).mockReturnValue(
      new Promise<Entry>((resolve) => {
        answer = resolve;
      }),
    );
    renderDetail();
    await shown('run');

    await user.click(reanalyzeButton());

    const busy = await screen.findByRole('button', { name: '解析中…' });
    expect(busy).toBeDisabled();
    expect(bridge.saveWord).not.toHaveBeenCalled();

    answer(NEW_ANSWER);
    expect(await screen.findByText('已用 qwen-test 重新解析')).toBeInTheDocument();
    expect(reanalyzeButton()).toBeEnabled();
    expect(bridge.lookupWord).toHaveBeenCalledTimes(1);
  });

  describe('taking the new answer back', () => {
    it('restores everything the model wrote, including what the new answer added', async () => {
      const user = userEvent.setup();
      renderDetail();
      await shown('run');
      await user.click(reanalyzeButton());
      await screen.findByText('已用 qwen-test 重新解析');

      await user.click(screen.getByRole('button', { name: '回滚' }));

      await waitFor(() => expect(bridge.restoreWord).toHaveBeenCalledTimes(1));
      const restored = vi.mocked(bridge.restoreWord).mock.calls[0][0];
      expect(restored).toMatchObject({ id: 'w1', translation: '旧释义', lookups: 3 });
      expect(restored).not.toHaveProperty('syntax');
      expect(await screen.findByText('旧释义')).toBeInTheDocument();
      expect(screen.queryByText('已用 qwen-test 重新解析')).not.toBeInTheDocument();
    });

    it('keeps what the user changed in the meantime', async () => {
      const user = userEvent.setup();
      renderDetail();
      await shown('run');
      await user.click(reanalyzeButton());
      await screen.findByText('已用 qwen-test 重新解析');
      await user.click(screen.getByRole('button', { name: '已掌握' }));

      await user.click(screen.getByRole('button', { name: '回滚' }));

      await waitFor(() => expect(bridge.restoreWord).toHaveBeenCalledTimes(1));
      expect(vi.mocked(bridge.restoreWord).mock.calls[0][0]).toMatchObject({
        translation: '旧释义',
        mastery: 'mastered',
        note: '我的笔记',
        tags: ['travel'],
      });
    });

    it('says so when the rollback fails, and leaves the way back open', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.restoreWord).mockRejectedValue('database is locked');
      renderDetail();
      await shown('run');
      await user.click(reanalyzeButton());
      await screen.findByText('已用 qwen-test 重新解析');

      await user.click(screen.getByRole('button', { name: '回滚' }));

      expect(await screen.findByText(/回滚失败：database is locked/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '回滚' })).toBeEnabled();
      expect(screen.getByText('新释义')).toBeInTheDocument();
    });
  });

  describe('when it does not work', () => {
    it('reports the real reason and leaves the word as it was', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.lookupWord).mockRejectedValue('[rate_limit] 请求过于频繁（429）');
      renderDetail();
      await shown('run');

      await user.click(reanalyzeButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('重新解析失败，词条保持原样');
      expect(alert).toHaveTextContent('限流');
      expect(bridge.saveWord).not.toHaveBeenCalled();
      expect(screen.getByText('旧释义')).toBeInTheDocument();
      expect(screen.queryByText(/已用 .* 重新解析/)).not.toBeInTheDocument();
      expect(reanalyzeButton()).toBeEnabled();
    });

    it('can simply be tried again', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.lookupWord).mockRejectedValueOnce('[server] 服务商出错了（503）');
      renderDetail();
      await shown('run');
      await user.click(reanalyzeButton());
      const alert = await screen.findByRole('alert');

      await user.click(within(alert).getByRole('button', { name: '重试' }));

      expect(await screen.findByText('已用 qwen-test 重新解析')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(bridge.lookupWord).toHaveBeenCalledTimes(2);
    });

    it('leads to the settings page when the key is what is wrong', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.lookupWord).mockRejectedValue('[auth] 服务商拒绝了这个 Key（HTTP 401）');
      renderDetail();
      await shown('run');
      await user.click(reanalyzeButton());
      const alert = await screen.findByRole('alert');

      await user.click(within(alert).getByRole('button', { name: '去设置检查' }));

      expect(await screen.findByText('设置页')).toBeInTheDocument();
    });

    it('does not blame the model when the answer could not be saved', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.saveWord).mockRejectedValue('database is locked');
      renderDetail();
      await shown('run');

      await user.click(reanalyzeButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('保存失败');
      expect(alert).toHaveTextContent('database is locked');
      expect(screen.getByText('旧释义')).toBeInTheDocument();
    });
  });

  it('saves a late answer to its own word and shows nothing about it on the word now open', async () => {
    const user = userEvent.setup();
    let answer!: (entry: Entry) => void;
    vi.mocked(bridge.lookupWord).mockReturnValue(
      new Promise<Entry>((resolve) => {
        answer = resolve;
      }),
    );
    renderDetail([saved(), saved({ id: 'w2', lemma: 'walk', selection: 'walk', translation: '走' })]);
    await shown('run');
    await user.click(reanalyzeButton());
    await user.click(screen.getByRole('button', { name: 'show-w2' }));
    await shown('walk');

    answer(NEW_ANSWER);

    await waitFor(() => expect(bridge.saveWord).toHaveBeenCalledTimes(1));
    expect(bridge.saveWord).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1', translation: '新释义' }));
    expect(screen.queryByText(/已用 .* 重新解析/)).not.toBeInTheDocument();
    expect(screen.getByText('走')).toBeInTheDocument();
    expect(reanalyzeButton()).toBeEnabled();
  });
});
