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
  streamingEnabled: true,
  cacheTtlDays: 30,
  reviewLimit: 20,
  includeLongFormReview: false,
  sessionGapMinutes: 30,
  activeDomainProfile: 'general',
  analysisStyle: 'standard',
  autoCheckUpdates: true,
  skippedUpdateVersion: '',
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
  saveWord: (word: SavedWord) => void;
  removeWords: (ids: string[]) => void;
  updateWord: (id: string, patch: Partial<SavedWord>) => void;
  tagWords: (ids: string[], tags: string[]) => void;
  findByLemma: (lemma: string) => SavedWord | undefined;
  countLookup: (tokens: number) => void;
  saveTemplate: (template: PromptTemplate) => void;
  resetTemplates: () => void;
  triggerLookup: (selection: string, context: string, kind: string, sourceApp?: string, sourceTitle?: string, forceRefresh?: boolean) => void;
  clearLookup: () => void;
  refreshWords: () => void;
  refreshAppState: () => Promise<void>;
  flushSettings: () => Promise<void>;
}

const LexNoteContext = createContext<LexNoteValue | null>(null);

export function LexNoteProvider({ children }: { children: React.ReactNode }) {
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
  const [captureMethod, setCaptureMethod] = useState<CaptureMethod>('uia');
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
    if (!isTauri) return;
    try {
      const data = await bridge.getAllWords();
      setWords(data as SavedWord[]);
    } catch (e) {
      console.error('Failed to load words:', e);
    }
  }, [isTauri]);

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
      bridge.getAllWords(),
      bridge.getSettings(),
      bridge.getTemplates(),
      bridge.getUsage(),
      bridge.getStartupWarnings(),
    ]);

    if (dbWords.status === 'fulfilled') {
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
  }, [isTauri]);

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
    (word: SavedWord) => {
      setWords((prev) => [word, ...prev.filter((w) => w.id !== word.id)]);
      if (isTauri) {
        bridge.saveWord(word)
          .then(() => bridge.emitWordSaved())
          .catch(console.error);
      }
    },
    [isTauri]
  );

  const removeWords = useCallback(
    (ids: string[]) => {
      setWords((prev) => prev.filter((w) => !ids.includes(w.id)));
      if (isTauri) {
        bridge.deleteWords(ids)
          .then(() => bridge.emitWordSaved())
          .catch(console.error);
      }
    },
    [isTauri]
  );

  const updateWord = useCallback(
    (id: string, patch: Partial<SavedWord>) => {
      setWords((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
      if (isTauri) {
        bridge.updateWord(id, patch)
          .then(() => bridge.emitWordSaved())
          .catch(console.error);
      }
    },
    [isTauri]
  );

  const tagWords = useCallback(
    (ids: string[], newTags: string[]) => {
      setWords((prev) =>
        prev.map((w) =>
          ids.includes(w.id)
            ? { ...w, tags: Array.from(new Set([...w.tags, ...newTags])) }
            : w
        )
      );
      if (isTauri) {
        words
          .filter((w) => ids.includes(w.id))
          .forEach((w) => {
            const merged = Array.from(new Set([...w.tags, ...newTags]));
            bridge.updateWord(w.id, { tags: merged } as Partial<SavedWord>).catch(console.error);
          });
      }
    },
    [isTauri, words]
  );

  const findByLemma = useCallback(
    (lemma: string) => words.find((w) => w.lemma.toLowerCase() === lemma.toLowerCase()),
    [words]
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
    findByLemma,
    countLookup,
    saveTemplate,
    resetTemplates,
    triggerLookup,
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
