import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import type { EnrichmentProgress, EnrichmentStatus } from '../types/lexnote';
import { useEnrichment } from './useEnrichment';

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
  getEnrichmentStatus: vi.fn(),
  startEnrichment: vi.fn(),
  pauseEnrichment: vi.fn(),
  resumeEnrichment: vi.fn(),
  stopEnrichment: vi.fn(),
  listenEnrichmentProgress: vi.fn(),
}));

const progress = (overrides: Partial<EnrichmentProgress> = {}): EnrichmentProgress => ({
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
  ...overrides,
});

const status = (overrides: Partial<EnrichmentStatus> = {}): EnrichmentStatus => ({
  pending: 12,
  tokensToday: 3_000,
  dailyLimit: 100_000,
  progress: progress(),
  ...overrides,
});

const wrapper = ({ children }: { children: React.ReactNode }) => <LexNoteProvider>{children}</LexNoteProvider>;

/**
 * The backend, as far as the hook can tell: what it would say about itself now, and the way it
 * reaches the hook with news (the listener the hook gave, and the call that removes it).
 */
let backend: EnrichmentStatus;
let report: (progress: EnrichmentProgress) => void;
const unlisten = vi.fn();

/** The backend moves on to `next` and says so. */
const tell = (next: EnrichmentProgress, rest: Partial<EnrichmentStatus> = {}) => {
  backend = { ...backend, ...rest, progress: next };
  act(() => report(next));
};

/** A command that the backend carries out, ending up in `next`. */
const answeringWith = (next: EnrichmentProgress) => async () => {
  backend = { ...backend, progress: next };
  return next;
};

const calls = (fn: unknown) => vi.mocked(fn as () => unknown).mock.calls.length;
const loaded = async (result: { current: { status: EnrichmentStatus | null } }) => {
  await waitFor(() => expect(result.current.status).not.toBeNull());
  // The library reads its words once when it starts; wait for that to be over.
  await waitFor(() => expect(calls(bridge.getAllWords)).toBeGreaterThan(0));
};

