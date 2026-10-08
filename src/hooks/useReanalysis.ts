import { useCallback, useEffect, useRef, useState } from 'react';
import { useLexNote } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import {
  otherLemma,
  reanalysisDraft,
  reanalysisRequest,
  rollbackDraft,
  separateDraft,
  untouchedSince,
} from '../lib/words';
import type { Entry, EntryMetadata, SavedWord } from '../types/lexnote';

export type ReanalysisState =
  | { status: 'idle' }
  | { status: 'running' }
  | {
      /**
       * The answer names another form of the word than the one it is saved
       * under ("run" for "running"). Nothing is saved until the user says what
       * to do with it.
       */
      status: 'choose';
      /** The word the answer was asked for. */
      wordId: string;
      /** The form the word is saved under. */
      savedLemma: string;
      /** The form the answer names. */
      lemma: string;
      /** The word the library has under that form already, if there is one. */
      existing: SavedWord | null;
      /** The answer that is waiting to be saved or dropped. */
      entry: Entry;
      /** Saving is under way, so the choice cannot be made twice. */
      saving: boolean;
      /** Why saving failed, if it did; the choice is still open. */
      error?: string;
    }
  | {
      status: 'done';
      /** The word as it was before, which is what a rollback returns the content to. */
      before: SavedWord;
      /** The model that wrote the new answer. */
      model: string;
      /** Whether that was the backup model, because the one that is configured could not answer. */
      viaBackup: boolean;
      /** Why the last rollback attempt failed, if it did. */
      rollbackError?: string;
    }
  | {
      /** The answer was saved as a word of its own, and the open word was not touched. */
      status: 'separate';
      /** The form it was saved under. */
      lemma: string;
      /** The word as the save returned it. */
      stored: SavedWord;
      /**
       * The word the library had under that form before, which an undo puts
       * back; null when the save made a new word, which an undo deletes.
       */
      earlier: SavedWord | null;
      model: string;
      viaBackup: boolean;
      /** Why the last undo attempt failed, if it did. */
      rollbackError?: string;
    }
  | {
      /** The lookup (or saving its result) failed; the word is exactly as it was. */
      status: 'error';
      /** The raw `[code] message` string, for `parseLookupError`. */
      error: string;
    };

/** Who really wrote an answer: the backup answers when the model that is configured cannot. */
function author(entry: Entry, configured: string): { model: string; viaBackup: boolean } {
  const { _model: answeredBy, _viaBackup: viaBackup } = entry as EntryMetadata;
  return { model: answeredBy || configured, viaBackup: viaBackup === true };
}

/**
 * Analyses a saved word again with the model that is configured now, and can
 * take the new answer back.
 *
 * The answer replaces the model-written content of the word and nothing else:
 * mastery, note, tags, the Anki link, the form the word is saved under and
 * where and when it was collected stay as they are. If the model cannot be
 * reached nothing changes and the reason is reported as it is. Showing another
 * word forgets what was said about the previous one; an answer that arrives
 * after that is still saved to the word it belongs to.
 *
 * One answer is not saved at once: when it names another form of the word
 * ("run" for the saved "running") it waits for the user, who can have it
 * replace the content of the word as it is (`keepSavedForm`), saved as a word
 * of its own under the form it names (`saveAsOwnWord`, which refreshes the word
 * that has that form already instead of making it twice), or dropped
 * (`discard`). An answer like that cannot be asked about once the word is no
 * longer open, and is then dropped rather than decided on the user's behalf.
 */
