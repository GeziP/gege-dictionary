import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLexNote } from '../contexts/LexNoteContext';
import { isRunActive, isRunOver } from '../lib/enrichment';
import * as bridge from '../lib/tauri-bridge';
import type { EnrichmentProgress, EnrichmentStatus } from '../types/lexnote';

/** How often at most the figures that are not in the progress (words left, tokens today) are asked for while a run goes on. */
const STATUS_EVERY_MS = 4_000;
/** How often at most the library is read again while a run goes on, so the words it has filled in show up. */
const WORDS_EVERY_MS = 15_000;

const DISMISSED_KEY = 'gege.enrichment.dismissed-run';

function dismissedRun(): number {
  try {
    return Number(window.sessionStorage.getItem(DISMISSED_KEY)) || 0;
  } catch {
    return 0;
  }
}

export interface EnrichmentControl {
  /** `null` until the backend has answered for the first time. */
  status: EnrichmentStatus | null;
  /** Why the last thing asked for did not happen, if it did not. */
  error: string;
  /** A request to the backend is on its way, so another would only be a double click. */
  busy: boolean;
  /** Whether the end of the latest run has been seen and put away by the user. */
  dismissed: boolean;
  /** Starts a run over all bare words, or over those of `ids` that are bare. */
  start: (ids?: string[]) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  /** Puts away the account of the run that has ended. */
  dismiss: () => void;
  refresh: () => Promise<void>;
}

/**
 * What the library window knows about the batch enrichment, which runs in the backend: the figures
 * it asks for, the progress it is told of, and the commands that steer it. The words a run fills
 * in are read into the library again as it goes (not at every word) and when it ends.
 */
export function useEnrichment(): EnrichmentControl {
  const { refreshWords } = useLexNote();
  const [status, setStatus] = useState<EnrichmentStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissedNumber, setDismissedNumber] = useState(dismissedRun);

  const alive = useRef(true);
  /** The latest word on the run's progress, and how many there have been: what an answer that was on its way must not undo. */
  const latest = useRef<EnrichmentProgress | null>(null);
  const reports = useRef(0);
  const loads = useRef(0);
  const statusAt = useRef(0);
  const wordsAt = useRef(0);
  const wordsDone = useRef(0);
  const lastState = useRef<EnrichmentProgress['state']>('idle');
  const refreshWordsRef = useRef(refreshWords);
  useEffect(() => {
    refreshWordsRef.current = refreshWords;
  }, [refreshWords]);

  const learnOf = useCallback((progress: EnrichmentProgress) => {
    reports.current += 1;
    latest.current = progress;
    lastState.current = progress.state;
  }, []);

  const load = useCallback(async () => {
    const ticket = ++loads.current;
    const reportsBefore = reports.current;
    statusAt.current = Date.now();
    try {
      const next = await bridge.getEnrichmentStatus();
      // Only the question asked last is answered for; an older one would only bring older news.
      if (!alive.current || ticket !== loads.current) return;
      // A progress report that came while this was on its way is newer than what it carries.
      const newer = reports.current !== reportsBefore ? latest.current : null;
      lastState.current = (newer ?? next.progress).state;
      setStatus(newer ? { ...next, progress: newer } : next);
    } catch (reason) {
      if (alive.current && ticket === loads.current) setError(String(reason));
    }
  }, []);

  const readWords = useCallback(() => {
    wordsAt.current = Date.now();
    refreshWordsRef.current();
  }, []);

  const onProgress = useCallback(
    (progress: EnrichmentProgress) => {
      const before = lastState.current;
      learnOf(progress);
      setStatus((current) => (current ? { ...current, progress } : current));

      const ended = isRunOver(progress.state) && isRunActive(before);
      const changed = before !== progress.state;
      // A complaint about a command belongs to the moment it was made.
      if (changed) setError('');
      const now = Date.now();
      if (ended || changed || now - statusAt.current >= STATUS_EVERY_MS) void load();
      if (ended) {
        wordsDone.current = progress.done;
        readWords();
      } else if (progress.done !== wordsDone.current && now - wordsAt.current >= WORDS_EVERY_MS) {
        wordsDone.current = progress.done;
        readWords();
      }
    },
    [learnOf, load, readWords],
  );

  useEffect(() => {
    alive.current = true;
    let unlisten: (() => void) | undefined;
    void load();
    bridge
      .listenEnrichmentProgress(onProgress)
      .then((stop) => {
        if (alive.current) unlisten = stop;
        else stop();
      })
      .catch((reason) => console.error('Failed to listen for enrichment progress:', reason));
    return () => {
      alive.current = false;
      unlisten?.();
    };
  }, [load, onProgress]);

  const send = useCallback(
    async (command: () => Promise<EnrichmentProgress>) => {
      setBusy(true);
      setError('');
      try {
        const progress = await command();
        if (!alive.current) return;
        learnOf(progress);
        setStatus((current) => (current ? { ...current, progress } : current));
        void load();
      } catch (reason) {
        if (alive.current) setError(String(reason));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [learnOf, load],
  );

  const start = useCallback((ids?: string[]) => send(() => bridge.startEnrichment(ids)), [send]);
  const pause = useCallback(() => send(() => bridge.pauseEnrichment()), [send]);
  const resume = useCallback(() => send(() => bridge.resumeEnrichment()), [send]);
  const stop = useCallback(() => send(() => bridge.stopEnrichment()), [send]);

  const dismiss = useCallback(() => {
    const run = status?.progress.run ?? 0;
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, String(run));
    } catch {
      // Without storage the account comes back the next time the page is opened; no harm done.
    }
    setDismissedNumber(run);
  }, [status]);

  const dismissed = status !== null && status.progress.run <= dismissedNumber;

  return useMemo(
    () => ({ status, error, busy, dismissed, start, pause, resume, stop, dismiss, refresh: load }),
    [status, error, busy, dismissed, start, pause, resume, stop, dismiss, load],
  );
}
