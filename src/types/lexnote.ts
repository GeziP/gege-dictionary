export type SelectionKind = 'word' | 'phrase' | 'sentence' | 'paragraph';

export type Register = 'formal' | 'neutral' | 'spoken' | 'slang' | 'technical';

export type Mastery = 'new' | 'learning' | 'familiar' | 'mastered';

export type CaptureMethod = 'clipboard' | 'manual';

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

export interface DomainFlowStep {
  label: string;
  description?: string;
}

export interface DomainWorkflow {
  title: string;
  steps: DomainFlowStep[];
}

export interface CodeExample {
  title: string;
  language: string;
  code: string;
  explanation?: string;
}

export interface AlgorithmAnalysis {
  name: string;
  summary?: string;
  steps: string[];
  timeComplexity?: string;
  spaceComplexity?: string;
  pseudocode?: string;
}

export interface ComputingAnalysis {
  domain: 'computing';
  overview: string;
  mechanism?: string[];
  workflow?: DomainWorkflow;
  algorithm?: AlgorithmAnalysis;
  codeExamples?: CodeExample[];
  tradeoffs?: string[];
}

export interface IvdMetric {
  name: string;
  meaning: string;
}

export interface IvdAnalysis {
  domain: 'medical_ivd';
  overview: string;
  principle?: string;
  specimen?: string[];
  analyte?: string;
  workflow?: DomainWorkflow;
  clinicalMeaning?: string;
  performanceMetrics?: IvdMetric[];
  interferences?: string[];
  qualityControl?: string[];
  limitations?: string[];
  standards?: string[];
}

export type DomainAnalysis = ComputingAnalysis | IvdAnalysis;

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
  domainAnalysis?: DomainAnalysis;
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
  /** Anki note this word was sent as; set by the backend, never by the UI. */
  ankiNoteId?: number;
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

/** What happened on one local calendar day. */
export interface InsightsDay {
  /** yyyy-MM-dd, the user's local day. */
  date: string;
  /** Lookups that got an answer (from the model or from the cache). */
  lookups: number;
  /** Words added to the library. */
  saved: number;
  /** Review cards answered. */
  reviews: number;
}

/** The figures behind the learning-insights page, as the backend computes them. */
export interface LearningInsights {
  /** The local day the figures are as of (yyyy-MM-dd). */
  today: string;
  /** How many days the chart and the window sums cover (7 to 90). */
  days: number;
  /** One entry for each day of the window, oldest first, zeros included. */
  daily: InsightsDay[];
  window: { lookups: number; saved: number; reviews: number };
  /** Words saved during the last seven days, today included. */
  savedThisWeek: number;
  streak: {
    /** Consecutive active days up to today (a run that ended yesterday still counts). */
    current: number;
    longest: number;
    /** Days with any activity, ever. */
    activeDays: number;
  };
  totals: { words: number; lookups: number };
  mastery: Record<Mastery, number>;
  review: {
    dueToday: number;
    /** Cards in the review boxes. */
    total: number;
    boxCounts: [number, number, number];
    /** Right and wrong answers over the cards' whole life. */
    correct: number;
    wrong: number;
  };
  topSources: Array<{ source: string; count: number }>;
  oftenLookedUp: Array<{ lemma: string; count: number }>;
  hardWords: Array<{ lemma: string; wrong: number }>;
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

/** One remembered lookup: what was asked, what the answer said about it, and how often. */
export interface LookupHistoryItem {
  id: number;
  /** The text that was looked up; cut to a preview when it is very long. */
  selection: string;
  lemma: string;
  translation: string;
  kind: SelectionKind;
  sourceApp: string;
  sourceTitle: string;
  /** How many times this was looked up. */
  count: number;
  /** ISO timestamps (UTC) of the first and the latest lookup. */
  firstAt: string;
  lastAt: string;
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
export type DomainProfile = 'general' | 'computing' | 'medical_ivd' | 'finance' | 'legal';
export type AnalysisStyle = 'concise' | 'standard' | 'deep';

export interface GlossaryTerm {
  id: string;
  term: string;
  translation: string;
  domain: DomainProfile;
  note: string;
  caseSensitive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GlossaryPage {
  items: GlossaryTerm[];
  total: number;
}

export interface GlossaryImportReport {
  inserted: number;
  updated: number;
  skipped: number;
  errorCount: number;
  errors: string[];
}

export interface ProviderConfig {
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  /** Backend never sends plaintext; true when a key is configured. */
  hasApiKey?: boolean;
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

export interface LocalMetrics {
  days: number;
  cutoffDate: string;
  todayQueries: number;
  queries: number;
  cacheHit: number;
  cacheMiss: number;
  cacheHitRate: number;
  filtered: number;
  filteredByReason: Record<string, number>;
  streamFallback: number;
  streamFirstFieldBuckets: Record<string, number>;
  reviewAnswered: number;
  sessionsViewed: number;
  glossaryApplied: number;
  ocrTriggered: number;
  ocrFiltered: number;
  ankiSendOk: number;
  ankiSendFail: number;
}

export interface AnkiFieldMap {
  front: string;
  back: string;
  extra: string;
  examples: string;
}

export interface AnkiSettings {
  enabled: boolean;
  host: string;
  port: number;
  deck: string;
  model: string;
  autoSend: boolean;
  fieldMap?: AnkiFieldMap;
  includeExamplesInExtra?: boolean;
}

export type CaptureContextMode = 'off' | 'selection_only' | 'surrounding';

export interface OcrSettings {
  enabled?: boolean;
  hotkey?: string;
  language?: string;
}

export interface AppSettings {
  provider: ProviderConfig;
  clipboardWatch: boolean;
  clipboardMode?: 'smart' | 'full' | 'double';
  clipboardBlacklist?: string[];
  lookupInIde?: boolean;
  ideBlacklist?: string[];
  streamingEnabled?: boolean;
  cacheTtlDays?: 0 | 7 | 30 | 90;
  /** Remember what was looked up (default on); turning it off keeps what is already there. */
  historyEnabled?: boolean;
  reviewLimit?: 0 | 10 | 20 | 50;
  includeLongFormReview?: boolean;
  sessionGapMinutes?: 15 | 30 | 60;
  activeDomainProfile: DomainProfile;
  analysisStyle: AnalysisStyle;
  autoCheckUpdates?: boolean;
  skippedUpdateVersion?: string;
  apiKeyError?: string;
  theme: 'light' | 'dark' | 'system';
  cardScale: 'compact' | 'default' | 'large';
  /** boolean is legacy: true→selection_only, false→off */
  captureContext: boolean | CaptureContextMode;
  contextHeuristicEnabled?: boolean;
  launchAtLogin: boolean;
  dataDir: string;
  autoBackup: boolean;
  ttsVoice: string;
  ttsRate: number;
  fontSize: number;
  anki?: AnkiSettings;
  ocr?: OcrSettings;
}
