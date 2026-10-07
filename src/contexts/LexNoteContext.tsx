/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PROVIDER, DEFAULT_TEMPLATES } from '../data/providers';
import type {
  AppSettings,
  CaptureMethod,
  Entry,
  NetworkMode,
  PromptTemplate,
  SavedWord,
} from '../types/lexnote';
import * as bridge from '../lib/tauri-bridge';
import { upsertSavedWord } from '../lib/words';

const DEFAULT_SETTINGS: AppSettings = {
  provider: DEFAULT_PROVIDER,
  clipboardWatch: true,
  theme: 'system',
  cardScale: 'default',
  captureContext: true,
  launchAtLogin: false,
  dataDir: '',
  autoBackup: true,
  ttsVoice: 'Microsoft Zira',
  ttsRate: 1,
  fontSize: 13,
  clipboardMode: 'smart',
  clipboardBlacklist: [],
  lookupInIde: true,
  ideBlacklist: [
    'code.exe',
    'devenv.exe',
    'idea64.exe',
    'cursor.exe',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'windowsterminal.exe',
  ],
  streamingEnabled: true,
  cacheTtlDays: 30,
  reviewLimit: 20,
  includeLongFormReview: false,
  sessionGapMinutes: 30,
  activeDomainProfile: 'general',
  analysisStyle: 'standard',
  autoCheckUpdates: true,
  skippedUpdateVersion: '',
  anki: {
    enabled: false,
    host: '127.0.0.1',
    port: 8765,
    deck: 'Default',
    model: 'Basic',
    autoSend: false,
  },
  ocr: {
    enabled: true,
    hotkey: 'Control+Shift+O',
    language: 'en-US',
  },
};

type SettingsPatch = Omit<Partial<AppSettings>, 'provider'> & {
  provider?: Partial<AppSettings['provider']>;
};

function applySettingsPatch(base: AppSettings, patch: SettingsPatch): AppSettings {
  const { provider, ...rest } = patch;
  return {
    ...base,
    ...rest,
    ...(provider ? { provider: { ...base.provider, ...provider } } : {}),
  };
}

function normalizeSettingsPatch(base: AppSettings, patch: SettingsPatch): SettingsPatch {
  const normalized: SettingsPatch = { ...patch };
  if (patch.provider) {
    const providerPatch: Partial<AppSettings['provider']> = {};
    for (const key of Object.keys(patch.provider) as Array<keyof AppSettings['provider']>) {
      const value = patch.provider[key];
      if (value !== base.provider[key]) {
        (providerPatch as Record<string, unknown>)[key] = value;
      }
    }
    normalized.provider = providerPatch;
  }
  return normalized;
}

interface Usage {
  today: number;
  month: number;
  tokens: number;
}

export type LookupStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error';
export type InitState = 'loading' | 'ready';
export type SettingsSaveStatus = 'idle' | 'saving' | 'error';

interface LexNoteValue {
  words: SavedWord[];
  tags: string[];
  settings: AppSettings;
  settingsSaveStatus: SettingsSaveStatus;
  settingsSaveError: string | null;
  templates: PromptTemplate[];
  usage: Usage;
  network: NetworkMode;
  captureMethod: CaptureMethod;
  onboarded: boolean;
  initState: InitState;
  lookupStatus: LookupStatus;
  lookupResult: Entry | null;
  lookupError: string | null;
  lookupSelection: string;
  lookupContext: string;
  lookupSourceApp: string;
  lookupSourceTitle: string;
  startupWarnings: string[];
  setNetwork: (mode: NetworkMode) => void;
  setCaptureMethod: (method: CaptureMethod) => void;
  setOnboarded: (value: boolean) => void;
  updateSettings: (patch: SettingsPatch) => void;
  /** Saves a lookup; resolves with the word as stored (merged with an existing one). */
  saveWord: (word: SavedWord) => Promise<SavedWord>;
  removeWords: (ids: string[]) => void;
  updateWord: (id: string, patch: Partial<SavedWord>) => void;
  tagWords: (ids: string[], tags: string[]) => void;
  batchSetMastery: (ids: string[], mastery: SavedWord['mastery']) => void;
  countLookup: (tokens: number) => void;
  saveTemplate: (template: PromptTemplate) => void;
  resetTemplates: () => void;
  triggerLookup: (selection: string, context: string, kind: string, sourceApp?: string, sourceTitle?: string, forceRefresh?: boolean) => void;
  /** Looks the same text up again, as the same kind it was first looked up as. */
  retryLookup: (context?: string) => void;
  clearLookup: () => void;
  refreshWords: () => void;
  refreshAppState: () => Promise<void>;
  flushSettings: () => Promise<void>;
}

