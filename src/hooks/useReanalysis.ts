import { useCallback, useEffect, useRef, useState } from 'react';
import { useLexNote } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import { reanalysisDraft, reanalysisRequest, rollbackDraft } from '../lib/words';
import type { Entry, SavedWord } from '../types/lexnote';

export type ReanalysisState =
  | { status: 'idle' }
  | { status: 'running' }
  | {
      status: 'done';
      /** The word as it was before, which is what a rollback returns the content to. */
      before: SavedWord;
      /** The model that wrote the new answer. */
      model: string;
      /** Why the last rollback attempt failed, if it did. */
      rollbackError?: string;
    }
  | {
      /** The lookup (or saving its result) failed; the word is exactly as it was. */
      status: 'error';
      /** The raw `[code] message` string, for `parseLookupError`. */
      error: string;
    };

/**
 * Analyses a saved word again with the model that is configured now, and can
 * take the new answer back.
 *
 * The answer replaces the model-written content of the word and nothing else:
 * mastery, note, tags, the Anki link and where and when the word was collected
 * stay as they are. If the model cannot be reached nothing changes and the
 * reason is reported as it is. Showing another word forgets what was said
 * about the previous one; an answer that arrives after that is still saved to
 * the word it belongs to.
 */
export function useReanalysis(word: SavedWord | null) {
  const { saveWord, restoreWord, settings } = useLexNote();
  const [state, setState] = useState<ReanalysisState>({ status: 'idle' });

  const shownId = word?.id ?? null;
  const shownIdRef = useRef(shownId);
  shownIdRef.current = shownId;
  const wordRef = useRef(word);
  wordRef.current = word;
  const model = settings.provider.model;

  useEffect(() => {
    setState({ status: 'idle' });
  }, [shownId]);

  const run = useCallback(async () => {
    const target = wordRef.current;
    if (!target) return;
    // What happened is only worth showing while the word it happened to is on screen.
    const show = (next: ReanalysisState) => {
      if (shownIdRef.current === target.id) setState(next);
    };

    show({ status: 'running' });
    let entry: Entry;
    try {
      const { selection, context, kind } = reanalysisRequest(target);
      entry = await bridge.lookupWord(selection, context, kind, true);
    } catch (error) {
      show({ status: 'error', error: String(error) });
      return;
    }
    try {
      await saveWord(reanalysisDraft(target, entry));
    } catch (error) {
      show({ status: 'error', error: `[internal] 新的解析已生成，但保存失败：${String(error)}` });
      return;
    }
    show({ status: 'done', before: target, model });
  }, [saveWord, model]);

  const rollback = useCallback(async () => {
    if (state.status !== 'done') return;
    const current = wordRef.current;
    if (!current || current.id !== state.before.id) return;
    try {
      await restoreWord(rollbackDraft(current, state.before));
      if (shownIdRef.current === state.before.id) setState({ status: 'idle' });
    } catch (error) {
      if (shownIdRef.current === state.before.id) {
        setState({ ...state, rollbackError: String(error) });
      }
    }
  }, [state, restoreWord]);

  return { state, run, rollback };
}
