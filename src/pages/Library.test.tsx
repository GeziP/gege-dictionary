import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { EnrichmentProgress, EnrichmentStatus, SavedWord } from '../types/lexnote';
import { Library } from './Library';

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
  listenWordSaved: vi.fn(),
  getReviewStats: vi.fn(),
  getEnrichmentStatus: vi.fn(),
  startEnrichment: vi.fn(),
  pauseEnrichment: vi.fn(),
  resumeEnrichment: vi.fn(),
  stopEnrichment: vi.fn(),
  listenEnrichmentProgress: vi.fn(),
  deleteWords: vi.fn(),
  restoreWord: vi.fn(),
  updateWord: vi.fn(),
  emitWordSaved: vi.fn(),
  previewWordImport: vi.fn(),
  importWords: vi.fn(),
}));

const IDLE: EnrichmentProgress = {
  run: 0,
  state: 'idle',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  tokens: 0,
  current: null,
  stoppedBecause: null,
  failures: [],
};
const RUNNING: EnrichmentProgress = { ...IDLE, run: 1, state: 'running', total: 2, current: 'alpha' };
const enrichmentStatus = (progress: EnrichmentProgress = IDLE): EnrichmentStatus => ({
  pending: 2,
  tokensToday: 0,
  dailyLimit: 100_000,
  progress,
});

const word = (lemma: string, overrides: Record<string, unknown> = {}): SavedWord =>
  ({
    id: lemma,
    selection: lemma,
    lemma,
    pos: 'n.',
    ipaUS: '',
    ipaUK: '',
    translation: `${lemma}的释义`,
    contextMeaning: '',
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
    ...overrides,
  }) as unknown as SavedWord;

const WORDS = [
  word('alpha'),
  word('beta'),
  word('livelock', { examples: [{ en: 'Both threads keep spinning forever.', zh: '两个线程不停空转。' }] }),
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <LexNoteProvider>
        <Routes>
          <Route path="/library" element={<Library />} />
        </Routes>
      </LexNoteProvider>
    </MemoryRouter>,
  );
}

const pick = (lemma: string) => screen.getByRole('checkbox', { name: `选择 ${lemma}` });
const pickAll = () => screen.getByRole('checkbox', { name: '全选当前列表' });
// The count beside the search box. The sidebar states the size of the whole library in the same
// words, so the text alone would match two elements.
const listCount = (text: string) => screen.getByText(text, { selector: 'p[aria-live="polite"]' });

/** What the backend answers, for the tests of this file. */
function mockBackend() {
  vi.mocked(bridge.getAllWords).mockResolvedValue(WORDS);
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
  vi.mocked(bridge.listenWordSaved).mockResolvedValue(() => undefined);
  vi.mocked(bridge.getReviewStats).mockResolvedValue({ dueCount: 0, boxCounts: [0, 0, 0], total: 3 });
  vi.mocked(bridge.getEnrichmentStatus).mockResolvedValue(enrichmentStatus());
  vi.mocked(bridge.listenEnrichmentProgress).mockResolvedValue(() => undefined);
  vi.mocked(bridge.startEnrichment).mockResolvedValue(RUNNING);
  vi.mocked(bridge.deleteWords).mockResolvedValue(undefined);
  vi.mocked(bridge.restoreWord).mockResolvedValue(undefined);
  vi.mocked(bridge.emitWordSaved).mockResolvedValue(undefined);
}

