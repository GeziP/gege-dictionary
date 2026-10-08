import { useCallback, useEffect, useRef, useState } from 'react';
import { connectionTestMessage } from '../lib/lookup-errors';

export type ConnectionTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; latency: number | null; model: string }
  | { status: 'error'; message: string };

interface ProviderUnderTest {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: string;
}

const IDLE: ConnectionTestState = { status: 'idle' };

/** "连接正常 · 412ms · 模型回显 x", from what the backend measured and the model that answered. */
export function connectionOkText(state: Extract<ConnectionTestState, { status: 'ok' }>): string {
  const latency = state.latency === null ? '' : ` · ${state.latency}ms`;
  return `连接正常${latency} · 模型回显 ${state.model}`;
}

/**
 * Runs the provider connection test and keeps its result honest. A result belongs to the
 * settings it was measured against, so it is dropped the moment one of them changes, and a
 * slow test that finishes afterwards cannot bring a stale answer back.
 */
export function useConnectionTest({ baseUrl, apiKey, model, protocol }: ProviderUnderTest) {
  const [state, setState] = useState<ConnectionTestState>(IDLE);
  const latestRun = useRef(0);

  useEffect(() => {
    latestRun.current += 1;
    setState(IDLE);
  }, [baseUrl, apiKey, model, protocol]);

  const test = useCallback(async () => {
    const run = ++latestRun.current;
    setState({ status: 'testing' });
    try {
      const { testConnection } = await import('../lib/tauri-bridge');
      const result = await testConnection(baseUrl, apiKey, model, protocol);
      if (run !== latestRun.current) return;
      setState({
        status: 'ok',
        latency: typeof result.latency === 'number' ? result.latency : null,
        model: result.model || model,
      });
    } catch (error) {
      if (run !== latestRun.current) return;
      setState({ status: 'error', message: connectionTestMessage(error) });
    }
  }, [baseUrl, apiKey, model, protocol]);

  return { state, test };
}
