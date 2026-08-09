export type SelectionKind = 'word' | 'phrase' | 'sentence' | 'paragraph';

export type Register = 'formal' | 'neutral' | 'spoken' | 'slang' | 'technical';

export type Mastery = 'new' | 'learning' | 'familiar' | 'mastered';

export type CaptureMethod = 'uia' | 'clipboard' | 'manual';

export interface Sense {
  pos: string;
  gloss: string;
  translation: string;
}

export interface Example {
  en: string;
  zh: string;
}

export interface Association {
  kind: 'root' | 'synonym' | 'confusable';
  title: string;
  detail: string;
}

export interface SyntaxPart {
  part: string;
  note: string;
}

export interface KeyTerm {
  term: string;
  gloss: string;
}

export interface TranslationPair {
  en: string;
  zh: string;
}

export interface Entry {
  id: string;
  selection: string;
  lemma: string;
  pos: string;
  ipaUS: string;
  ipaUK: string;
  translation: string;
  contextMeaning: string;
  explanation: string;
  senses: Sense[];
  associations: Association[];
  examples: Example[];
  collocations: string[];
  register: Register;
  kind: SelectionKind;
  syntax?: SyntaxPart[];
  keyTerms?: KeyTerm[];
  translationPairs?: TranslationPair[];
}

export interface SavedWord extends Entry {
  savedAt: string;
  context: string;
  sourceApp: string;
  sourceTitle: string;
  tags: string[];
  mastery: Mastery;
  lookups: number;
  note: string;
  reviewState?: ReviewState;
}

export interface ReviewState {
  wordId: string;
  box: 1 | 2 | 3;
  dueAt: string;
  lastResult?: 'correct' | 'wrong' | null;
  correctCount: number;
  wrongCount: number;
  reviewedAt?: string | null;
  previousBox?: number;
}

export interface ReviewStats {
  dueCount: number;
  boxCounts: [number, number, number];
  nextDueAt?: string | null;
  total: number;
}

export interface ReadingSession {
  id: string;
  sourceApp: string;
  sourceTitle: string;
  startAt: string;
  endAt: string;
  wordCount: number;
  preview: string[];
  wordIds: string[];
}

export interface LookupRequest {
  selection: string;
  context: string;
  kind: SelectionKind;
  method: CaptureMethod;
  sourceApp: string;
  sourceTitle: string;
  anchor: {x: number;y: number;};
}

export type NetworkMode = 'ok' | 'cached' | 'timeout' | 'auth' | 'offline' | 'malformed';

export type ApiProtocol = 'openai' | 'anthropic';

export interface ProviderConfig {
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  scope: SelectionKind | 'all';
  body: string;
  builtIn: boolean;
}

export interface AppSettings {
  provider: ProviderConfig;
  clipboardWatch: boolean;
  clipboardMode?: 'smart' | 'full' | 'double';
  clipboardBlacklist?: string[];
  streamingEnabled?: boolean;
  cacheTtlDays?: 0 | 7 | 30 | 90;
  reviewLimit?: 0 | 10 | 20 | 50;
  includeLongFormReview?: boolean;
  sessionGapMinutes?: 15 | 30 | 60;
  autoCheckUpdates?: boolean;
  skippedUpdateVersion?: string;
  apiKeyError?: string;
  theme: 'light' | 'dark' | 'system';
  cardScale: 'compact' | 'default' | 'large';
  captureContext: boolean;
  launchAtLogin: boolean;
  dataDir: string;
  autoBackup: boolean;
  anonymousStats: boolean;
  ttsVoice: string;
  ttsRate: number;
  fontSize: number;
}
