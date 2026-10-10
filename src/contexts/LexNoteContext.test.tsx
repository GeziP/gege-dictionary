import { useRef, useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider, useLexNote } from './LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { AppSettings, SavedWord } from '../types/lexnote';
import { DEFAULT_PROVIDER } from '../data/providers';

const streamHandlers = vi.hoisted(() => ({
  error: undefined as ((event: { requestId: string; message: string }) => void) | undefined,
  delta: undefined as ((event: { requestId: string; field: string; value: string }) => void) | undefined,
}));

vi.mock('../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({}),
  getTemplates: vi.fn().mockResolvedValue([]),
  getUsage: vi.fn().mockResolvedValue({ today: 0, month: 0, tokens: 0 }),
  getStartupWarnings: vi.fn().mockResolvedValue([]),
  saveSettings: vi.fn(),
  saveTemplate: vi.fn().mockResolvedValue(undefined),
  saveAnalysisPreferences: vi.fn().mockResolvedValue(undefined),
  lookupWordStream: vi.fn(),
  lookupWord: vi.fn(),
  deleteWords: vi.fn(),
  restoreWord: vi.fn(),
  emitWordSaved: vi.fn().mockResolvedValue(undefined),
  listenLookupDone: vi.fn().mockResolvedValue(() => undefined),
  listenLookupError: vi.fn((handler) => {
    streamHandlers.error = handler;
    return Promise.resolve(() => undefined);
  }),
  listenLookupDelta: vi.fn((handler) => {
    streamHandlers.delta = handler;
    return Promise.resolve(() => undefined);
  }),
}));

function Harness() {
  const { settings, updateSettings, settingsSaveStatus, initState } = useLexNote();
  return (
    <>
      <span data-testid="theme">{settings.theme}</span>
      <span data-testid="status">{settingsSaveStatus}</span>
      <span data-testid="init-state">{initState}</span>
      <button type="button" onClick={() => updateSettings({ theme: 'dark' })}>dark</button>
      <button type="button" onClick={() => updateSettings({ autoBackup: false })}>backup-off</button>
      <button type="button" onClick={() => updateSettings({ provider: { ...settings.provider, model: 'model-a' } })}>provider-model</button>
      <button type="button" onClick={() => updateSettings({ provider: { ...settings.provider, apiKey: 'key-b' } })}>provider-key</button>
      <button type="button" onClick={() => {
        updateSettings({ provider: { model: 'model-a' } });
        updateSettings({ provider: { apiKey: 'key-b' } });
      }}>provider-batch</button>
    </>
  );
}

function LookupHarness() {
  const { triggerLookup, lookupStatus, lookupError, lookupResult } = useLexNote();
  return (
    <>
      <span data-testid="lookup-status">{lookupStatus}</span>
      <span data-testid="lookup-error">{lookupError}</span>
      <span data-testid="lookup-result">{lookupResult?.translation || ''}</span>
      <button type="button" onClick={() => triggerLookup('term', '', 'word')}>lookup</button>
    </>
  );
}

function RetryHarness() {
  const { triggerLookup, retryLookup } = useLexNote();
  return (
    <>
      <button type="button" onClick={() => triggerLookup(' a b c d e\n', 'ctx', 'phrase')}>lookup</button>
      <button type="button" onClick={() => retryLookup()}>retry</button>
    </>
  );
}

function UsageHarness() {
  const { usage } = useLexNote();
  return <span data-testid="usage-today">{usage.today}</span>;
}