describe('what the library knows about the batch enrichment', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    backend = status();
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getSettings).mockResolvedValue({ provider: { model: 'm', apiKey: 'k' } } as never);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.listenLookupDone).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    vi.mocked(bridge.getEnrichmentStatus).mockImplementation(async () => backend);
    vi.mocked(bridge.listenEnrichmentProgress).mockImplementation(async (handler) => {
      report = handler;
      return unlisten;
    });
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    unlisten.mockReset();
  });

  it('asks the backend how things stand when the library opens, and says nothing before it has answered', async () => {
    const { result } = renderHook(() => useEnrichment(), { wrapper });
    expect(result.current.status).toBeNull();

    await loaded(result);

    expect(result.current.status?.pending).toBe(12);
    expect(result.current.status?.dailyLimit).toBe(100_000);
    expect(result.current.error).toBe('');
    expect(result.current.dismissed).toBe(true); // there has been no run yet: nothing to put away
  });

  it('says why the figures could not be had', async () => {
    vi.mocked(bridge.getEnrichmentStatus).mockRejectedValue('数据库暂时不可用');

    const { result } = renderHook(() => useEnrichment(), { wrapper });

    await waitFor(() => expect(result.current.error).toBe('数据库暂时不可用'));
    expect(result.current.status).toBeNull();
  });

  it('shows the progress that the backend reports, and asks again for the rest when the state changes', async () => {
    const { result } = renderHook(() => useEnrichment(), { wrapper });
    await loaded(result);
    expect(calls(bridge.getEnrichmentStatus)).toBe(1);

    tell(progress({ run: 1, state: 'running', total: 12, done: 1, current: 'ephemeral' }));

    expect(result.current.status?.progress).toMatchObject({ state: 'running', done: 1, current: 'ephemeral' });
    await waitFor(() => expect(calls(bridge.getEnrichmentStatus)).toBe(2));
  });

  it('does not ask for the figures at every word of a run', async () => {
    const { result } = renderHook(() => useEnrichment(), { wrapper });
    await loaded(result);

    tell(progress({ run: 1, state: 'running', total: 12, done: 0 }));
    await waitFor(() => expect(calls(bridge.getEnrichmentStatus)).toBe(2));
    for (let done = 1; done <= 5; done += 1) {
      tell(progress({ run: 1, state: 'running', total: 12, done }));
    }

    expect(result.current.status?.progress.done).toBe(5);
    expect(calls(bridge.getEnrichmentStatus)).toBe(2);
  });

  it('reads the library again for the words that were filled in, now and then and when the run ends', async () => {
    const { result } = renderHook(() => useEnrichment(), { wrapper });
    await loaded(result);
    const initial = calls(bridge.getAllWords);

    tell(progress({ run: 1, state: 'running', total: 12, done: 1 }));
    await waitFor(() => expect(calls(bridge.getAllWords)).toBe(initial + 1));
    // The next words come within the quarter minute: they are not read for one by one.
    tell(progress({ run: 1, state: 'running', total: 12, done: 2 }));
    tell(progress({ run: 1, state: 'running', total: 12, done: 3 }));
    expect(calls(bridge.getAllWords)).toBe(initial + 1);

    tell(progress({ run: 1, state: 'finished', total: 12, done: 3 }));
    await waitFor(() => expect(calls(bridge.getAllWords)).toBe(initial + 2));
  });

  describe('news and answers that cross each other', () => {
    it('keeps the progress that was reported while a question was on its way', async () => {
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);

      let answer: (value: EnrichmentStatus) => void = () => undefined;
      vi.mocked(bridge.getEnrichmentStatus).mockImplementationOnce(
        () => new Promise<EnrichmentStatus>((resolve) => (answer = resolve)),
      );
      tell(progress({ run: 1, state: 'running', total: 12, done: 0 }));
      await waitFor(() => expect(calls(bridge.getEnrichmentStatus)).toBe(2));

      // The words go on while the answer is on its way. It is about how it was when it was asked.
      tell(progress({ run: 1, state: 'running', total: 12, done: 4 }));
      await act(async () => {
        answer(status({ pending: 10, progress: progress({ run: 1, state: 'running', total: 12, done: 0 }) }));
      });

      expect(result.current.status?.pending).toBe(10);
      expect(result.current.status?.progress.done).toBe(4);
    });

    it('is not undone by the answer to a question that has been asked again since', async () => {
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);

      // The run starts, which makes the hook ask again; before that is answered, the run is over.
      let late: (value: EnrichmentStatus) => void = () => undefined;
      vi.mocked(bridge.getEnrichmentStatus).mockImplementationOnce(
        () => new Promise<EnrichmentStatus>((resolve) => (late = resolve)),
      );
      tell(progress({ run: 1, state: 'running', total: 2, done: 0 }));
      await waitFor(() => expect(calls(bridge.getEnrichmentStatus)).toBe(2));
      tell(progress({ run: 1, state: 'finished', total: 2, done: 2 }), { pending: 0 });
      await waitFor(() => expect(result.current.status?.pending).toBe(0));

      // The answer that was on its way all along describes a run that was still going.
      await act(async () => {
        late(status({ pending: 11, progress: progress({ run: 1, state: 'running', total: 2, done: 0 }) }));
      });

      expect(result.current.status?.progress.state).toBe('finished');
      expect(result.current.status?.pending).toBe(0);
    });

    it('does not take the very first answer for news when the run was over before it came', async () => {
      let first: (value: EnrichmentStatus) => void = () => undefined;
      vi.mocked(bridge.getEnrichmentStatus).mockImplementationOnce(
        () => new Promise<EnrichmentStatus>((resolve) => (first = resolve)),
      );
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await waitFor(() => expect(calls(bridge.listenEnrichmentProgress)).toBe(1));

      // The last word of the run is reported before the first question has been answered.
      tell(progress({ run: 4, state: 'finished', total: 1, done: 1 }), { pending: 0 });
      await waitFor(() => expect(result.current.status?.progress.state).toBe('finished'));

      await act(async () => {
        first(status({ progress: progress({ run: 4, state: 'running', total: 1 }) }));
      });

      expect(result.current.status?.progress.state).toBe('finished');
    });
  });

  describe('starting, pausing, resuming and stopping', () => {
    it('starts over all the bare words, or over the ones that were named', async () => {
      vi.mocked(bridge.startEnrichment).mockImplementation(
        answeringWith(progress({ run: 1, state: 'running', total: 12 })),
      );
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);

      await act(async () => {
        await result.current.start();
      });
      expect(bridge.startEnrichment).toHaveBeenLastCalledWith(undefined);
      expect(result.current.status?.progress.state).toBe('running');

      await act(async () => {
        await result.current.start(['a', 'b']);
      });
      expect(bridge.startEnrichment).toHaveBeenLastCalledWith(['a', 'b']);
    });

    it('says why a run did not start, and clears that when the next thing is asked', async () => {
      vi.mocked(bridge.startEnrichment).mockRejectedValueOnce('没有需要补全的词');
      vi.mocked(bridge.pauseEnrichment).mockImplementation(
        answeringWith(progress({ run: 1, state: 'paused', total: 3 })),
      );
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.error).toBe('没有需要补全的词');
      expect(result.current.busy).toBe(false);

      await act(async () => {
        await result.current.pause();
      });
      expect(result.current.error).toBe('');
    });

    it.each([
      ['pause', 'pauseEnrichment', 'paused'],
      ['resume', 'resumeEnrichment', 'running'],
      ['stop', 'stopEnrichment', 'stopping'],
    ] as const)('%s asks the backend and shows the state it answers with', async (action, command, state) => {
      vi.mocked(bridge[command]).mockImplementation(answeringWith(progress({ run: 1, state, total: 3 })));
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);

      await act(async () => {
        await result.current[action]();
      });

      expect(bridge[command]).toHaveBeenCalledTimes(1);
      expect(result.current.status?.progress.state).toBe(state);
    });

    it('is busy while a command is on its way, so that it cannot be sent twice', async () => {
      let answer: (value: EnrichmentProgress) => void = () => undefined;
      vi.mocked(bridge.startEnrichment).mockImplementation(
        () => new Promise<EnrichmentProgress>((resolve) => (answer = resolve)),
      );
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);

      let sent: Promise<void> = Promise.resolve();
      act(() => {
        sent = result.current.start();
      });
      expect(result.current.busy).toBe(true);

      const running = progress({ run: 1, state: 'running', total: 1 });
      backend = { ...backend, progress: running };
      await act(async () => {
        answer(running);
        await sent;
      });
      expect(result.current.busy).toBe(false);
    });
  });

  describe('the account of a run that has ended', () => {
    it('is there until it is put away, and then stays away, for that run only', async () => {
      backend = status({
        pending: 2,
        progress: progress({ run: 3, state: 'finished', total: 5, done: 3, failed: 2 }),
      });
      const { result } = renderHook(() => useEnrichment(), { wrapper });
      await loaded(result);
      expect(result.current.dismissed).toBe(false);

      act(() => result.current.dismiss());
      expect(result.current.dismissed).toBe(true);

      // Opened again later in the same session: still put away.
      cleanup();
      const again = renderHook(() => useEnrichment(), { wrapper });
      await loaded(again.result);
      expect(again.result.current.dismissed).toBe(true);

      // The next run has an account of its own.
      tell(progress({ run: 4, state: 'running', total: 2 }));
      expect(again.result.current.dismissed).toBe(false);
    });
  });

  it('stops listening when the library is left', async () => {
    const { result, unmount } = renderHook(() => useEnrichment(), { wrapper });
    await loaded(result);
    await waitFor(() => expect(calls(bridge.listenEnrichmentProgress)).toBe(1));

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
