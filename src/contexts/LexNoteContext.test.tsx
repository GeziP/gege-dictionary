import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider, useLexNote } from './LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { AppSettings } from '../types/lexnote';
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

describe('settings persistence', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
});
