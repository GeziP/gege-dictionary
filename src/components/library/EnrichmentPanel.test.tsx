import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrichmentControl } from '../../hooks/useEnrichment';
import type { EnrichmentProgress, EnrichmentStatus } from '../../types/lexnote';
import { EnrichmentPanel } from './EnrichmentPanel';

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

function controlOf(overrides: Partial<EnrichmentControl> = {}): EnrichmentControl {
  return {
    status: status(),
    error: '',
    busy: false,
    dismissed: false,
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function show(control: EnrichmentControl) {
  return render(
    <MemoryRouter>
      <EnrichmentPanel enrichment={control} />
    </MemoryRouter>,
  );
}

const panel = () => screen.getByRole('region', { name: '批量补全' });
const button = (name: string) => screen.getByRole('button', { name });

afterEach(cleanup);

describe('the batch enrichment in the library', () => {
  describe('before a run', () => {
    it('says nothing before the backend has answered, and nothing when no word needs it', () => {
      const first = show(controlOf({ status: null }));
      expect(first.container).toBeEmptyDOMElement();
      first.unmount();

      const second = show(controlOf({ status: status({ pending: 0 }) }));
      expect(second.container).toBeEmptyDOMElement();
    });

    it('offers to fill in the words that have only a meaning, and says what that comes to', async () => {
      const control = controlOf();
      show(control);

      expect(panel()).toHaveTextContent('12 个词还没有义项和例句');
      expect(panel()).toHaveTextContent('你写的释义、笔记、标签和复习进度都不会被改动');
      expect(panel()).toHaveTextContent('全部补完约需 18,000 tokens');
      expect(panel()).toHaveTextContent('今天已用约 3,000 / 100,000 tokens');

      await userEvent.click(button('开始补全'));

      expect(control.start).toHaveBeenCalledTimes(1);
      expect(control.start).toHaveBeenCalledWith();
    });

    it('says that a limit will stop it when the batch is bigger than what the limit allows', () => {
      show(controlOf({ status: status({ pending: 100 }) }));

      expect(panel()).toHaveTextContent('全部补完约需 150,000 tokens');
      expect(panel()).toHaveTextContent('额度用完会自动停下，剩下的明天可以接着补');
    });

    it('does not say that for a batch that fits, or when there is no limit', () => {
      const small = show(controlOf());
      expect(panel()).not.toHaveTextContent('额度用完会自动停下');
      small.unmount();

      show(controlOf({ status: status({ pending: 100, dailyLimit: null }) }));
      expect(panel()).toHaveTextContent('今天已用约 3,000 tokens（没有设上限）');
      expect(panel()).not.toHaveTextContent('额度用完会自动停下');
    });

    it('cannot be started twice while the first start is on its way', () => {
      show(controlOf({ busy: true }));

      expect(button('开始补全')).toBeDisabled();
    });

    it('points to the settings, where the limit and the pace are', () => {
      show(controlOf());

      expect(screen.getByRole('link', { name: '补全的额度和节奏在设置里调整' })).toHaveAttribute('href', '/settings');
    });

    it('says why a command did not work, even when there is nothing else to say', () => {
      const idle = show(controlOf({ status: status({ pending: 0 }), error: '没有需要补全的词' }));

      expect(screen.getByRole('alert')).toHaveTextContent('没有需要补全的词');
      idle.unmount();

      show(controlOf({ error: '已经有一轮补全在进行' }));
      expect(screen.getByRole('alert')).toHaveTextContent('已经有一轮补全在进行');
    });
  });

  describe('during a run', () => {
    const running = (overrides: Partial<EnrichmentProgress> = {}) =>
      status({
        progress: progress({
          run: 1,
          state: 'running',
          total: 12,
          done: 3,
          failed: 1,
          skipped: 1,
          tokens: 4_500,
          current: 'ephemeral',
          ...overrides,
        }),
      });

    it('shows how far it is, which word it is on and what that has cost', () => {
      show(controlOf({ status: running() }));

      expect(panel()).toHaveTextContent('正在补全生词');
      expect(panel()).toHaveTextContent('正在处理：ephemeral');
      expect(panel()).toHaveTextContent('已补全 3 / 12 个 · 失败 1 · 已无需补全 1 · 本轮约用 4,500 tokens');
      expect(panel()).toHaveTextContent('今天已用约 3,000 / 100,000 tokens');
      const bar = within(panel()).getByRole('progressbar', { name: '补全进度' });
      expect(bar).toHaveAttribute('aria-valuemax', '12');
      expect(bar).toHaveAttribute('aria-valuenow', '5'); // done, failed and skipped have all had their turn
      expect(screen.queryByRole('button', { name: '开始补全' })).not.toBeInTheDocument();
    });

    it('leaves out what is nil, and waits without naming a word between two words', () => {
      show(controlOf({ status: running({ failed: 0, skipped: 0, current: null }) }));

      expect(panel()).toHaveTextContent('已补全 3 / 12 个 · 本轮约用 4,500 tokens');
      expect(panel()).not.toHaveTextContent('失败');
      expect(panel()).toHaveTextContent('准备下一个词…');
    });

    it('can be paused or stopped', async () => {
      const control = controlOf({ status: running() });
      show(control);

      await userEvent.click(button('暂停'));
      expect(control.pause).toHaveBeenCalledTimes(1);

      await userEvent.click(button('停止'));
      expect(control.stop).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    });

    it('can be resumed or stopped while it is paused', async () => {
      const control = controlOf({ status: running({ state: 'paused', current: null }) });
      show(control);

      expect(panel()).toHaveTextContent('补全已暂停');
      expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();

      await userEvent.click(button('继续'));
      expect(control.resume).toHaveBeenCalledTimes(1);
      await userEvent.click(button('停止'));
      expect(control.stop).toHaveBeenCalledTimes(1);
    });

    it('says that it is stopping, and for which word it waits, and offers nothing more to press', () => {
      show(controlOf({ status: running({ state: 'stopping' }) }));

      expect(panel()).toHaveTextContent('正在停止…');
      expect(panel()).toHaveTextContent('等「ephemeral」这个词完成后就停下');
      expect(button('暂停')).toBeDisabled();
      expect(button('停止')).toBeDisabled();
    });

    it('does not take a second command while the first is on its way', () => {
      show(controlOf({ status: running(), busy: true }));

      expect(button('暂停')).toBeDisabled();
      expect(button('停止')).toBeDisabled();
    });

    it('says why a command did not work', () => {
      show(controlOf({ status: running(), error: '网络中断' }));

      expect(screen.getByRole('alert')).toHaveTextContent('网络中断');
    });
  });

  describe('after a run', () => {
    const over = (progressOverrides: Partial<EnrichmentProgress>, rest: Partial<EnrichmentStatus> = {}) =>
      status({ pending: 0, progress: progress({ run: 2, total: 12, ...progressOverrides }), ...rest });

    it('says that it went through, and can be put away', async () => {
      const control = controlOf({ status: over({ state: 'finished', done: 12, tokens: 18_000 }) });
      show(control);

      expect(panel()).toHaveTextContent('补全完成：补好了 12 个词');
      expect(panel()).toHaveTextContent('已补全 12 / 12 个 · 本轮约用 18,000 tokens');
      expect(screen.queryByRole('button', { name: '继续补全' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /去设置/ })).not.toBeInTheDocument();

      await userEvent.click(button('知道了'));
      expect(control.dismiss).toHaveBeenCalledTimes(1);
    });

    it('is gone once it has been put away, and the offer to fill in what is left comes back', () => {
      const none = show(controlOf({ status: over({ state: 'finished', done: 12 }), dismissed: true }));
      expect(none.container).toBeEmptyDOMElement();
      none.unmount();

      show(controlOf({ status: over({ state: 'finished', done: 5, failed: 7 }, { pending: 7 }), dismissed: true }));
      expect(panel()).toHaveTextContent('7 个词还没有义项和例句');
    });

    it('says how many are left when the user stopped it, and goes on from there on request', async () => {
      const control = controlOf({ status: over({ state: 'stopped', done: 4 }, { pending: 8 }) });
      show(control);

      expect(panel()).toHaveTextContent('已停止：补好了 4 个词');
      expect(panel()).toHaveTextContent('还有 8 个词没补全');

      await userEvent.click(button('继续补全'));
      expect(control.start).toHaveBeenCalledWith();
    });

    it('explains a spent budget, and what to do about it', () => {
      show(
        controlOf({
          status: over(
            {
              state: 'stopped',
              done: 6,
              stoppedBecause: { code: 'budget', message: '今天已用约 99,000 tokens，再补全一个词会超过 100000 的上限' },
            },
            { pending: 6, tokensToday: 99_000 },
          ),
        }),
      );

      expect(panel()).toHaveTextContent('今天的补全额度用完了');
      expect(panel()).toHaveTextContent('明天再点“继续补全”就会接着做');
      expect(panel()).toHaveTextContent('今天已用约 99,000 / 100,000 tokens');
      expect(screen.getByRole('link', { name: /去设置/ })).toHaveAttribute('href', '/settings');
    });

    it('sends a wrong key or model to the settings, in the words of a lookup', () => {
      show(
        controlOf({
          status: over(
            { state: 'stopped', stoppedBecause: { code: 'auth', message: '[auth] 401 Unauthorized' } },
            { pending: 12 },
          ),
        }),
      );

      expect(panel()).toHaveTextContent('API Key 无效或权限不足');
      expect(screen.getByRole('link', { name: /去设置/ })).toBeInTheDocument();
      expect(button('继续补全')).toBeEnabled();
    });

    it('names what kept failing, and sends to the settings only if that is where it is mended', () => {
      show(
        controlOf({
          status: over(
            {
              state: 'stopped',
              failed: 5,
              stoppedBecause: { code: 'repeated', message: '[parse] cannot read' },
            },
            { pending: 12 },
          ),
        }),
      );

      expect(panel()).toHaveTextContent('连续几个词都没有补全成功');
      expect(panel()).toHaveTextContent('模型返回的内容无法解析');
      expect(screen.queryByRole('link', { name: /去设置/ })).not.toBeInTheDocument();
    });

    it('lists the words that failed, and says how many more there were', async () => {
      show(
        controlOf({
          status: over(
            {
              state: 'finished',
              done: 3,
              failed: 52,
              failures: [
                { lemma: 'ephemeral', code: 'parse', message: '[parse] cannot read' },
                { lemma: 'lucid', code: 'api', message: '[api] quota exceeded' },
              ],
            },
            { pending: 52 },
          ),
        }),
      );

      const summary = screen.getByText('没补成功的词（52）');
      expect(screen.getByText('ephemeral')).not.toBeVisible();

      await userEvent.click(summary);

      expect(screen.getByText('ephemeral')).toBeVisible();
      expect(panel()).toHaveTextContent('ephemeral：模型返回的内容无法解析');
      expect(panel()).toHaveTextContent('lucid：模型服务返回了错误（quota exceeded）');
      expect(panel()).toHaveTextContent('另有 50 个没有在这里列出');
    });

    it('says nothing of failures when there were none', () => {
      show(controlOf({ status: over({ state: 'finished', done: 12 }) }));

      expect(screen.queryByText(/没补成功的词/)).not.toBeInTheDocument();
    });
  });
});
