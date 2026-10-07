import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../lib/tauri-bridge';
import { connectionOkText, useConnectionTest } from './useConnectionTest';

vi.mock('../lib/tauri-bridge', () => ({
  testConnection: vi.fn(),
}));

const provider = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-x', protocol: 'openai' };

describe('useConnectionTest', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('reports the latency and model the backend measured, not made-up numbers', async () => {
    vi.mocked(bridge.testConnection).mockResolvedValue({ ok: true, latency: 87, model: 'gpt-x-2025' });
    const { result } = renderHook(() => useConnectionTest(provider));
    expect(result.current.state).toEqual({ status: 'idle' });

    await act(() => result.current.test());

    expect(result.current.state).toEqual({ status: 'ok', latency: 87, model: 'gpt-x-2025' });
    expect(bridge.testConnection).toHaveBeenCalledWith('https://api.example.com/v1', 'sk-test', 'gpt-x', 'openai');
  });

  it('shows the real reason a test failed, without the machine-readable code', async () => {
    vi.mocked(bridge.testConnection).mockRejectedValue('[timeout] 请求超时，请检查网络连接或增加超时时间');
    const { result } = renderHook(() => useConnectionTest(provider));

    await act(() => result.current.test());

    expect(result.current.state).toEqual({ status: 'error', message: '请求超时，请检查网络连接或增加超时时间' });
  });

  it('does not blame the API key for a failure that is not about the key', async () => {
    vi.mocked(bridge.testConnection).mockRejectedValue('[network] 无法连接到模型服务，请检查 Base URL 是否正确');
    const { result } = renderHook(() => useConnectionTest(provider));

    await act(() => result.current.test());

    const state = result.current.state;
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.message).not.toMatch(/401|鉴权|API Key/);
  });

  it('copes with a backend answer that carries no latency', async () => {
    vi.mocked(bridge.testConnection).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof bridge.testConnection>>);
    const { result } = renderHook(() => useConnectionTest(provider));

    await act(() => result.current.test());

    expect(result.current.state).toEqual({ status: 'ok', latency: null, model: 'gpt-x' });
  });

  it('drops a result as soon as a setting it was measured against changes', async () => {
    vi.mocked(bridge.testConnection).mockResolvedValue({ ok: true, latency: 50, model: 'gpt-x' });
    const { result, rerender } = renderHook((props) => useConnectionTest(props), { initialProps: provider });
    await act(() => result.current.test());
    expect(result.current.state.status).toBe('ok');

    rerender({ ...provider, apiKey: 'sk-another' });

    await waitFor(() => expect(result.current.state).toEqual({ status: 'idle' }));
  });

  it('ignores a slow test that finishes after the settings changed', async () => {
    let finish: (value: { ok: boolean; latency: number; model: string }) => void = () => undefined;
    vi.mocked(bridge.testConnection).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook((props) => useConnectionTest(props), { initialProps: provider });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.test();
    });
    await waitFor(() => expect(result.current.state.status).toBe('testing'));

    rerender({ ...provider, baseUrl: 'https://other.example.com/v1' });
    await waitFor(() => expect(result.current.state.status).toBe('idle'));

    await act(async () => {
      finish({ ok: true, latency: 10, model: 'stale' });
      await pending;
    });

    expect(result.current.state).toEqual({ status: 'idle' });
  });
});

describe('connectionOkText', () => {
  it('includes the latency only when it is known', () => {
    expect(connectionOkText({ status: 'ok', latency: 120, model: 'm' })).toBe('连接正常 · 120ms · 模型回显 m');
    expect(connectionOkText({ status: 'ok', latency: null, model: 'm' })).toBe('连接正常 · 模型回显 m');
  });
});