describe('settings persistence', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Some of the tests below put a promise that never settles in place of these for good, which
    // must not reach the tests that come after them.
    vi.mocked(bridge.getSettings).mockResolvedValue({} as never);
    vi.mocked(bridge.saveSettings).mockReset();
    streamHandlers.error = undefined;
    streamHandlers.delta = undefined;
  });

  it('serializes writes and rolls back the optimistic UI on failure', async () => {
    let rejectSave: ((reason?: unknown) => void) | undefined;
    vi.mocked(bridge.saveSettings).mockImplementationOnce(() => new Promise<void>((_, reject) => {
      rejectSave = reject;
    }));
    render(<LexNoteProvider><Harness /></LexNoteProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    rejectSave?.(new Error('disk is read-only'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });

  it('rebases a later successful patch after an earlier save fails', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    let secondPayload: AppSettings | undefined;
    vi.mocked(bridge.saveSettings)
      .mockImplementationOnce(() => new Promise<void>((_, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce((next) => {
        secondPayload = next;
        return Promise.resolve();
      });

    render(<LexNoteProvider><Harness /></LexNoteProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    await userEvent.click(screen.getByRole('button', { name: 'backup-off' }));
    rejectFirst?.(new Error('first save failed'));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(secondPayload?.theme).toBe('system');
    expect(secondPayload?.autoBackup).toBe(false);
  });

  it('rebases nested provider fields without resurrecting a failed field', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    let secondPayload: AppSettings | undefined;
    vi.mocked(bridge.saveSettings)
      .mockImplementationOnce(() => new Promise<void>((_, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce((next) => {
        secondPayload = next;
        return Promise.resolve();
      });

    render(<LexNoteProvider><Harness /></LexNoteProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'provider-model' }));
    await userEvent.click(screen.getByRole('button', { name: 'provider-key' }));
    rejectFirst?.(new Error('provider save failed'));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(2));
    expect(secondPayload?.provider.model).toBe(DEFAULT_PROVIDER.model);
    expect(secondPayload?.provider.apiKey).toBe('key-b');
  });

  it('preserves nested provider changes from one batched UI event', async () => {
    let resolveFirst: (() => void) | undefined;
    let secondPayload: AppSettings | undefined;
    vi.mocked(bridge.saveSettings)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce((next) => {
        secondPayload = next;
        return Promise.resolve();
      });

    render(<LexNoteProvider><Harness /></LexNoteProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'provider-batch' }));
    resolveFirst?.();

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(2));
    expect(secondPayload?.provider.model).toBe('model-a');
    expect(secondPayload?.provider.apiKey).toBe('key-b');
  });

  it('does not let stale startup rehydration overwrite a newer setting patch', async () => {
    let resolveSettings: ((value: Partial<AppSettings>) => void) | undefined;
    let resolveSave: (() => void) | undefined;
    vi.mocked(bridge.getSettings).mockImplementation(() => new Promise<AppSettings>((resolve) => {
      resolveSettings = (value) => resolve(value as AppSettings);
    }));
    vi.mocked(bridge.saveSettings).mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));

    render(<LexNoteProvider><Harness /></LexNoteProvider>);
    await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    resolveSettings?.({ theme: 'system' });

    await waitFor(() => expect(screen.getByTestId('init-state')).toHaveTextContent('ready'));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    resolveSave?.();
  });

  it('keeps one retryable terminal error when a stream event races invoke rejection', async () => {
    vi.mocked(bridge.lookupWordStream).mockImplementationOnce(async (_selection, _context, _kind, requestId) => {
      streamHandlers.delta?.({ requestId, field: 'translation', value: 'partial' });
      streamHandlers.error?.({ requestId, message: 'provider disconnected' });
      streamHandlers.error?.({ requestId, message: 'late terminal event' });
      streamHandlers.delta?.({ requestId, field: 'translation', value: 'late delta' });
      throw new Error('invoke rejected after terminal event');
    });

    render(<LexNoteProvider><LookupHarness /></LexNoteProvider>);
    await waitFor(() => expect(streamHandlers.error).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'lookup' }));

    await waitFor(() => expect(screen.getByTestId('lookup-status')).toHaveTextContent('error'));
    expect(screen.getByTestId('lookup-error')).toHaveTextContent('provider disconnected');
    expect(screen.getByTestId('lookup-error')).not.toHaveTextContent('invoke rejected');
    expect(screen.getByTestId('lookup-result')).toBeEmptyDOMElement();
    expect(bridge.lookupWordStream).toHaveBeenCalledTimes(1);
    expect(bridge.lookupWord).not.toHaveBeenCalled();
  });

  it('keeps incremental fields visible while a stream is still open', async () => {
    vi.mocked(bridge.lookupWordStream).mockImplementationOnce(async (_selection, _context, _kind, requestId) => {
      streamHandlers.delta?.({ requestId, field: 'translation', value: 'partial result' });
    });

    render(<LexNoteProvider><LookupHarness /></LexNoteProvider>);
    await waitFor(() => expect(streamHandlers.delta).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'lookup' }));

    await waitFor(() => expect(screen.getByTestId('lookup-status')).toHaveTextContent('streaming'));
    expect(screen.getByTestId('lookup-result')).toHaveTextContent('partial result');
  });

  it('retries a failed lookup as the kind it was first looked up as, not a recount of its words', async () => {
    // Five words with stray whitespace: the backend calls this a phrase, while splitting on
    // /\s+/ finds six pieces and would have called it a sentence.
    vi.mocked(bridge.lookupWordStream)
      .mockRejectedValueOnce(new Error('[network] down'))
      .mockRejectedValueOnce(new Error('[network] still down'));
    render(<LexNoteProvider><RetryHarness /></LexNoteProvider>);
    await waitFor(() => expect(streamHandlers.error).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'lookup' }));
    await waitFor(() => expect(bridge.lookupWordStream).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'retry' }));

    await waitFor(() => expect(bridge.lookupWordStream).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(bridge.lookupWordStream).mock.calls;
    expect(second.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(second[2]).toBe('phrase');
  });
});

