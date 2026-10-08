import { parseLookupError } from './lookup-errors';
import type {
  EnrichmentFailure,
  EnrichmentPace,
  EnrichmentProgress,
  EnrichmentState,
  EnrichmentStopReason,
  SavedWord,
} from '../types/lexnote';

/** What the day's use may grow to by the batch when the user has not said (`DEFAULT_DAILY_TOKENS` in the backend). */
export const DEFAULT_ENRICH_TOKENS = 100_000;
export const DEFAULT_ENRICH_PACE: EnrichmentPace = 'normal';

/**
 * What one word is guessed to cost in tokens, for saying roughly what a whole batch comes to. The
 * backend goes by what the words it has done really cost; this is only for the first guess.
 */
export const TOKENS_PER_WORD = 1500;

/** The smallest limit that is taken as one; below it the backend goes by the default. */
const MIN_ENRICH_TOKENS = 1_000;

/**
 * The daily limit that is really in force for what the settings say, the way the backend reads
 * it: 0 is no limit, a sensible number is itself, anything else is the default.
 */
export function effectiveDailyTokens(setting: unknown): number {
  if (typeof setting !== 'number' || !Number.isInteger(setting) || setting < 0) return DEFAULT_ENRICH_TOKENS;
  return setting === 0 || setting >= MIN_ENRICH_TOKENS ? setting : DEFAULT_ENRICH_TOKENS;
}

/** The pace that is really in force: the one the settings name, or the standard one. */
export function effectivePace(setting: unknown): EnrichmentPace {
  return setting === 'gentle' || setting === 'normal' || setting === 'fast' ? setting : DEFAULT_ENRICH_PACE;
}

/** The pace a run keeps, in the words the settings use. */
export const PACE_LABELS: Record<EnrichmentPace, string> = {
  gentle: '从容（每 6 秒一个词）',
  normal: '标准（每 3 秒一个词，推荐）',
  fast: '较快（每 1.5 秒一个词，容易被限流）',
};

/**
 * Whether a word is known by nothing but its form and its meaning: no senses and no examples.
 * Only words and phrases are: a saved sentence or paragraph has no senses to give. This is the
 * rule the backend works by (`is_bare` in enrich.rs), so what the screen offers to fill in is
 * what a run would pick up.
 */
export function isBare(word: Pick<SavedWord, 'kind' | 'senses' | 'examples'>): boolean {
  const kind = word.kind || 'word';
  const hasNone = (items: unknown) => !Array.isArray(items) || items.length === 0;
  return (kind === 'word' || kind === 'phrase') && hasNone(word.senses) && hasNone(word.examples);
}

/** A run that is going on: asking, paused, or finishing its last request after it was stopped. */
export function isRunActive(state: EnrichmentState): boolean {
  return state === 'running' || state === 'paused' || state === 'stopping';
}

/** A run that has come to its end, one way or the other. */
export function isRunOver(state: EnrichmentState): boolean {
  return state === 'finished' || state === 'stopped';
}

/** Words the run has dealt with, whichever way it went. */
export function dealtWith(progress: Pick<EnrichmentProgress, 'done' | 'failed' | 'skipped'>): number {
  return progress.done + progress.failed + progress.skipped;
}

export function formatTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString('en-US');
}

/** Roughly what filling in `words` words comes to, before the first of them has been asked. */
export function estimateTokens(words: number): number {
  return words * TOKENS_PER_WORD;
}

export interface StopExplanation {
  title: string;
  hint: string;
  /** Whether what to do about it is in the settings. */
  toSettings: boolean;
}

/** What to tell the user about a run that stopped by itself, and what to do about it. */
export function explainStop(reason: EnrichmentStopReason): StopExplanation {
  switch (reason.code) {
    case 'budget':
      return {
        title: '今天的补全额度用完了',
        hint: '没补完的词都还在原处，明天再点“继续补全”就会接着做；也可以在设置里调高每天的额度。',
        toSettings: true,
      };
    case 'rate_limit':
      return {
        title: '模型服务一直在限流',
        hint: '已经按间隔等了几轮，服务商还是拒绝。过一会儿再继续，或者在设置里把补全节奏调慢。',
        toSettings: true,
      };
    case 'repeated': {
      const last = parseLookupError(reason.message);
      return {
        title: '连续几个词都没有补全成功，先停下了',
        hint: `最近一次的原因：${last.title}。${last.hint}`,
        toSettings: last.action === 'settings',
      };
    }
    default: {
      const info = parseLookupError(reason.message);
      return { title: info.title, hint: info.hint, toSettings: info.action === 'settings' };
    }
  }
}

/** One line for a word that could not be filled in. */
export function explainFailure(failure: EnrichmentFailure): string {
  const info = parseLookupError(failure.message);
  return info.showDetailInline && info.detail ? `${info.title}（${info.detail}）` : info.title;
}