const LexNoteContext = createContext<LexNoteValue | null>(null);

/**
 * `loadWords` is turned off for the small lookup and OCR windows. They only
 * ever ask the backend about one word, so loading the whole library into each
 * of them (on every cold start) was work that grows with the library for no
 * benefit.
 */
export function LexNoteProvider({
  children,
  loadWords = true,
}: {
  children: React.ReactNode;
  loadWords?: boolean;
}) {
  const isTauri = bridge.isTauri();

  const [words, setWords] = useState<SavedWord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const confirmedSettingsRef = useRef<AppSettings>(DEFAULT_SETTINGS);
  const pendingSettingsRef = useRef<SettingsPatch[]>([]);
  const drainingSettingsRef = useRef(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<SettingsSaveStatus>('idle');
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [network, setNetwork] = useState<NetworkMode>('ok');
  const [captureMethod, setCaptureMethod] = useState<CaptureMethod>('clipboard');
  const [onboarded, setOnboarded] = useState(false);
  const [usage, setUsage] = useState<Usage>({ today: 0, month: 0, tokens: 0 });
  const [startupWarnings, setStartupWarnings] = useState<string[]>([]);

  const [initState, setInitState] = useState<InitState>(isTauri ? 'loading' : 'ready');
  const [lookupStatus, setLookupStatus] = useState<LookupStatus>('idle');
  const [lookupResult, setLookupResult] = useState<Entry | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupSelection, setLookupSelection] = useState('');
  const [lookupContext, setLookupContext] = useState('');
  const [lookupSourceApp, setLookupSourceApp] = useState('');
  const [lookupSourceTitle, setLookupSourceTitle] = useState('');
  const [lookupListenersReady, setLookupListenersReady] = useState(false);

  const refreshWords = useCallback(async () => {
    if (!isTauri || !loadWords) return;
    try {
      const data = await bridge.getAllWords();
      setWords(data as SavedWord[]);
    } catch (e) {
      console.error('Failed to load words:', e);
    }
  }, [isTauri, loadWords]);

  const refreshStartupWarnings = useCallback(async () => {
    if (!isTauri) return;
    try {
      const warnings = await bridge.getStartupWarnings();
      setStartupWarnings(warnings.map((warning) => warning.message));
    } catch (error) {
      console.error('Failed to load startup warnings:', error);
    }
  }, [isTauri]);

  const refreshAppState = useCallback(async () => {
    if (!isTauri) return;
    const [dbWords, dbSettings, dbTemplates, dbUsage, dbWarnings] = await Promise.allSettled([
      loadWords ? bridge.getAllWords() : Promise.resolve<SavedWord[] | null>(null),
      bridge.getSettings(),
      bridge.getTemplates(),
      bridge.getUsage(),
      bridge.getStartupWarnings(),
    ]);

    if (dbWords.status === 'fulfilled' && dbWords.value) {
      setWords(dbWords.value as SavedWord[]);
    }
    if (dbSettings.status === 'fulfilled') {
      const saved = dbSettings.value as Partial<AppSettings>;
      if (saved.provider) {
        const merged = {
          ...DEFAULT_SETTINGS,
          ...saved,
          provider: { ...DEFAULT_PROVIDER, ...saved.provider },
        } as AppSettings;
        confirmedSettingsRef.current = merged;
        const optimistic = pendingSettingsRef.current.reduce(applySettingsPatch, merged);
        settingsRef.current = optimistic;
        setSettings(optimistic);
        setOnboarded(Boolean(optimistic.provider.apiKey));
      } else {
        setOnboarded(false);
      }
    }
    if (dbTemplates.status === 'fulfilled') {
      const userTemplates = (dbTemplates.value as PromptTemplate[]).filter((tpl) => !tpl.builtIn);
      const merged = [...DEFAULT_TEMPLATES.filter((tpl) => tpl.builtIn), ...userTemplates];
      setTemplates(merged);
    }
    if (dbUsage.status === 'fulfilled') {
      setUsage(dbUsage.value);
    }
    if (dbWarnings.status === 'fulfilled') {
      setStartupWarnings(dbWarnings.value.map((warning) => warning.message));
    }
  }, [isTauri, loadWords]);

  useEffect(() => {
    if (!isTauri) return;
    void refreshAppState().finally(() => setInitState('ready'));
  }, [isTauri, refreshAppState]);

  useEffect(() => {
    if (!isTauri) return;
    const interval = window.setInterval(() => void refreshStartupWarnings(), 30_000);
    return () => window.clearInterval(interval);
  }, [isTauri, refreshStartupWarnings]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersDark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', prefersDark);
  }, [settings.theme]);

  const drainSettingsQueue = useCallback(async () => {
    if (!isTauri || drainingSettingsRef.current) return;
    drainingSettingsRef.current = true;
    setSettingsSaveStatus('saving');
    setSettingsSaveError(null);
    let lastError: unknown = null;
    try {
      while (pendingSettingsRef.current.length > 0) {
        const patch = pendingSettingsRef.current[0];
        const snapshot = applySettingsPatch(confirmedSettingsRef.current, patch);
        try {
          await bridge.saveSettings(snapshot);
          confirmedSettingsRef.current = snapshot;
          pendingSettingsRef.current.shift();
        } catch (error) {
          lastError = error;
          pendingSettingsRef.current.shift();
          const rebased = pendingSettingsRef.current.reduce(applySettingsPatch, confirmedSettingsRef.current);
          settingsRef.current = rebased;
          setSettings(rebased);
        }
      }
    } finally {
      drainingSettingsRef.current = false;
      const finalSettings = pendingSettingsRef.current.reduce(applySettingsPatch, confirmedSettingsRef.current);
      settingsRef.current = finalSettings;
      setSettings(finalSettings);
      if (lastError) {
        setSettingsSaveStatus('error');
        setSettingsSaveError(String(lastError));
      } else {
        setSettingsSaveStatus('idle');
      }
    }
  }, [isTauri]);

  const updateSettings = useCallback(
    (patch: SettingsPatch) => {
      const previous = settingsRef.current;
      const next = applySettingsPatch(previous, patch);
      settingsRef.current = next;
      setSettings(next);
      if (!isTauri) return;
      pendingSettingsRef.current.push(normalizeSettingsPatch(previous, patch));
      setSettingsSaveStatus('saving');
      setSettingsSaveError(null);
      void drainSettingsQueue();
    },
    [drainSettingsQueue, isTauri]
  );

  const flushSettings = useCallback(async () => {
    while (drainingSettingsRef.current) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }, []);

  const saveWord = useCallback(
    async (word: SavedWord): Promise<SavedWord> => {
      if (!isTauri) {
        setWords((prev) => upsertSavedWord(prev, word));
        return word;
      }
      // The backend merges the word with one that is already saved (mastery,
      // note, tags and the Anki link survive), so what gets shown is the
      // document it returns, not the one that was sent. Nothing is shown ahead
      // of time: a save that fails must not leave a phantom word behind.
      const stored = await bridge.saveWord(word);
      setWords((prev) => upsertSavedWord(prev, stored));
      bridge.emitWordSaved().catch(console.error);
      return stored;
    },
    [isTauri]
  );

  // The edits below are applied to the list at once and confirmed by the
  // backend afterwards. If it refuses, the list is reloaded so the screen
  // shows what is really stored instead of an edit that never happened.
  const reloadAfterFailure = useCallback(
    (error: unknown) => {
      console.error(error);
      void refreshWords();
    },
    [refreshWords]
  );

  const removeWords = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      setWords((prev) => prev.filter((w) => !gone.has(w.id)));
      if (isTauri) {
        bridge
          .deleteWords(ids)
          .then(() => bridge.emitWordSaved())
          .catch(reloadAfterFailure);
      }
    },
    [isTauri, reloadAfterFailure]
  );

  const updateWord = useCallback(
    (id: string, patch: Partial<SavedWord>) => {
      setWords((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
      if (isTauri) {
        bridge
          .updateWord(id, patch)
          .then(() => bridge.emitWordSaved())
          .catch(reloadAfterFailure);
      }
    },
    [isTauri, reloadAfterFailure]
  );

  const tagWords = useCallback(
    (ids: string[], newTags: string[]) => {
      const tags = newTags.map((tag) => tag.trim()).filter(Boolean);
      if (ids.length === 0 || tags.length === 0) return;
      const targets = new Set(ids);
      setWords((prev) =>
        prev.map((w) =>
          targets.has(w.id) ? { ...w, tags: Array.from(new Set([...w.tags, ...tags])) } : w
        )
      );
      if (isTauri) {
        bridge.batchUpdateWords(ids, { addTags: tags }).catch(reloadAfterFailure);
      }
    },
    [isTauri, reloadAfterFailure]
  );

  const batchSetMastery = useCallback(
    (ids: string[], mastery: SavedWord['mastery']) => {
      if (ids.length === 0) return;
      const targets = new Set(ids);
      setWords((prev) => prev.map((w) => (targets.has(w.id) ? { ...w, mastery } : w)));
      if (isTauri) {
        bridge.batchUpdateWords(ids, { mastery }).catch(reloadAfterFailure);
      }
    },
    [isTauri, reloadAfterFailure]
  );

  const countLookup = useCallback(
    (tokens: number) => {
      setUsage((prev) => ({
        today: prev.today + 1,
        month: prev.month + 1,
        tokens: prev.tokens + tokens,
      }));
      if (isTauri) {
        bridge.incrementUsage(tokens).catch(console.error);
      }
    },
    [isTauri]
  );

  const saveTemplate = useCallback(
    (template: PromptTemplate) => {
      setTemplates((prev) => {
        const exists = prev.some((t) => t.id === template.id);
        return exists ? prev.map((t) => (t.id === template.id ? template : t)) : [...prev, template];
      });
      if (isTauri) {
        bridge.saveTemplate(template).catch(console.error);
      }
    },
    [isTauri]
  );

  const resetTemplates = useCallback(() => setTemplates(DEFAULT_TEMPLATES), []);

  const requestIdRef = React.useRef<string>('');
  const streamTerminalRequestRef = React.useRef<string | null>(null);
  const activeLookupRef = React.useRef<{ selection: string; kind: string }>({ selection: '', kind: 'word' });

  // Listen for streaming events
  useEffect(() => {
    if (!isTauri) return;
    const unsubs: Array<() => void> = [];
    let active = true;

    const doneListener = bridge.listenLookupDone((e) => {
      if (e.requestId !== requestIdRef.current) return;
      if (streamTerminalRequestRef.current === e.requestId) return;
      streamTerminalRequestRef.current = e.requestId;
      setLookupStatus('done');
      setLookupResult(e.entry as Entry);
    });

    const errorListener = bridge.listenLookupError((e) => {
      if (e.requestId !== requestIdRef.current) return;
      if (streamTerminalRequestRef.current === e.requestId) return;
      streamTerminalRequestRef.current = e.requestId;
      setLookupStatus('error');
      setLookupError(e.message);
      setLookupResult(null);
    });

    const deltaListener = bridge.listenLookupDelta((e) => {
      if (e.requestId !== requestIdRef.current) return;
      if (streamTerminalRequestRef.current === e.requestId) return;
      const aliases: Record<string, keyof Entry> = {
        word: 'selection',
        context_meaning: 'contextMeaning',
        ipa_us: 'ipaUS',
        ipa_uk: 'ipaUK',
        translation_pairs: 'translationPairs',
        key_terms: 'keyTerms',
        domain_analysis: 'domainAnalysis',
      };
      const field = aliases[e.field] || e.field as keyof Entry;
      const active = activeLookupRef.current;
      setLookupResult((previous) => ({
        id: previous?.id || `stream-${e.requestId}`,
        selection: previous?.selection || active.selection,
        lemma: previous?.lemma || active.selection,
        pos: previous?.pos || '',
        ipaUS: previous?.ipaUS || '',
        ipaUK: previous?.ipaUK || '',
        translation: previous?.translation || '',
        contextMeaning: previous?.contextMeaning || '',
        explanation: previous?.explanation || '',
        senses: previous?.senses || [],
        associations: previous?.associations || [],
        examples: previous?.examples || [],
        collocations: previous?.collocations || [],
        register: previous?.register || 'neutral',
        kind: previous?.kind || active.kind as Entry['kind'],
        ...previous,
        [field]: e.value,
      } as Entry));
      setLookupStatus('streaming');
    });

    Promise.all([doneListener, errorListener, deltaListener])
      .then((listeners) => {
        if (active) {
          unsubs.push(...listeners);
          setLookupListenersReady(true);
        } else {
          listeners.forEach((unlisten) => unlisten());
        }
      })
      .catch((error) => {
        console.error('Failed to register lookup event listeners:', error);
        setLookupListenersReady(false);
      });

    return () => {
      active = false;
      unsubs.forEach((fn) => fn());
    };
  }, [isTauri]);

  const triggerLookup = useCallback(
    async (selection: string, context: string, kind: string, sourceApp?: string, sourceTitle?: string, forceRefresh = false) => {
      setLookupSelection(selection);
      setLookupContext(context);
      if (sourceApp) setLookupSourceApp(sourceApp);
      if (sourceTitle) setLookupSourceTitle(sourceTitle);
      setLookupStatus('loading');
      setLookupResult(null);
      setLookupError(null);
      activeLookupRef.current = { selection, kind };

      if (!isTauri) return;

      const rid = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      requestIdRef.current = rid;
      streamTerminalRequestRef.current = null;
      const useStreaming = settings.streamingEnabled === true && lookupListenersReady;
      if (useStreaming) {
        try {
          await bridge.lookupWordStream(selection, context, kind, rid, forceRefresh);
        } catch (e) {
          console.warn('[triggerLookup] streaming failed:', e);
          if (requestIdRef.current !== rid) return;
          const alreadyTerminated = streamTerminalRequestRef.current === rid;
          requestIdRef.current = '';
          if (!alreadyTerminated) {
            setLookupStatus('error');
            setLookupError(String(e));
          }
        }
      } else {
        try {
          const entry = await bridge.lookupWord(selection, context, kind, forceRefresh);
          if (requestIdRef.current !== rid) return;
          setLookupStatus('done');
          setLookupResult(entry as Entry);
        } catch (e) {
          if (requestIdRef.current !== rid) return;
          setLookupStatus('error');
          setLookupError(String(e));
        }
      }
    },
    [isTauri, lookupListenersReady, settings.streamingEnabled]
  );

  // The kind comes from the first lookup (the backend detected it), not from re-counting words
  // here: the two counts disagree on text with leading or trailing whitespace.
  const retryLookup = useCallback(
    (context?: string) => {
      const { selection, kind } = activeLookupRef.current;
      if (!selection) return;
      void triggerLookup(selection, context ?? lookupContext, kind);
    },
    [triggerLookup, lookupContext]
  );

  const clearLookup = useCallback(() => {
    setLookupStatus('idle');
    setLookupResult(null);
    setLookupError(null);
    setLookupSelection('');
    setLookupContext('');
  }, []);

  const tags = useMemo(() => {
    const set = new Set<string>();
    words.forEach((w) => w.tags?.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [words]);

  const value: LexNoteValue = {
    words,
    tags,
    settings,
    settingsSaveStatus,
    settingsSaveError,
    templates,
    usage,
    network,
    captureMethod,
    onboarded,
    initState,
    lookupStatus,
    lookupResult,
    lookupError,
    lookupSelection,
    lookupContext,
    lookupSourceApp,
    lookupSourceTitle,
    startupWarnings,
    setNetwork,
    setCaptureMethod,
    setOnboarded,
    updateSettings,
    saveWord,
    removeWords,
    updateWord,
    tagWords,
    batchSetMastery,
    countLookup,
    saveTemplate,
    resetTemplates,
    triggerLookup,
    retryLookup,
    clearLookup,
    refreshWords,
    refreshAppState,
    flushSettings,
  };

  return <LexNoteContext.Provider value={value}>{children}</LexNoteContext.Provider>;
}

export function useLexNote(): LexNoteValue {
  const ctx = useContext(LexNoteContext);
  if (!ctx) throw new Error('useLexNote must be used inside LexNoteProvider');
  return ctx;
}
