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

/** What the backend adds to a lookup answer on top of the entry itself. */
export type EntryMetadata = Entry & {
  _templateName?: string;
  fromCache?: boolean;
  /** The model that wrote the answer; answers cached before v1.10 do not say. */
  _model?: string;
  /** Set when the main model could not answer and the backup one did. */
  _viaBackup?: boolean;
};

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

/**
 * How a card was answered: knew it, knew it but only just, or did not know it. The backend
 * stores and reports these three words as they are.
 */
export type ReviewAnswer = 'correct' | 'hard' | 'wrong';

export interface ReviewState {
  wordId: string;
  box: 1 | 2 | 3;
  dueAt: string;
  lastResult?: ReviewAnswer | null;
  correctCount: number;
  hardCount: number;
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

export type EnrichmentPace = 'gentle' | 'normal' | 'fast';

/** Where a batch enrichment run stands. `stopping` is a run that was stopped and is finishing its last request. */
export type EnrichmentState = 'idle' | 'running' | 'paused' | 'stopping' | 'finished' | 'stopped';

/** Why a run ended before it was through, other than because the user stopped it. */
export interface EnrichmentStopReason {
  /** A lookup error code (`no_key`, `auth`, `model`, `rate_limit`, ...), `budget`, or `repeated`. */
  code: string;
  /** The backend's own `[code] message` wording. */
  message: string;
}

export interface EnrichmentFailure {
  lemma: string;
  code: string;
  message: string;
}

/** What the backend says about a run, as it goes. */
export interface EnrichmentProgress {
  /** Which run this is since the app was started (0: none yet). */
  run: number;
  state: EnrichmentState;
  /** The words the run set out to do. */
  total: number;
  done: number;
  failed: number;
  /** Words that no longer needed it when their turn came. */
  skipped: number;
  /** Estimated tokens the run has used. */
  tokens: number;
  /** The word being asked about. */
  current: string | null;
  stoppedBecause: EnrichmentStopReason | null;
  /** The first words that failed, and why; `failed` counts all of them. */
  failures: EnrichmentFailure[];
}

export interface EnrichmentStatus {
  /** Words that have only a form and a meaning: what a run would work on. */
  pending: number;
  /** Estimated tokens used today by lookups and the batch together. */
  tokensToday: number;
  /** The most the day's use may grow to by the batch; null when there is no limit. */
  dailyLimit: number | null;
  progress: EnrichmentProgress;
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
    /** Answers of each kind over the cards' whole life. */
    correct: number;
    hard: number;
    wrong: number;
  };
  /** The review cards answered, day by day, over the last twelve weeks. */
  reviewCalendar: ReviewCalendar;
  topSources: Array<{ source: string; count: number }>;
  oftenLookedUp: Array<{ lemma: string; count: number }>;
  /** Words that were forgotten or found hard, the worst first. */
  hardWords: Array<{ lemma: string; wrong: number; hard: number }>;
}

/** The review cards answered on one local day, and how they were answered. */
export interface ReviewCalendarDay {
  /** yyyy-MM-dd. */
  date: string;
  /** Every card answered, including those whose kind of answer was not recorded. */
  total: number;
  correct: number;
  hard: number;
  wrong: number;
}

export interface ReviewCalendar {
  /** The Monday the first day falls on, so that days go straight into weeks of seven. */
  first: string;
  weeks: number;
  /** From `first` up to today, oldest first, days without any answer included as zeros. */
  days: ReviewCalendarDay[];
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

/**
 * A second model service for the moments the main one cannot answer: it is too busy, down,
 * unreachable or too slow. It is asked once, and only after the main one failed in one of those
 * ways; a rejected key or an unknown model never sends a lookup to it.
 */
export interface BackupProviderConfig extends ProviderConfig {
  enabled: boolean;
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
  /** Lookups that the backup model answered because the main one was struggling. */
  backupUsed: number;
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
}

export interface AppSettings {
  provider: ProviderConfig;
  backupProvider: BackupProviderConfig;
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
  /** The most tokens (lookups and batch together) the day's use may grow to by the batch enrichment; 0 is no limit. */
  enrichDailyTokens?: number;
  /** How quickly the batch enrichment sends its requests. */
  enrichPace?: EnrichmentPace;
  /** The days of a week (1 to 7) the user wants to learn on; 0 is no goal. */
  weeklyGoalDays?: number;
  activeDomainProfile: DomainProfile;
  analysisStyle: AnalysisStyle;
  autoCheckUpdates?: boolean;
  skippedUpdateVersion?: string;
  apiKeyError?: string;
  backupApiKeyError?: string;
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