describe('usage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('picks up lookups counted by the backend when the window regains focus', async () => {
    render(<LexNoteProvider><UsageHarness /></LexNoteProvider>);
    await waitFor(() => expect(bridge.getUsage).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('usage-today')).toHaveTextContent('0');
    vi.mocked(bridge.getUsage).mockResolvedValueOnce({ today: 3, month: 9, tokens: 1500 });

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(screen.getByTestId('usage-today')).toHaveTextContent('3'));
  });

  it('does not poll for usage from the small lookup window, which shows none', async () => {
    render(<LexNoteProvider loadWords={false}><UsageHarness /></LexNoteProvider>);
    await waitFor(() => expect(bridge.getUsage).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(bridge.getUsage).toHaveBeenCalledTimes(1);
  });
});

const stored = (id: string, lemma: string): SavedWord =>
  ({
    id,
    lemma,
    selection: lemma,
    translation: `${lemma}的释义`,
    kind: 'word',
    tags: [],
    mastery: 'new',
    lookups: 1,
    note: '',
    savedAt: '2026-10-05T08:00:00Z',
  }) as unknown as SavedWord;

const LIBRARY = [stored('a', 'alpha'), stored('b', 'beta'), stored('c', 'gamma')];

function WordsHarness() {
  const { words, removeWords, restoreWords } = useLexNote();
  const taken = useRef<SavedWord[]>([]);
  const [outcome, setOutcome] = useState('');
  return (
    <>
      <ul>
        {words.map((word) => (
          <li key={word.id}>{word.lemma}</li>
        ))}
      </ul>
      <span data-testid="outcome">{outcome}</span>
      <button
        type="button"
        onClick={() => {
          removeWords(['a', 'b']).then(
            (removed) => {
              taken.current = removed;
              setOutcome(`removed ${removed.map((word) => word.lemma).join(',')}`);
            },
            (error) => setOutcome(`remove failed: ${String(error)}`),
          );
        }}
      >
        remove
      </button>
      <button
        type="button"
        onClick={() => {
          restoreWords(taken.current).then(
            () => setOutcome('restored'),
            (error) => setOutcome(`restore failed: ${String(error)}`),
          );
        }}
      >
        restore
      </button>
    </>
  );
}

