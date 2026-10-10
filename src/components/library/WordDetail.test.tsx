import { useState, type ComponentProps } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider, useLexNote } from '../../contexts/LexNoteContext';
import { READER_MAX, READER_MIN } from '../../lib/reader-size';
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
  findWordByLemma: vi.fn(),
  saveWord: vi.fn(),
  restoreWord: vi.fn(),
  updateWord: vi.fn(),
  deleteWords: vi.fn(),
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

/**
 * What the provider shows for the word with the given id, plus a way to switch
 * to the other one and one to load the library again, as if something else had
 * changed it.
 */
function Detail() {
  const { words, refreshWords } = useLexNote();
  const [id, setId] = useState('w1');
  return (
    <>
      <button type="button" onClick={() => setId('w2')}>
        show-w2
      </button>
      <button type="button" onClick={() => refreshWords()}>
        refresh-words
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

/** What the backend answers, for the tests of this file. */
function mockBridge() {
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
  vi.mocked(bridge.deleteWords).mockResolvedValue(undefined);
  vi.mocked(bridge.findWordByLemma).mockResolvedValue(null);
  vi.mocked(bridge.emitWordSaved).mockResolvedValue(undefined);
}

describe('re-analysing a saved word', () => {
  beforeEach(mockBridge);

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

  describe('when the answer names another form of the word', () => {
    // The word was saved as "running" (NEW_ANSWER is the model saying it is a form of "run").
    const running = () => saved({ lemma: 'running' });
    const choice = () => screen.findByRole('group', { name: /请选择怎么处理/ });
    const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
      user.click(within(await choice()).getByRole('button', { name }));
    const savedDraft = () => vi.mocked(bridge.saveWord).mock.calls[0][0];
    /** The library as something else left it: the provider loads it again and shows what is there. */
    const reloadLibrary = async (
      user: ReturnType<typeof userEvent.setup>,
      library: SavedWord[],
    ) => {
      vi.mocked(bridge.getAllWords).mockResolvedValue(library);
      const loads = vi.mocked(bridge.getAllWords).mock.calls.length;
      await user.click(screen.getByRole('button', { name: 'refresh-words' }));
      await waitFor(() => expect(vi.mocked(bridge.getAllWords).mock.calls.length).toBe(loads + 1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    it('asks what to do with the answer instead of saving it', async () => {
      const user = userEvent.setup();
      renderDetail([running()]);
      await shown('running');

      await user.click(reanalyzeButton());

      const group = await choice();
      expect(group).toHaveTextContent('模型认为原形是「run」，你保存的是「running」');
      expect(group).not.toHaveTextContent('词库里已有');
      expect(within(group).getByRole('button', { name: '更新「running」' })).toBeEnabled();
      expect(within(group).getByRole('button', { name: '另存为「run」' })).toBeEnabled();
      expect(within(group).getByRole('button', { name: '都不要' })).toBeEnabled();
      expect(bridge.saveWord).not.toHaveBeenCalled();
      expect(screen.getByText('旧释义')).toBeInTheDocument();
      expect(reanalyzeButton()).toBeEnabled();
    });

    it('says so when the library has the other form already, and that it is updated, not added', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.findWordByLemma).mockResolvedValue(saved({ id: 'w-run', lemma: 'run' }));
      renderDetail([running()]);
      await shown('running');

      await user.click(reanalyzeButton());

      expect(await choice()).toHaveTextContent('词库里已有「run」，会更新它，不会重复添加');
      expect(bridge.findWordByLemma).toHaveBeenCalledWith('run', 'word');
    });

    describe('replacing the content of the word as it is', () => {
      it('puts the new content in and keeps the form the word is saved under', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());

        await pick(user, '更新「running」');

        expect(await screen.findByText('已用 qwen-test 重新解析')).toBeInTheDocument();
        expect(bridge.saveWord).toHaveBeenCalledTimes(1);
        expect(savedDraft()).toMatchObject({
          id: 'w1',
          lemma: 'running',
          translation: '新释义',
          mastery: 'familiar',
          tags: ['travel'],
          note: '我的笔记',
        });
        expect(screen.getByRole('heading', { name: 'running' })).toBeInTheDocument();
        expect(screen.getByText('新释义')).toBeInTheDocument();
        expect(screen.queryByRole('group', { name: /请选择怎么处理/ })).not.toBeInTheDocument();
      });

      it('can be rolled back like any other re-analysis', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await pick(user, '更新「running」');
        await screen.findByText('已用 qwen-test 重新解析');

        await user.click(screen.getByRole('button', { name: '回滚' }));

        await waitFor(() => expect(bridge.restoreWord).toHaveBeenCalledTimes(1));
        expect(vi.mocked(bridge.restoreWord).mock.calls[0][0]).toMatchObject({
          id: 'w1',
          lemma: 'running',
          translation: '旧释义',
        });
      });

      it('uses the word as it is by then, not as it was when the model was asked', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await choice();

        await user.click(screen.getByRole('button', { name: '已掌握' }));
        await pick(user, '更新「running」');

        await screen.findByText('已用 qwen-test 重新解析');
        expect(savedDraft()).toMatchObject({ id: 'w1', mastery: 'mastered', note: '我的笔记' });
      });

      it('keeps the choice open, with the reason, when saving fails, and can be tried again', async () => {
        const user = userEvent.setup();
        vi.mocked(bridge.saveWord).mockRejectedValueOnce('database is locked');
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());

        await pick(user, '更新「running」');

        const group = await choice();
        expect(await within(group).findByRole('alert')).toHaveTextContent('保存失败：database is locked');
        expect(within(group).getByRole('button', { name: '更新「running」' })).toBeEnabled();
        expect(screen.getByText('旧释义')).toBeInTheDocument();

        await user.click(within(group).getByRole('button', { name: '更新「running」' }));

        expect(await screen.findByText('已用 qwen-test 重新解析')).toBeInTheDocument();
        expect(bridge.saveWord).toHaveBeenCalledTimes(2);
        expect(bridge.lookupWord).toHaveBeenCalledTimes(1);
      });
    });

    describe('saving the answer as a word of its own', () => {
      beforeEach(() => {
        // A new word comes back as it was sent, with the one lookup it was made by.
        vi.mocked(bridge.saveWord).mockImplementation(async (word) => word);
      });

      it('saves it under the form it names and leaves the open word alone', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());

        await pick(user, '另存为「run」');

        expect(await screen.findByText('新的解析已另存为「run」，这个词条保持原样')).toBeInTheDocument();
        expect(screen.getByText('已用 qwen-test 解析')).toBeInTheDocument();
        expect(bridge.saveWord).toHaveBeenCalledTimes(1);
        expect(savedDraft()).toMatchObject({
          lemma: 'run',
          translation: '新释义',
          context: 'He was running late.',
          sourceApp: 'Reader',
          sourceTitle: 'A Book',
          tags: [],
          note: '',
          mastery: 'new',
          lookups: 1,
        });
        expect(savedDraft().id).not.toBe('w1');
        expect(screen.getByRole('heading', { name: 'running' })).toBeInTheDocument();
        expect(screen.getByText('旧释义')).toBeInTheDocument();
        expect(bridge.restoreWord).not.toHaveBeenCalled();
      });

      it('saves it as the word the library has under that form, so that is not made twice', async () => {
        const user = userEvent.setup();
        const run = saved({ id: 'w-run', lemma: 'run', selection: 'run', translation: '跑' });
        vi.mocked(bridge.findWordByLemma).mockResolvedValue(run);
        renderDetail([running(), run]);
        await shown('running');
        await user.click(reanalyzeButton());

        await pick(user, '另存为「run」');

        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');
        expect(savedDraft()).toMatchObject({ id: 'w-run', lemma: 'run', translation: '新释义' });
      });

      it('asks the library again when the choice is made, not when the question was put', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await choice();
        expect(bridge.findWordByLemma).toHaveBeenCalledTimes(1);

        // Meanwhile the other form was saved, say from the lookup window.
        vi.mocked(bridge.findWordByLemma).mockResolvedValue(saved({ id: 'w-run', lemma: 'run' }));
        await pick(user, '另存为「run」');

        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');
        expect(bridge.findWordByLemma).toHaveBeenCalledTimes(2);
        expect(savedDraft().id).toBe('w-run');
      });

      it('takes a word it made back by deleting it', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await pick(user, '另存为「run」');
        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');
        const loads = vi.mocked(bridge.getAllWords).mock.calls.length;

        await user.click(screen.getByRole('button', { name: '撤销' }));

        await waitFor(() => expect(bridge.deleteWords).toHaveBeenCalledWith([savedDraft().id]));
        await waitFor(() => expect(vi.mocked(bridge.getAllWords).mock.calls.length).toBe(loads + 1));
        expect(screen.queryByText('新的解析已另存为「run」，这个词条保持原样')).not.toBeInTheDocument();
        expect(bridge.restoreWord).not.toHaveBeenCalled();
      });

      it('takes a refresh of a word that was there back by putting it as it was, keeping what the user did since', async () => {
        const user = userEvent.setup();
        const run = saved({ id: 'w-run', lemma: 'run', selection: 'run', translation: '跑', lookups: 5, note: '' });
        vi.mocked(bridge.findWordByLemma).mockResolvedValue(run);
        vi.mocked(bridge.saveWord).mockImplementation(async (word) => ({ ...word, lookups: 6 }));
        renderDetail([running(), run]);
        await shown('running');
        await user.click(reanalyzeButton());
        await pick(user, '另存为「run」');
        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');
        // The user tagged it in the meantime.
        await reloadLibrary(user, [
          running(),
          { ...savedDraft(), lookups: 6, tags: ['verbs'] } as SavedWord,
        ]);

        await user.click(screen.getByRole('button', { name: '撤销' }));

        await waitFor(() => expect(bridge.restoreWord).toHaveBeenCalledTimes(1));
        expect(vi.mocked(bridge.restoreWord).mock.calls[0][0]).toMatchObject({
          id: 'w-run',
          translation: '跑',
          lookups: 5,
          tags: ['verbs'],
        });
        expect(bridge.deleteWords).not.toHaveBeenCalled();
      });

      it('does not delete a word it made once the user has done something with it', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await pick(user, '另存为「run」');
        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');
        await reloadLibrary(user, [running(), { ...savedDraft(), note: '我后来写的' } as SavedWord]);

        await user.click(screen.getByRole('button', { name: '撤销' }));

        expect(await screen.findByText(/撤销失败：「run」在这之后被你改动过，所以没有删除/)).toBeInTheDocument();
        expect(bridge.deleteWords).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
      });

      it('says so when taking it back fails, and leaves the way back open', async () => {
        const user = userEvent.setup();
        vi.mocked(bridge.deleteWords).mockRejectedValue('database is locked');
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await pick(user, '另存为「run」');
        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');

        await user.click(screen.getByRole('button', { name: '撤销' }));

        expect(await screen.findByText(/撤销失败：database is locked/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
      });

      it('has nothing to undo for a word that was deleted in the meantime', async () => {
        const user = userEvent.setup();
        renderDetail([running()]);
        await shown('running');
        await user.click(reanalyzeButton());
        await pick(user, '另存为「run」');
        await screen.findByText('新的解析已另存为「run」，这个词条保持原样');
        await reloadLibrary(user, [running()]);

        await user.click(screen.getByRole('button', { name: '撤销' }));

        await waitFor(() =>
          expect(screen.queryByText('新的解析已另存为「run」，这个词条保持原样')).not.toBeInTheDocument(),
        );
        expect(bridge.deleteWords).not.toHaveBeenCalled();
        expect(bridge.restoreWord).not.toHaveBeenCalled();
      });
    });

    it('drops the answer on request, and nothing was saved', async () => {
      const user = userEvent.setup();
      renderDetail([running()]);
      await shown('running');
      await user.click(reanalyzeButton());

      await pick(user, '都不要');

      expect(screen.queryByRole('group', { name: /请选择怎么处理/ })).not.toBeInTheDocument();
      expect(bridge.saveWord).not.toHaveBeenCalled();
      expect(screen.getByText('旧释义')).toBeInTheDocument();
    });

    it('forgets the question when another word is shown, with nothing saved', async () => {
      const user = userEvent.setup();
      renderDetail([running(), saved({ id: 'w2', lemma: 'walk', selection: 'walk', translation: '走' })]);
      await shown('running');
      await user.click(reanalyzeButton());
      await choice();

      await user.click(screen.getByRole('button', { name: 'show-w2' }));
      await shown('walk');

      expect(screen.queryByRole('group', { name: /请选择怎么处理/ })).not.toBeInTheDocument();
      expect(bridge.saveWord).not.toHaveBeenCalled();
    });

    it('does not decide for the user when the answer comes after they have left the word', async () => {
      const user = userEvent.setup();
      let answer!: (entry: Entry) => void;
      vi.mocked(bridge.lookupWord).mockReturnValue(
        new Promise<Entry>((resolve) => {
          answer = resolve;
        }),
      );
      renderDetail([running(), saved({ id: 'w2', lemma: 'walk', selection: 'walk', translation: '走' })]);
      await shown('running');
      await user.click(reanalyzeButton());
      await user.click(screen.getByRole('button', { name: 'show-w2' }));
      await shown('walk');

      await act(async () => {
        answer(NEW_ANSWER);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(bridge.saveWord).not.toHaveBeenCalled();
      expect(bridge.findWordByLemma).not.toHaveBeenCalled();
      expect(screen.queryByRole('group', { name: /请选择怎么处理/ })).not.toBeInTheDocument();
      expect(screen.getByText('走')).toBeInTheDocument();
    });

    it('does not ask when the answer names the same form with another spelling', async () => {
      const user = userEvent.setup();
      vi.mocked(bridge.lookupWord).mockResolvedValue({ ...NEW_ANSWER, lemma: ' RUN ' } as Entry);
      renderDetail([saved({ lemma: 'Run' })]);
      await shown('Run');

      await user.click(reanalyzeButton());

      expect(await screen.findByText('已用 qwen-test 重新解析')).toBeInTheDocument();
      expect(savedDraft()).toMatchObject({ id: 'w1', lemma: 'Run' });
      expect(screen.queryByRole('group', { name: /请选择怎么处理/ })).not.toBeInTheDocument();
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

type PanelProps = Partial<ComponentProps<typeof WordDetail>>;

/** The panel of the word `w1`, as the library page shows it, with the buttons the page gives it. */
function renderPanel(words: SavedWord[] = [saved()], props: PanelProps = {}) {
  vi.mocked(bridge.getAllWords).mockResolvedValue(words);
  function Panel() {
    const { words: library } = useLexNote();
    return <WordDetail word={library.find((word) => word.id === 'w1') ?? null} inline {...props} />;
  }
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route
          path="/library"
          element={
            <LexNoteProvider>
              <Panel />
            </LexNoteProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the panel of a saved word', () => {
  beforeEach(mockBridge);

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('the level of mastery', () => {
    it('offers every level, in the order a word goes through them, and marks the one it is at', async () => {
      renderPanel([saved({ mastery: 'familiar' })]);
      await shown('run');

      const group = screen.getByRole('group', { name: '掌握度' });
      expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
        '新词',
        '巩固中',
        '熟悉',
        '已掌握',
      ]);
      expect(within(group).getByRole('button', { name: '熟悉' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(group).getByRole('button', { name: '新词' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('sets the level that is pressed, and says it was kept', async () => {
      const user = userEvent.setup();
      renderPanel([saved({ mastery: 'familiar' })]);
      await shown('run');
      const group = screen.getByRole('group', { name: '掌握度' });

      await user.click(within(group).getByRole('button', { name: '巩固中' }));

      expect(bridge.updateWord).toHaveBeenCalledWith('w1', { mastery: 'learning' });
      expect(within(group).getByRole('button', { name: '巩固中' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(group).getByRole('button', { name: '熟悉' })).toHaveAttribute('aria-pressed', 'false');
      expect(await screen.findByText('已保存')).toBeInTheDocument();
    });
  });

  describe('the tags', () => {
    // A box that offers suggestions (it has a `list`) is a combobox, not a plain text box.
    const tagBox = () => screen.getByLabelText('添加标签');

    it('can be added to a word that has none, which is lowercased and put in with Enter', async () => {
      const user = userEvent.setup();
      renderPanel([saved({ tags: [] })]);
      await shown('run');
      expect(tagBox()).toHaveAttribute('placeholder', '添加标签，回车确认');

      await user.type(tagBox(), '  Travel {Enter}');

      expect(bridge.updateWord).toHaveBeenCalledWith('w1', { tags: ['travel'] });
      expect(await screen.findByRole('button', { name: '移除标签 travel' })).toBeInTheDocument();
      expect(tagBox()).toHaveValue('');
    });

    it('is not added twice, and an empty box adds nothing', async () => {
      const user = userEvent.setup();
      renderPanel([saved({ tags: ['travel'] })]);
      await shown('run');

      await user.type(tagBox(), 'travel{Enter}');
      await user.type(tagBox(), '   {Enter}');

      expect(bridge.updateWord).not.toHaveBeenCalled();
      expect(tagBox()).toHaveValue('');
    });

    it('is exactly the text that was typed, not a suggestion that happens to start with it', async () => {
      const user = userEvent.setup();
      renderPanel([saved({ tags: [] }), saved({ id: 'w2', lemma: 'walk', selection: 'walk', tags: ['travel'] })]);
      await shown('run');

      await user.type(tagBox(), 'tra{Enter}');

      expect(bridge.updateWord).toHaveBeenCalledWith('w1', { tags: ['tra'] });
    });

    it('is offered from the tags the library has, except those the word has already', async () => {
      renderPanel([
        saved({ tags: ['travel'] }),
        saved({ id: 'w2', lemma: 'walk', selection: 'walk', tags: ['travel', 'verbs', 'daily'] }),
      ]);
      await shown('run');
      await waitFor(() => expect(document.querySelectorAll('#word-detail-tags option').length).toBeGreaterThan(0));

      const offered = Array.from(document.querySelectorAll('#word-detail-tags option')).map((option) =>
        option.getAttribute('value'),
      );
      expect([...offered].sort()).toEqual(['daily', 'verbs']);
      expect(tagBox()).toHaveAttribute('list', 'word-detail-tags');
    });

    it('can be taken off again', async () => {
      const user = userEvent.setup();
      renderPanel([saved({ tags: ['travel', 'verbs'] })]);
      await shown('run');

      await user.click(screen.getByRole('button', { name: '移除标签 travel' }));

      expect(bridge.updateWord).toHaveBeenCalledWith('w1', { tags: ['verbs'] });
    });

    it('is given up with Escape, which then does not reach the page behind that closes the panel with it', async () => {
      const user = userEvent.setup();
      const seen = vi.fn();
      window.addEventListener('keydown', seen);
      try {
        renderPanel();
        await shown('run');

        await user.type(tagBox(), 'ab{Escape}');
        expect(tagBox()).toHaveValue('');
        expect(seen.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toHaveLength(0);

        // With nothing typed there is nothing to give up: the key goes on, to close the panel.
        await user.keyboard('{Escape}');
        expect(seen.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toHaveLength(1);
      } finally {
        window.removeEventListener('keydown', seen);
      }
    });
  });

  describe('the buttons the page gives it', () => {
    it('leaves the deleting to the page, which can say what happened and offer to take it back', async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      renderPanel([saved()], { onDelete });
      await shown('run');

      await user.click(screen.getByRole('button', { name: '删除该生词' }));

      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1', lemma: 'run' }));
      expect(bridge.deleteWords).not.toHaveBeenCalled();
    });

    it('has no delete button where the page gives it no way to delete', async () => {
      renderPanel();
      await shown('run');

      expect(screen.queryByRole('button', { name: '删除该生词' })).not.toBeInTheDocument();
    });

    it('can be closed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderPanel([saved()], { onClose });
      await shown('run');

      await user.click(screen.getByRole('button', { name: '关闭详情' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('the size of the text', () => {
    const sizeBox = () => screen.getByRole('group', { name: '阅读字号' });

    it('is set by the buttons, one pixel at a time, when the page gives it the way to', async () => {
      const user = userEvent.setup();
      const onFontSizeChange = vi.fn();
      renderPanel([saved()], { fontSize: 15, onFontSizeChange });
      await shown('run');
      expect(within(sizeBox()).getByText('15')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '放大字体' }));
      await user.click(screen.getByRole('button', { name: '缩小字体' }));

      expect(onFontSizeChange).toHaveBeenNthCalledWith(1, 16);
      expect(onFontSizeChange).toHaveBeenNthCalledWith(2, 14);
    });

    it('is shown to the text of the word', async () => {
      renderPanel([saved()], { fontSize: 17, onFontSizeChange: vi.fn() });
      await shown('run');

      expect(screen.getByText('旧释义').closest('[style]')).toHaveStyle({ fontSize: '17px' });
    });

    it('cannot be made smaller than the smallest or larger than the largest size', async () => {
      const { unmount } = renderPanel([saved()], { fontSize: READER_MIN, onFontSizeChange: vi.fn() });
      await shown('run');
      expect(screen.getByRole('button', { name: '缩小字体' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '放大字体' })).toBeEnabled();
      unmount();

      renderPanel([saved()], { fontSize: READER_MAX, onFontSizeChange: vi.fn() });
      await shown('run');
      expect(screen.getByRole('button', { name: '放大字体' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '缩小字体' })).toBeEnabled();
    });

    it('has no buttons where the page gives it no way to keep the size', async () => {
      renderPanel();
      await shown('run');

      expect(screen.queryByRole('group', { name: '阅读字号' })).not.toBeInTheDocument();
    });
  });

  describe('what it says about the word', () => {
    it('tells a word that has only a meaning that it can be filled in, and a word that has more nothing', async () => {
      const { unmount } = renderPanel([saved()]);
      await shown('run');
      expect(screen.getByText(/这个词目前只有释义，还没有义项和例句/)).toBeInTheDocument();
      unmount();

      renderPanel([saved({ examples: [{ en: 'Run fast.', zh: '跑快点。' }] })]);
      await shown('run');
      expect(screen.queryByText(/这个词目前只有释义/)).not.toBeInTheDocument();
    });

    it('shows where the word was found, in what sentence', async () => {
      renderPanel([saved()]);
      await shown('run');

      expect(screen.getByRole('heading', { name: '原始上下文' })).toBeInTheDocument();
      expect(screen.getByText('“He was running late.”')).toBeInTheDocument();
      expect(screen.getByText(/Reader · /)).toBeInTheDocument();
    });

    it('says where a word came from also when it has no sentence, as one imported from a list', async () => {
      renderPanel([saved({ context: '', sourceApp: '导入' })]);
      await shown('run');

      expect(screen.getByRole('heading', { name: '来源' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '原始上下文' })).not.toBeInTheDocument();
      expect(screen.getByText(/导入 · /)).toBeInTheDocument();
    });
  });
});