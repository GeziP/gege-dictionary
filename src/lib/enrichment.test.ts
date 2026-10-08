import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENRICH_PACE,
  DEFAULT_ENRICH_TOKENS,
  dealtWith,
  effectiveDailyTokens,
  effectivePace,
  estimateTokens,
  explainFailure,
  explainStop,
  formatTokens,
  isBare,
  isRunActive,
  isRunOver,
} from './enrichment';
import type { EnrichmentState, SavedWord } from '../types/lexnote';

const wordLike = (overrides: Record<string, unknown> = {}) =>
  ({ kind: 'word', senses: [], examples: [], ...overrides }) as unknown as Pick<
    SavedWord,
    'kind' | 'senses' | 'examples'
  >;

describe('which words are bare', () => {
  it('is a word or a phrase that has neither senses nor examples', () => {
    expect(isBare(wordLike())).toBe(true);
    expect(isBare(wordLike({ kind: 'phrase' }))).toBe(true);
  });

  it('is not a word that has senses or examples, or both', () => {
    expect(isBare(wordLike({ senses: [{ pos: 'n.', gloss: 'x', translation: '义' }] }))).toBe(false);
    expect(isBare(wordLike({ examples: [{ en: 'x', zh: 'y' }] }))).toBe(false);
    expect(
      isBare(wordLike({ senses: [{ pos: 'n.', gloss: 'x', translation: '义' }], examples: [{ en: 'x', zh: 'y' }] })),
    ).toBe(false);
  });

  it('is never a sentence or a paragraph, which have no senses to give', () => {
    expect(isBare(wordLike({ kind: 'sentence' }))).toBe(false);
    expect(isBare(wordLike({ kind: 'paragraph' }))).toBe(false);
  });

  it('reads a missing or empty kind as a word, and lists that are not lists as empty ones', () => {
    expect(isBare(wordLike({ kind: undefined }))).toBe(true);
    expect(isBare(wordLike({ kind: '' }))).toBe(true);
    expect(isBare(wordLike({ senses: undefined, examples: null }))).toBe(true);
    expect(isBare(wordLike({ senses: 'oops' }))).toBe(true);
  });
});

describe('the states of a run', () => {
  const states: EnrichmentState[] = ['idle', 'running', 'paused', 'stopping', 'finished', 'stopped'];

  it.each([
    ['idle', false, false],
    ['running', true, false],
    ['paused', true, false],
    ['stopping', true, false],
    ['finished', false, true],
    ['stopped', false, true],
  ] as Array<[EnrichmentState, boolean, boolean]>)('%s: active %s, over %s', (state, active, over) => {
    expect(isRunActive(state)).toBe(active);
    expect(isRunOver(state)).toBe(over);
  });

  it('is none of them or both, never in between', () => {
    for (const state of states) expect(isRunActive(state) && isRunOver(state)).toBe(false);
  });

  it('counts the words dealt with whichever way they went', () => {
    expect(dealtWith({ done: 5, failed: 2, skipped: 1 })).toBe(8);
  });
});

describe('the figures in tokens', () => {
  it('writes them with thousands separators, rounded', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(100000)).toBe('100,000');
    expect(formatTokens(1234.6)).toBe('1,235');
  });

  it('guesses a batch at 1,500 tokens a word', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(40)).toBe(60000);
  });
});

describe('the choices of the user, as the backend reads them', () => {
  it('takes a sensible daily limit as it is, and zero as no limit', () => {
    expect(effectiveDailyTokens(300_000)).toBe(300_000);
    expect(effectiveDailyTokens(1_000)).toBe(1_000);
    expect(effectiveDailyTokens(0)).toBe(0);
  });

  it('takes a limit that is missing or makes no sense as the default, never as no limit', () => {
    for (const odd of [undefined, null, '100000', 12.5, -5, 10, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveDailyTokens(odd), String(odd)).toBe(DEFAULT_ENRICH_TOKENS);
    }
  });

  it('takes the three paces by name and anything else as the standard one', () => {
    expect(effectivePace('gentle')).toBe('gentle');
    expect(effectivePace('normal')).toBe('normal');
    expect(effectivePace('fast')).toBe('fast');
    for (const odd of [undefined, '', 'turbo', 3]) expect(effectivePace(odd)).toBe(DEFAULT_ENRICH_PACE);
  });
});

describe('what a run that stopped by itself says', () => {
  it('tells of a spent budget and says that the rest waits', () => {
    const say = explainStop({ code: 'budget', message: '今天已用约 99,000 tokens，再补全一个词会超过 100000 的上限' });

    expect(say.title).toBe('今天的补全额度用完了');
    expect(say.hint).toContain('明天');
    expect(say.hint).toContain('继续补全');
    expect(say.toSettings).toBe(true);
  });

  it('tells of a service that keeps saying it is busy', () => {
    const say = explainStop({ code: 'rate_limit', message: '[rate_limit] 429' });

    expect(say.title).toBe('模型服务一直在限流');
    expect(say.toSettings).toBe(true);
  });

  it.each(['no_key', 'auth', 'model'])('sends %s to the settings, in the words of a lookup', (code) => {
    const say = explainStop({ code, message: `[${code}] nope` });

    expect(say.toSettings).toBe(true);
    expect(say.title).not.toBe('查词失败');
    expect(say.hint.length).toBeGreaterThan(0);
  });

  it('names the last failure of words that kept failing, and points to the settings only if that did', () => {
    const parse = explainStop({ code: 'repeated', message: '[parse] cannot read' });
    const truncated = explainStop({ code: 'repeated', message: '[truncated] cut' });

    expect(parse.title).toContain('连续');
    expect(parse.hint).toContain('模型返回的内容无法解析');
    expect(parse.toSettings).toBe(false);
    expect(truncated.hint).toContain('模型输出被截断了');
    expect(truncated.toSettings).toBe(true);
  });

  it('does not make up advice for a code it does not know', () => {
    const say = explainStop({ code: 'brand_new', message: 'something odd' });

    expect(say.title).toBe('查词失败');
    expect(say.toSettings).toBe(false);
  });
});

describe('what a word that failed says', () => {
  it('is the title of the error, plus what the service said where that is worth knowing', () => {
    expect(explainFailure({ lemma: 'x', code: 'parse', message: '[parse] cannot read' })).toBe(
      '模型返回的内容无法解析',
    );
    expect(explainFailure({ lemma: 'x', code: 'api', message: '[api] quota exceeded' })).toBe(
      '模型服务返回了错误（quota exceeded）',
    );
  });
});