describe('removing words and putting them back', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.deleteWords).mockReset();
    vi.mocked(bridge.restoreWord).mockReset();
  });

  const start = async () => {
    vi.mocked(bridge.getAllWords).mockResolvedValue(LIBRARY);
    render(
      <LexNoteProvider>
        <WordsHarness />
      </LexNoteProvider>,
    );
    await screen.findByText('gamma');
  };
  const remove = () => userEvent.click(screen.getByRole('button', { name: 'remove' }));
  const restore = () => userEvent.click(screen.getByRole('button', { name: 'restore' }));

  it('takes the words off the list at once, and hands back what it took, for an undo', async () => {
    let confirm!: () => void;
    vi.mocked(bridge.deleteWords).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    await start();

    await remove();

    await waitFor(() => expect(screen.queryByText('alpha')).not.toBeInTheDocument());
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(screen.getByText('gamma')).toBeInTheDocument();
    // The backend has not answered yet: nothing is said to the other windows or to the caller.
    expect(screen.getByTestId('outcome')).toBeEmptyDOMElement();
    expect(bridge.emitWordSaved).not.toHaveBeenCalled();

    await act(async () => confirm());

    expect(await screen.findByText('removed alpha,beta')).toBeInTheDocument();
    expect(bridge.deleteWords).toHaveBeenCalledWith(['a', 'b']);
    expect(bridge.emitWordSaved).toHaveBeenCalledTimes(1);
  });

  it('shows the words again, loaded from the backend, and says why, when the backend refuses', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(bridge.deleteWords).mockRejectedValue('database is locked');
    await start();
    const loads = vi.mocked(bridge.getAllWords).mock.calls.length;

    await remove();

    expect(await screen.findByText('remove failed: database is locked')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(bridge.getAllWords).mock.calls.length).toBe(loads + 1));
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(bridge.emitWordSaved).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('puts the words back one after another, and tells the other windows once', async () => {
    vi.mocked(bridge.deleteWords).mockResolvedValue(undefined);
    vi.mocked(bridge.restoreWord).mockResolvedValue(undefined);
    await start();
    await remove();
    await screen.findByText('removed alpha,beta');
    vi.mocked(bridge.emitWordSaved).mockClear();

    await restore();

    expect(await screen.findByText('restored')).toBeInTheDocument();
    expect(vi.mocked(bridge.restoreWord).mock.calls.map(([word]) => word.lemma)).toEqual(['alpha', 'beta']);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(bridge.emitWordSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps the words it did put back when a later one fails, and still tells the other windows', async () => {
    vi.mocked(bridge.deleteWords).mockResolvedValue(undefined);
    vi.mocked(bridge.restoreWord).mockResolvedValueOnce(undefined).mockRejectedValueOnce('database is locked');
    await start();
    await remove();
    await screen.findByText('removed alpha,beta');
    vi.mocked(bridge.emitWordSaved).mockClear();

    await restore();

    expect(await screen.findByText('restore failed: database is locked')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(bridge.emitWordSaved).toHaveBeenCalledTimes(1);
  });

  it('has nothing to do for nothing to restore', async () => {
    await start();

    await restore();

    expect(await screen.findByText('restored')).toBeInTheDocument();
    expect(bridge.restoreWord).not.toHaveBeenCalled();
    expect(bridge.emitWordSaved).not.toHaveBeenCalled();
  });
});

function SaveErrorHarness() {
  const { updateSettings, settingsSaveStatus, settingsSaveError, dismissSettingsSaveError } = useLexNote();
  return (
    <>
      <span data-testid="status">{settingsSaveStatus}</span>
      <span data-testid="reason">{settingsSaveError ?? ''}</span>
      <button type="button" onClick={() => updateSettings({ theme: 'dark' })}>dark</button>
      <button type="button" onClick={dismissSettingsSaveError}>dismiss</button>
    </>
  );
}

describe('a settings change that was not kept', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSaveErrors = () =>
    render(
      <LexNoteProvider>
        <SaveErrorHarness />
      </LexNoteProvider>,
    );

  it('says why, without the name of the error class, until it is put away', async () => {
    vi.mocked(bridge.saveSettings).mockRejectedValueOnce(new Error('disk is read-only'));
    renderSaveErrors();

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('reason')).toHaveTextContent(/^disk is read-only$/);

    await userEvent.click(screen.getByRole('button', { name: 'dismiss' }));

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('reason')).toBeEmptyDOMElement();
  });

  it('takes the reason the backend sends as a plain string as it is', async () => {
    vi.mocked(bridge.saveSettings).mockRejectedValueOnce('settings.json 被占用');
    renderSaveErrors();

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));

    await waitFor(() => expect(screen.getByTestId('reason')).toHaveTextContent(/^settings\.json 被占用$/));
  });

  it('does not put away a save that is still going on', async () => {
    let finish!: () => void;
    vi.mocked(bridge.saveSettings).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderSaveErrors();
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(screen.getByTestId('status')).toHaveTextContent('saving');

    await userEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.getByTestId('status')).toHaveTextContent('saving');

    await act(async () => finish());
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('idle'));
  });

  it('is forgotten when the next change is made', async () => {
    vi.mocked(bridge.saveSettings).mockRejectedValueOnce('disk is read-only').mockResolvedValueOnce(undefined);
    renderSaveErrors();
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('idle'));
    expect(screen.getByTestId('reason')).toBeEmptyDOMElement();
  });
});