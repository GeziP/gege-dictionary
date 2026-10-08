import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LookupErrorState } from './LookupErrorState';

function setup(error: string | null) {
  const onRetry = vi.fn();
  const onOpenSettings = vi.fn();
  render(<LookupErrorState error={error} onRetry={onRetry} onOpenSettings={onOpenSettings} />);
  return { onRetry, onOpenSettings };
}

const retryButton = () => screen.queryByRole('button', { name: /重试/ });
const settingsButton = () => screen.queryByRole('button', { name: /去设置/ });

describe('LookupErrorState', () => {
  afterEach(cleanup);

  it('says what happened in plain words, never showing the machine-readable code', () => {
    setup('[rate_limit] 请求过于频繁（429）：请稍后重试');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('请求太频繁了');
    expect(alert).not.toHaveTextContent('[rate_limit]');
  });

  it('sends a rejected key to Settings and does not offer a retry that cannot work', async () => {
    const { onRetry, onOpenSettings } = setup('[auth] 鉴权失败（401）：请检查 API Key 是否正确');

    await userEvent.click(screen.getByRole('button', { name: /去设置/ }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(retryButton()).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('asks for a key when there is none', () => {
    setup('[no_key] 尚未配置 API Key，请到设置页填写');

    expect(screen.getByRole('button', { name: /去设置 API Key/ })).toBeInTheDocument();
    expect(retryButton()).toBeNull();
  });

  it.each([
    ['rate_limit', '请求过于频繁（429）'],
    ['server', '服务端错误（503）'],
    ['timeout', '请求超时'],
    ['network', '无法连接到模型服务'],
    ['parse', 'JSON 解析失败'],
  ])('offers a plain retry, and no trip to Settings, for a transient [%s] failure', async (code, message) => {
    const { onRetry } = setup(`[${code}] ${message}`);

    expect(settingsButton()).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers both when a setting is the likely cause but another try is still reasonable', () => {
    setup('[truncated] 模型输出被截断（max_tokens=300），请提高最大 tokens 后重试');

    expect(settingsButton()).toBeInTheDocument();
    expect(retryButton()).toBeInTheDocument();
  });

  it('shows the provider\u2019s own complaint up front when that is the useful part', () => {
    setup('[http] HTTP 400: {"error":"unknown model gpt-9"}');

    expect(screen.getByText(/unknown model gpt-9/)).toBeVisible();
  });

  it('keeps the backend wording behind a disclosure when the title and hint already say it', () => {
    setup('[timeout] 请求超时，请检查网络连接或增加超时时间');

    expect(screen.getByText('详细信息')).toBeVisible();
    expect(screen.getByText(/请检查网络连接或增加超时时间/)).not.toBeVisible();
  });

  it.each([[null], ['connection refused'], ['[from_the_future] something new']])(
    'falls back to a generic message that can be retried for %j',
    async (error) => {
      const { onRetry } = setup(error);

      expect(screen.getByRole('alert')).toHaveTextContent('查词失败');
      await userEvent.click(screen.getByRole('button', { name: /重试/ }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );
});
