import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entry, LookupRequest, NetworkMode } from '../types/lexnote';
import { resolveEntry } from '../utils/lookup';

export type LookupPhase = 'capturing' | 'streaming' | 'done' | 'error';
export type LookupError = 'timeout' | 'auth' | 'offline' | 'nodata' | null;

export const SECTION_COUNT = 6;

interface LookupState {
  phase: LookupPhase;
  error: LookupError;
  entry: Entry | null;
  revealed: number;
  firstTokenMs: number | null;
  elapsedMs: number;
  cached: boolean;
  malformed: boolean;
}

const INITIAL: LookupState = {
  phase: 'capturing',
  error: null,
  entry: null,
  revealed: 0,
  firstTokenMs: null,
  elapsedMs: 0,
  cached: false,
  malformed: false
};

/** Simulates an SSE stream from an OpenAI-compatible endpoint. */
export function useLookup(request: LookupRequest | null, network: NetworkMode, attempt: number) {
  const [state, setState] = useState<LookupState>(INITIAL);
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  useEffect(() => {
    clear();
    if (!request) {
      setState(INITIAL);
      return;
    }

    const entry = resolveEntry(request.selection);
    setState({ ...INITIAL });
    const startedAt = performance.now();
    const push = (fn: () => void, delay: number) => {
      timers.current.push(window.setTimeout(fn, delay));
    };

    if (!entry) {
      push(() => setState((s) => ({ ...s, phase: 'error', error: 'nodata' })), 420);
      return clear;
    }

    if (network === 'auth') {
      push(() => setState((s) => ({ ...s, phase: 'error', error: 'auth' })), 520);
      return clear;
    }

    if (network === 'offline') {
      push(() => setState((s) => ({ ...s, phase: 'error', error: 'offline', entry })), 380);
      return clear;
    }

    if (network === 'cached') {
      push(
        () =>
        setState({
          phase: 'done',
          error: null,
          entry,
          revealed: SECTION_COUNT,
          firstTokenMs: 0,
          elapsedMs: Math.round(performance.now() - startedAt),
          cached: true,
          malformed: false
        }),
        140
      );
      return clear;
    }

    const firstToken = 620;
    push(
      () =>
      setState((s) => ({
        ...s,
        phase: 'streaming',
        entry,
        revealed: 1,
        firstTokenMs: Math.round(performance.now() - startedAt)
      })),
      firstToken
    );

    if (network === 'timeout') {
      push(() => setState((s) => ({ ...s, revealed: 2 })), firstToken + 320);
      push(
        () =>
        setState((s) => ({
          ...s,
          phase: 'error',
          error: 'timeout',
          elapsedMs: Math.round(performance.now() - startedAt)
        })),
        firstToken + 1800
      );
      return clear;
    }

    for (let i = 2; i <= SECTION_COUNT; i += 1) {
      push(() => setState((s) => ({ ...s, revealed: i })), firstToken + (i - 1) * 260);
    }
    push(
      () =>
      setState((s) => ({
        ...s,
        phase: 'done',
        malformed: network === 'malformed',
        elapsedMs: Math.round(performance.now() - startedAt)
      })),
      firstToken + SECTION_COUNT * 260
    );

    return clear;
  }, [request, network, attempt, clear]);

  return state;
}