describe('the word list in the library', () => {
  beforeEach(mockBackend);

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('narrows to the words that the typed text is found in, an example included', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    expect(listCount('3 条')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox'), 'spinning');

    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).not.toBeInTheDocument());
    expect(pick('livelock')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择 beta' })).not.toBeInTheDocument();
    expect(listCount('1 / 3 条')).toBeInTheDocument();
  });

  it('says that nothing matches, and brings the words back when the text is cleared', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });

    const search = screen.getByRole('searchbox');
    await userEvent.type(search, 'zzz');
    expect(await screen.findByText('没有匹配的生词')).toBeInTheDocument();

    await userEvent.clear(search);
    expect(await screen.findByRole('checkbox', { name: '选择 alpha' })).toBeInTheDocument();
    expect(listCount('3 条')).toBeInTheDocument();
  });

  it('selects every listed word with the box in the header, and clears them with it again', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    expect(pickAll()).not.toBeChecked();

    await userEvent.click(pickAll());
    expect(pick('alpha')).toBeChecked();
    expect(pick('beta')).toBeChecked();
    expect(pick('livelock')).toBeChecked();
    expect(pickAll()).toBeChecked();
    expect(screen.getByText('已选 3 条')).toBeInTheDocument();

    await userEvent.click(pickAll());
    expect(pick('alpha')).not.toBeChecked();
    expect(pickAll()).not.toBeChecked();
    await waitFor(() => expect(screen.queryByText(/已选/)).not.toBeInTheDocument());
  });

  it('is not fooled into "all selected" by words that are selected but not listed', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });

    // One word is chosen, then the list is narrowed to another one: one selected, one listed.
    await userEvent.click(pick('alpha'));
    const search = screen.getByRole('searchbox');
    await userEvent.type(search, 'beta');
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).not.toBeInTheDocument());
    expect(pick('beta')).not.toBeChecked();
    expect(pickAll()).not.toBeChecked();

    // The box in the header takes the listed word and leaves the choice made earlier alone.
    await userEvent.click(pickAll());
    expect(pick('beta')).toBeChecked();
    expect(pickAll()).toBeChecked();
    expect(screen.getByText('已选 2 条')).toBeInTheDocument();

    await userEvent.clear(search);
    expect(await screen.findByRole('checkbox', { name: '选择 alpha' })).toBeChecked();
    expect(pick('beta')).toBeChecked();
    expect(pick('livelock')).not.toBeChecked();
    expect(pickAll()).not.toBeChecked();

    // With everything listed again, the box takes out the listed words, which is all of them.
    await userEvent.click(pickAll());
    expect(pickAll()).toBeChecked();
    await userEvent.click(pickAll());
    expect(pick('alpha')).not.toBeChecked();
    expect(pick('beta')).not.toBeChecked();
    expect(pick('livelock')).not.toBeChecked();
  });

  describe('filling in the words that have only a meaning', () => {
    it('offers to do it for all of them, which are the ones without senses and examples', async () => {
      vi.mocked(bridge.startEnrichment).mockImplementation(async () => {
        // The backend is running now, and says so from here on.
        vi.mocked(bridge.getEnrichmentStatus).mockResolvedValue(enrichmentStatus(RUNNING));
        return RUNNING;
      });
      renderPage();

      expect(await screen.findByText('2 个词还没有义项和例句')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '开始补全' }));

      expect(bridge.startEnrichment).toHaveBeenCalledTimes(1);
      expect(bridge.startEnrichment).toHaveBeenCalledWith(undefined);
      expect(await screen.findByText('正在补全生词')).toBeInTheDocument();
    });

    it('offers to do it for the selected words that are bare, and only for those', async () => {
      renderPage();
      await screen.findByRole('checkbox', { name: '选择 alpha' });

      await userEvent.click(pick('alpha'));
      await userEvent.click(pick('livelock'));
      expect(await screen.findByRole('button', { name: '补全所选（1）' })).toBeEnabled();
      await userEvent.click(screen.getByRole('button', { name: '补全所选（1）' }));

      expect(bridge.startEnrichment).toHaveBeenCalledWith(['alpha']);
    });

    it('offers nothing for a selection in which no word is bare', async () => {
      renderPage();
      await screen.findByRole('checkbox', { name: '选择 alpha' });

      await userEvent.click(pick('livelock'));

      expect(await screen.findByText('已选 1 条')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /补全所选/ })).not.toBeInTheDocument();
    });

    it('does not start a second batch from the selection while one is going on', async () => {
      vi.mocked(bridge.getEnrichmentStatus).mockResolvedValue(enrichmentStatus(RUNNING));
      renderPage();
      await screen.findByText('正在补全生词');

      await userEvent.click(pick('beta'));

      const button = await screen.findByRole('button', { name: '补全所选（1）' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', '已经有一轮补全在进行，请先暂停或停止它');
    });

    it('says nothing when every word has its senses or examples', async () => {
      vi.mocked(bridge.getAllWords).mockResolvedValue([WORDS[2]]);
      vi.mocked(bridge.getEnrichmentStatus).mockResolvedValue({ ...enrichmentStatus(), pending: 0 });
      renderPage();
      await screen.findByRole('checkbox', { name: '选择 livelock' });

      expect(screen.queryByText(/还没有义项和例句/)).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '批量补全' })).not.toBeInTheDocument();
    });
  });
});

