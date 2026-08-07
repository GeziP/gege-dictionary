import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
  anonymousStats: false,
  ttsVoice: 'Microsoft Zira',
  ttsRate: 1,
  fontSize: 13,
};

interface Usage {
  today: number;
  month: number;
  tokens: number;
}

export type LookupStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error';
export type InitState = 'loading' | 'ready';

interface LexNoteValue {
  words: SavedWord[];
  tags: string[];
  settings: AppSettings;
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
  setNetwork: (mode: NetworkMode) => void;
  setCaptureMethod: (method: CaptureMethod) => void;
  setOnboarded: (value: boolean) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  saveWord: (word: SavedWord) => void;
  removeWords: (ids: string[]) => void;
  updateWord: (id: string, patch: Partial<SavedWord>) => void;
  tagWords: (ids: string[], tags: string[]) => void;
  findByLemma: (lemma: string) => SavedWord | undefined;
  countLookup: (tokens: number) => void;
  saveTemplate: (template: PromptTemplate) => void;
  resetTemplates: () => void;
  triggerLookup: (selection: string, context: string, kind: string, sourceApp?: string, sourceTitle?: string) => void;
  clearLookup: () => void;
  refreshWords: () => void;
}

const LexNoteContext = createContext<LexNoteValue | null>(null);

export function LexNoteProvider({ children }: { children: React.ReactNode }) {
  const isTauri = bridge.isTauri();

  const [words, setWords] = useState<SavedWord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [network, setNetwork] = useState<NetworkMode>('ok');
  const [captureMethod, setCaptureMethod] = useState<CaptureMethod>('uia');
  const [onboarded, setOnboarded] = useState(false);
  const [usage, setUsage] = useState<Usage>({ today: 0, month: 0, tokens: 0 });

  const [initState, setInitState] = useState<InitState>(isTauri ? 'loading' : 'ready');
  const [lookupStatus, setLookupStatus] = useState<LookupStatus>('idle');
  const [lookupResult, setLookupResult] = useState<Entry | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupSelection, setLookupSelection] = useState('');
  const [lookupContext, setLookupContext] = useState('');
  const [lookupSourceApp, setLookupSourceApp] = useState('');
  const [lookupSourceTitle, setLookupSourceTitle] = useState('');

  const refreshWords = useCallback(async () => {
    if (!isTauri) return;
    try {
      const data = await bridge.getAllWords();
      setWords(data as SavedWord[]);
    } catch (e) {
      console.error('Failed to load words:', e);
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) return;

    (async () => {
      const [dbWords, dbSettings, dbTemplates, dbUsage] = await Promise.allSettled([
        bridge.getAllWords(),
        bridge.getSettings(),
        bridge.getTemplates(),
        bridge.getUsage(),
      ]);

      if (dbWords.status === 'fulfilled') {
        setWords(dbWords.value as SavedWord[]);
      }

      if (dbSettings.status === 'fulfilled') {
        const s = dbSettings.value as Partial<AppSettings>;
        if (s.provider) {
          setSettings((prev) => ({ ...prev, ...s }));
          setOnboarded(!!s.provider.apiKey && s.provider.apiKey.length > 0);
        } else {
          setOnboarded(false);
        }
      } else {
        setOnboarded(false);
      }

      if (dbTemplates.status === 'fulfilled') {
        const dbTpls = dbTemplates.value as PromptTemplate[];
        const userTpls = dbTpls.filter((t) => !t.builtIn);
        const merged = [...DEFAULT_TEMPLATES.filter((t) => t.builtIn), ...userTpls];
        setTemplates(merged);
        for (const tpl of merged) {
          bridge.saveTemplate(tpl).catch(console.error);
        }
      }

      if (dbUsage.status === 'fulfilled') {
        setUsage(dbUsage.value);
      }

      setInitState('ready');
    })();
  }, [isTauri]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersDark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', prefersDark);
  }, [settings.theme]);

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        if (isTauri) {
          bridge.saveSettings(next).catch(console.error);
        }
        return next;
      });
    },
    [isTauri]
  );

  const saveWord = useCallback(
    (word: SavedWord) => {
      setWords((prev) => [word, ...prev.filter((w) => w.id !== word.id)]);
      if (isTauri) {
        bridge.saveWord(word).catch(console.error);
      }
    },
    [isTauri]
  );

  const removeWords = useCallback(
    (ids: string[]) => {
      setWords((prev) => prev.filter((w) => !ids.includes(w.id)));
      if (isTauri) {
        bridge.deleteWords(ids).catch(console.error);
      }
    },
    [isTauri]
  );

  const updateWord = useCallback(
    (id: string, patch: Partial<SavedWord>) => {
      setWords((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
      if (isTauri) {
        bridge.updateWord(id, patch).catch(console.error);
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

  const triggerLookup = useCallback(
    async (selection: string, context: string, kind: string, sourceApp?: string, sourceTitle?: string) => {
      setLookupSelection(selection);
      setLookupContext(context);
      if (sourceApp) setLookupSourceApp(sourceApp);
      if (sourceTitle) setLookupSourceTitle(sourceTitle);
      setLookupStatus('loading');
      setLookupResult(null);
      setLookupError(null);

      if (isTauri) {
        try {
          const entry = await bridge.lookupWord(selection, context, kind);
          setLookupStatus('done');
          setLookupResult(entry as Entry);
        } catch (e) {
          setLookupStatus('error');
          setLookupError(String(e));
        }
      }
    },
    [isTauri]
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
  };

  return <LexNoteContext.Provider value={value}>{children}</LexNoteContext.Provider>;
}

export function useLexNote(): LexNoteValue {
  const ctx = useContext(LexNoteContext);
  if (!ctx) throw new Error('useLexNote must be used inside LexNoteProvider');
  return ctx;
}

function detectKind(text: string): string {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount >= 30) return 'paragraph';
  if (wordCount >= 6) return 'sentence';
  if (trimmed.includes(' ')) return 'phrase';
  return 'word';
}
