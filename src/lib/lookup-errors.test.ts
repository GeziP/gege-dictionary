import { describe, expect, it } from 'vitest';
import { connectionTestMessage, LOOKUP_ERROR_CODES, parseLookupError } from './lookup-errors';

describe('parseLookupError', () => {
  it('reads the code and strips the prefix from the detail', () => {
    for (const code of LOOKUP_ERROR_CODES) {
      const info = parseLookupError(`[${code}] something specific`);
      expect(info.code).toBe(code);
      expect(info.detail).toBe('something specific');
    }
  });

  it('gives every code a title and a hint that are plain text', () => {
    for (const code of LOOKUP_ERROR_CODES) {
      const info = parseLookupError(`[${code}] x`);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.hint.length).toBeGreaterThan(0);
      expect(info.title).not.toContain('[');
      expect(info.hint).not.toContain('[');
    }
  });

  it('is decided by the code alone, never by the wording of the message', () => {
    // These messages mention a different failure than their code says.
    expect(parseLookupError('[network] 鉴权失败（401）').code).toBe('network');
    expect(parseLookupError('[auth] request timed out').code).toBe('auth');
    expect(parseLookupError('[rate_limit] 连接失败 timeout 401').code).toBe('rate_limit');
  });

  it('treats a message without a code as unknown, whatever it says', () => {
    for (const text of ['401 Unauthorized', 'request timed out', '请求超时', 'connection refused']) {
      const info = parseLookupError(text);
      expect(info.code).toBe('unknown');
      expect(info.detail).toBe(text);
    }
  });

  it('treats an unregistered code as unknown and still removes the prefix', () => {
    const info = parseLookupError('[from_the_future] boom');
    expect(info.code).toBe('unknown');
    expect(info.detail).toBe('boom');
  });

  it('does not mistake ordinary bracketed text for a code', () => {
    const info = parseLookupError('[Errno 11] Resource temporarily unavailable');
    expect(info.code).toBe('unknown');
    expect(info.detail).toBe('[Errno 11] Resource temporarily unavailable');
  });

  it('tolerates leading whitespace, upper case and an Error wrapper', () => {
    expect(parseLookupError('  [AUTH] x').code).toBe('auth');
    expect(parseLookupError('Error: [timeout] x').code).toBe('timeout');
    expect(parseLookupError(new Error('[rate_limit] slow down')).code).toBe('rate_limit');
    expect(parseLookupError(new Error('[rate_limit] slow down')).detail).toBe('slow down');
  });

  it('survives values that are not strings', () => {
    for (const value of [null, undefined, '', '   ']) {
      const info = parseLookupError(value);
      expect(info.code).toBe('unknown');
      expect(info.detail).toBe('');
    }
    expect(parseLookupError(42).detail).toBe('42');
  });

  it('keeps a multi-line detail intact', () => {
    expect(parseLookupError('[http] HTTP 400: {\n  "error": "bad"\n}').detail).toBe('HTTP 400: {\n  "error": "bad"\n}');
  });
});

describe('what each failure asks the user to do', () => {
  const advice = (code: string) => {
    const info = parseLookupError(`[${code}] x`);
    return [info.action, info.retryable] as const;
  };

  it('sends credential and model problems to Settings, where retrying alone cannot help', () => {
    for (const code of ['no_key', 'auth', 'model']) {
      expect(advice(code)).toEqual(['settings', false]);
    }
  });

  it('offers a plain retry for transient failures', () => {
    for (const code of ['rate_limit', 'server', 'timeout', 'network', 'parse', 'empty', 'api', 'internal', 'unknown']) {
      expect(advice(code)).toEqual(['retry', true]);
    }
  });

  it('points to Settings but also allows a retry when a setting is the likely cause', () => {
    for (const code of ['http', 'truncated']) {
      expect(advice(code)).toEqual(['settings', true]);
    }
  });

  it('shows the detail up front only where it is the useful part', () => {
    const inline = LOOKUP_ERROR_CODES.filter((code) => parseLookupError(`[${code}] x`).showDetailInline);
    expect([...inline].sort()).toEqual(['api', 'http', 'internal', 'unknown']);
  });
});

describe('connectionTestMessage', () => {
  it('returns the backend wording without the code prefix', () => {
    expect(connectionTestMessage('[auth] 鉴权失败（401）：请检查 API Key 是否正确')).toBe(
      '鉴权失败（401）：请检查 API Key 是否正确'
    );
  });

  it('falls back to the title when there is no detail', () => {
    expect(connectionTestMessage('[timeout]')).toBe(parseLookupError('[timeout]').title);
    expect(connectionTestMessage(undefined)).toBe(parseLookupError(undefined).title);
  });

  it('reports a failure that carries no code as-is', () => {
    expect(connectionTestMessage('something odd')).toBe('something odd');
  });
});