// Opens the panel of a word by its name in the list, and finds that panel.
const open = (lemma: string) => userEvent.click(screen.getByRole('button', { name: new RegExp(`^${lemma}`) }));
const panel = (lemma: string) => screen.findByRole('dialog', { name: `词条详情：${lemma}` });
const anyPanel = () => screen.queryByRole('dialog', { name: /词条详情/ });

describe('the panel of a word', () => {
  beforeEach(mockBackend);

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('opens over the list, with the keyboard inside it', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });

    await open('alpha');

    const dialog = await panel('alpha');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('is put away with Escape, and the keyboard goes back to the word it came from', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    const opener = screen.getByRole('button', { name: /^alpha/ });
    await userEvent.click(opener);
    await panel('alpha');

    await userEvent.keyboard('{Escape}');

    expect(anyPanel()).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('is not put away by the Escape that gives up a note being written, which only gives that up', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await open('alpha');
    await panel('alpha');
    await userEvent.click(screen.getByRole('button', { name: '编辑个人笔记' }));
    const note = await screen.findByRole('textbox', { name: '编辑个人笔记' });
    await userEvent.type(note, '写到一半');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('textbox', { name: '编辑个人笔记' })).not.toBeInTheDocument();
    expect(anyPanel()).toBeInTheDocument();
    expect(bridge.updateWord).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');
    expect(anyPanel()).not.toBeInTheDocument();
  });

  it('is kept at the size the user chose for the text, in the settings', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await open('alpha');
    await panel('alpha');

    await userEvent.click(screen.getByRole('button', { name: '放大字体' }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 14 })));
    expect(within(screen.getByRole('group', { name: '阅读字号' })).getByText('14')).toBeInTheDocument();
  });

  it('is closed, and the word dropped from the selection, when the word is deleted somewhere else', async () => {
    let wordSaved: (() => void) | undefined;
    vi.mocked(bridge.listenWordSaved).mockImplementation(async (handler) => {
      wordSaved = handler;
      return () => undefined;
    });
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await waitFor(() => expect(wordSaved).toBeDefined());
    await userEvent.click(pick('beta'));
    await open('alpha');
    await panel('alpha');
    expect(screen.getByText('已选 1 条')).toBeInTheDocument();

    // The lookup window deleted both of them.
    vi.mocked(bridge.getAllWords).mockResolvedValue([WORDS[2]]);
    await act(async () => {
      wordSaved?.();
    });

    await waitFor(() => expect(anyPanel()).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(/已选/)).not.toBeInTheDocument());
    expect(listCount('1 条')).toBeInTheDocument();
  });
});

