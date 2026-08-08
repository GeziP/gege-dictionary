export type SelectionKind = 'word' | 'phrase' | 'sentence' | 'paragraph';

export type Register = 'formal' | 'neutral' | 'spoken' | 'slang' | 'technical';

export type Mastery = 'new' | 'familiar' | 'mastered';

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
  clipboardMode?: 'smart' | 'full' | 'manual';
  clipboardBlacklist?: string[];
  streamingEnabled?: boolean;
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