/**
 * Every lookup / connection-test failure reaches the UI as a string shaped like
 * `[code] message`. The backend (`ERROR_CODES` in src-tauri/src/llm.rs) picks the
 * code from the real cause - the HTTP status, the kind of transport error, a parse
 * failure - and this module turns the code into advice.
 *
 * Nothing here guesses from the wording of a message, so rewording or translating a
 * message can never change what the user is told to do. The list below is checked
 * against the Rust one by a test in llm.rs, so the two cannot drift apart.
 */
export const LOOKUP_ERROR_CODES = [
  'no_key',
  'auth',
  'model',
  'rate_limit',
  'server',
  'http',
  'timeout',
  'network',
  'parse',
  'empty',
  'truncated',
  'api',
  'internal',
  'unknown',
] as const;

export type LookupErrorCode = (typeof LOOKUP_ERROR_CODES)[number];

/** What the user can do about it: fix something in Settings, or just try again. */
export type LookupErrorAction = 'settings' | 'retry';

export interface LookupErrorInfo {
  code: LookupErrorCode;
  /** One line saying what went wrong. */
  title: string;
  /** What to try next. */
  hint: string;
  /** The backend's own wording without the `[code] ` prefix - often the provider's exact complaint. */
  detail: string;
  /** Where the fix lives. */
  action: LookupErrorAction;
  /** Whether sending the same request again can plausibly succeed. */
  retryable: boolean;
  /** Whether `detail` says something the title and hint cannot, so it is worth showing up front. */
  showDetailInline: boolean;
}

type ErrorCopy = Omit<LookupErrorInfo, 'code' | 'detail'>;

const COPY: Record<LookupErrorCode, ErrorCopy> = {
  no_key: {
    title: '还没有配置 API Key',
    hint: '到设置页填入模型服务的 API Key，之后就可以查词了。',
    action: 'settings',
    retryable: false,
    showDetailInline: false,
  },
  auth: {
    title: 'API Key 无效或权限不足',
    hint: '请检查 Key 是否填写正确、是否已过期，以及账户额度是否用完。',
    action: 'settings',
    retryable: false,
    showDetailInline: false,
  },
  model: {
    title: '找不到模型或服务地址',
    hint: '请检查设置里的模型名称和 Base URL 是否正确。',
    action: 'settings',
    retryable: false,
    showDetailInline: false,
  },
  rate_limit: {
    title: '请求太频繁了',
    hint: '模型服务商暂时限流，等几秒再重试即可。',
    action: 'retry',
    retryable: true,
    showDetailInline: false,
  },
  server: {
    title: '模型服务暂时不可用',
    hint: '这是服务商那边的问题，稍后重试。',
    action: 'retry',
    retryable: true,
    showDetailInline: false,
  },
  http: {
    title: '模型服务拒绝了这次请求',
    hint: '请检查模型名称、最大 tokens 等参数是否被该服务商接受。',
    action: 'settings',
    retryable: true,
    showDetailInline: true,
  },
  timeout: {
    title: '请求超时',
    hint: '可以在设置里调大超时秒数，或换一个响应更快的模型。',
    action: 'retry',
    retryable: true,
    showDetailInline: false,
  },
  network: {
    title: '连不上模型服务',
    hint: '请检查网络、代理设置，以及 Base URL 是否正确。',
    action: 'retry',
    retryable: true,
    showDetailInline: false,
  },
  parse: {
    title: '模型返回的内容无法解析',
    hint: '通常重试一次就好；反复出现时，可以调大最大 tokens 或换一个更稳定的模型。',
    action: 'retry',
    retryable: true,
    showDetailInline: false,
  },
  empty: {
    title: '模型没有返回内容',
    hint: '重试一次；反复出现时，请确认该模型支持当前选择的协议。',
    action: 'retry',
    retryable: true,
    showDetailInline: false,
  },
  truncated: {
    title: '模型输出被截断了',
    hint: '请在设置里调大“最大 tokens”后重试。',
    action: 'settings',
    retryable: true,
    showDetailInline: false,
  },
  api: {
    title: '模型服务返回了错误',
    hint: '具体原因见下方。',
    action: 'retry',
    retryable: true,
    showDetailInline: true,
  },
  internal: {
    title: '应用内部出错了',
    hint: '重试一次；如果持续出现，请到 GitHub 反馈。',
    action: 'retry',
    retryable: true,
    showDetailInline: true,
  },
  unknown: {
    title: '查词失败',
    hint: '请重试；如果持续失败，请检查设置里的模型服务配置。',
    action: 'retry',
    retryable: true,
    showDetailInline: true,
  },
};

const CODE_PREFIX = /^\s*\[([a-z_]+)\]\s*/i;
const ERROR_OBJECT_PREFIX = /^Error:\s*/;

function isLookupErrorCode(value: string): value is LookupErrorCode {
  return (LOOKUP_ERROR_CODES as readonly string[]).includes(value);
}

function messageOf(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === 'string') return raw;
  return raw == null ? '' : String(raw);
}

/** Split a `[code] message` string into its code and advice. Anything without a known code is `unknown`. */
export function parseLookupError(raw: unknown): LookupErrorInfo {
  const text = messageOf(raw).replace(ERROR_OBJECT_PREFIX, '').trim();
  const match = CODE_PREFIX.exec(text);
  const candidate = match?.[1]?.toLowerCase() ?? '';
  const code: LookupErrorCode = isLookupErrorCode(candidate) ? candidate : 'unknown';
  const detail = (match ? text.slice(match[0].length) : text).trim();
  return { code, detail, ...COPY[code] };
}

/** One line for a connection-test result: the backend's own wording, without the code prefix. */
export function connectionTestMessage(raw: unknown): string {
  const info = parseLookupError(raw);
  return info.detail || info.title;
}