describe('deleting words', () => {
  beforeEach(mockBackend);

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  const deleteOpenWord = () => userEvent.click(screen.getByRole('button', { name: '删除该生词' }));

  it('deletes the open word, closes its panel, and offers to take that back', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await open('alpha');
    await panel('alpha');

    await deleteOpenWord();

    expect(bridge.deleteWords).toHaveBeenCalledWith(['alpha']);
    expect(await screen.findByText('已删除「alpha」')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).not.toBeInTheDocument();
    expect(anyPanel()).not.toBeInTheDocument();
    expect(listCount('2 条')).toBeInTheDocument();
  });

  it('puts the word back with the undo, and says that its review starts again', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await open('alpha');
    await panel('alpha');
    await deleteOpenWord();

    await userEvent.click(await screen.findByRole('button', { name: '撤销' }));

    expect(await screen.findByText('已恢复「alpha」，复习进度重新开始')).toBeInTheDocument();
    expect(bridge.restoreWord).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'alpha', lemma: 'alpha', translation: 'alpha的释义' }),
    );
    expect(await screen.findByRole('checkbox', { name: '选择 alpha' })).toBeInTheDocument();
    expect(listCount('3 条')).toBeInTheDocument();
    // The notice with the button fades out as the next one comes.
    await waitFor(() => expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument());
  });

  it('does not promise a review that starts again for a sentence, which has none', async () => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([word('sent', { kind: 'sentence' }), ...WORDS]);
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 sent' });
    await open('sent');
    await panel('sent');
    await deleteOpenWord();

    await userEvent.click(await screen.findByRole('button', { name: '撤销' }));

    expect(await screen.findByText('已恢复「sent」')).toBeInTheDocument();
  });

  it('deletes the selected words, says how many, and puts them all back with the undo', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await userEvent.click(pick('alpha'));
    await userEvent.click(pick('beta'));

    await userEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(bridge.deleteWords).toHaveBeenCalledWith(['alpha', 'beta']);
    expect(await screen.findByText('已删除 2 条生词')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/已选/)).not.toBeInTheDocument());
    expect(listCount('1 条')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '撤销' }));

    expect(await screen.findByText('已恢复 2 条生词，复习进度重新开始')).toBeInTheDocument();
    expect(vi.mocked(bridge.restoreWord).mock.calls.map(([restored]) => restored.lemma)).toEqual(['alpha', 'beta']);
    expect(listCount('3 条')).toBeInTheDocument();
  });

  it('says why, and shows the words again, when the backend refuses to delete them', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(bridge.deleteWords).mockRejectedValue('database is locked');
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await open('alpha');
    await panel('alpha');

    await deleteOpenWord();

    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败：database is locked');
    expect(await screen.findByRole('checkbox', { name: '选择 alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    log.mockRestore();
  });

  it('says why when the word cannot be put back', async () => {
    vi.mocked(bridge.restoreWord).mockRejectedValue('database is locked');
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await open('alpha');
    await panel('alpha');
    await deleteOpenWord();

    await userEvent.click(await screen.findByRole('button', { name: '撤销' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('恢复失败：database is locked');
    expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).not.toBeInTheDocument();
  });
});

describe('a library with nothing in it', () => {
  beforeEach(() => {
    mockBackend();
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('says how words get here, instead of showing an empty table and filters', async () => {
    renderPage();

    expect(await screen.findByText('生词库还是空的')).toBeInTheDocument();
    expect(screen.getByText(/按 Ctrl\+C 复制/)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText('没有匹配的生词')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('names the keys the user has chosen to look words up with', async () => {
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
      clipboardMode: 'double',
    } as never);
    renderPage();

    expect(await screen.findByText(/连按两次 Ctrl\+C/)).toBeInTheDocument();
  });

  it('says that looking words up by selecting is off, and where to turn it on, when it is', async () => {
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
      clipboardWatch: false,
    } as never);
    renderPage();

    expect(await screen.findByText(/「划词即查」现在是关闭的/)).toBeInTheDocument();
    const page = screen.getByRole('main', { name: '生词库' });
    expect(within(page).getByRole('link', { name: '设置' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByText(/按 Ctrl\+C 复制/)).not.toBeInTheDocument();
  });

  it('offers to import a word list, which shows the words and counts again those that need filling in', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue({
      columns: ['word'],
      rows: [['alpha']],
      totalRows: 1,
      errors: [],
      format: 'csv',
    });
    vi.mocked(bridge.importWords).mockImplementation(async () => {
      // From here on, the database has the word.
      vi.mocked(bridge.getAllWords).mockResolvedValue([WORDS[0]]);
      return { inserted: 1, merged: 0, skipped: 0, errors: [] };
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '导入已有词表' }));
    const dialog = await screen.findByRole('dialog', { name: '导入词表' });
    await userEvent.upload(
      within(dialog).getByLabelText(/CSV/i),
      new File(['word\nalpha\n'], 'words.csv', { type: 'text/csv' }),
    );
    const start = within(dialog).getByRole('button', { name: '开始导入' });
    await waitFor(() => expect(start).toBeEnabled());
    const statusReads = vi.mocked(bridge.getEnrichmentStatus).mock.calls.length;

    await userEvent.click(start);

    expect(await screen.findByText('新增 1 条，合并 0 条，跳过 0 条')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: '选择 alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '导入词表' })).not.toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(bridge.getEnrichmentStatus).mock.calls.length).toBeGreaterThan(statusReads));
  });
});

describe('a search that finds nothing', () => {
  beforeEach(mockBackend);

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('offers to put the search away, which brings the words back', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('没有匹配的生词')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '清除搜索和筛选' }));

    expect(await screen.findByRole('checkbox', { name: '选择 alpha' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(listCount('3 条')).toBeInTheDocument();
  });
});

describe('the views of the library', () => {
  beforeEach(mockBackend);

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('are tabs for the words, the sessions and the history, with the words open', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: '选择 alpha' });

    const tabs = within(screen.getByRole('tablist', { name: '生词库视图' })).getAllByRole('tab');

    expect(tabs.map((tab) => tab.textContent)).toEqual(['词条', '会话', '历史']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  });
});