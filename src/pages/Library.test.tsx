import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { SavedWord } from '../types/lexnote';
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

describe('the word list in the library', () => {
  beforeEach(() => {
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
  });

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
});