export function useReanalysis(word: SavedWord | null) {
  const { saveWord, restoreWord, refreshWords, words, settings } = useLexNote();
  const [state, setState] = useState<ReanalysisState>({ status: 'idle' });

  const shownId = word?.id ?? null;
  const shownIdRef = useRef(shownId);
  shownIdRef.current = shownId;
  const wordRef = useRef(word);
  wordRef.current = word;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const model = settings.provider.model;

  useEffect(() => {
    setState({ status: 'idle' });
  }, [shownId]);

  /** The answer written over the word: what a re-analysis is when the answer names no other form. */
  const saveOver = useCallback(
    async (target: SavedWord, entry: Entry): Promise<ReanalysisState> => {
      await saveWord(reanalysisDraft(target, entry));
      return { status: 'done', before: target, ...author(entry, model) };
    },
    [saveWord, model],
  );

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

    const named = otherLemma(target, entry);
    if (named !== null) {
      // Which form is right is for the user to say, and they can only be asked
      // while they are looking at the word. Saving the answer anyway would be
      // deciding for them.
      if (shownIdRef.current !== target.id) return;
      const existing = await bridge.findWordByLemma(named, entry.kind).catch(() => null);
      show({
        status: 'choose',
        wordId: target.id,
        savedLemma: target.lemma,
        lemma: named,
        existing,
        entry,
        saving: false,
      });
      return;
    }

    try {
      show(await saveOver(target, entry));
    } catch (error) {
      show({ status: 'error', error: `[internal] 新的解析已生成，但保存失败：${String(error)}` });
    }
  }, [saveOver]);

  /** The answer replaces the content of the open word, which keeps the form it is saved under. */
  const keepSavedForm = useCallback(async () => {
    const choice = state;
    if (choice.status !== 'choose' || choice.saving) return;
    // The word as it is now, not as it was when the model was asked: the user may have edited it meanwhile.
    const current = wordRef.current;
    if (!current || current.id !== choice.wordId) return;
    setState({ ...choice, saving: true, error: undefined });
    try {
      const done = await saveOver(current, choice.entry);
      if (shownIdRef.current === current.id) setState(done);
    } catch (error) {
      if (shownIdRef.current === current.id) {
        setState({ ...choice, saving: false, error: String(error) });
      }
    }
  }, [state, saveOver]);

  /** The answer becomes a word of its own under the form it names; the open word is left alone. */
  const saveAsOwnWord = useCallback(async () => {
    const choice = state;
    if (choice.status !== 'choose' || choice.saving) return;
    const current = wordRef.current;
    if (!current || current.id !== choice.wordId) return;
    setState({ ...choice, saving: true, error: undefined });
    try {
      // Asked again now: the library may have changed while the choice was
      // open, and an undo has to know exactly what was there.
      const earlier = await bridge.findWordByLemma(choice.lemma, choice.entry.kind);
      const stored = await saveWord(separateDraft(current, choice.entry, earlier));
      if (shownIdRef.current === current.id) {
        setState({
          status: 'separate',
          lemma: choice.lemma,
          stored,
          earlier,
          ...author(choice.entry, model),
        });
      }
    } catch (error) {
      if (shownIdRef.current === current.id) {
        setState({ ...choice, saving: false, error: String(error) });
      }
    }
  }, [state, saveWord, model]);

  /** The answer is dropped and nothing was saved. */
  const discard = useCallback(() => {
    setState((current) =>
      current.status === 'choose' && !current.saving ? { status: 'idle' } : current,
    );
  }, []);

  /** Takes the last answer back: the content of the word, or the word it was saved as. */
  const rollback = useCallback(async () => {
    const open = wordRef.current;
    if (!open) return;

    if (state.status === 'done') {
      if (open.id !== state.before.id) return;
      try {
        await restoreWord(rollbackDraft(open, state.before));
        if (shownIdRef.current === state.before.id) setState({ status: 'idle' });
      } catch (error) {
        if (shownIdRef.current === state.before.id) {
          setState({ ...state, rollbackError: String(error) });
        }
      }
      return;
    }

    if (state.status === 'separate') {
      const { stored, earlier } = state;
      // The word as it is now: the user may have done something with it since.
      const now = wordsRef.current.find((candidate) => candidate.id === stored.id);
      try {
        if (now && earlier) {
          await restoreWord(rollbackDraft(now, earlier));
        } else if (now) {
          if (!untouchedSince(stored, now)) {
            setState({
              ...state,
              rollbackError: `「${stored.lemma}」在这之后被你改动过，所以没有删除。要删的话请在词库里自己删。`,
            });
            return;
          }
          await bridge.deleteWords([stored.id]);
          bridge.emitWordSaved().catch(console.error);
          refreshWords();
        }
        // A word that is gone already (deleted meanwhile) has nothing left to undo.
        if (shownIdRef.current === open.id) setState({ status: 'idle' });
      } catch (error) {
        if (shownIdRef.current === open.id) setState({ ...state, rollbackError: String(error) });
      }
    }
  }, [state, restoreWord, refreshWords]);

  return { state, run, rollback, keepSavedForm, saveAsOwnWord, discard };
}
