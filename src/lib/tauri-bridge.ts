import type {
  AppSettings,
  Entry,
  PromptTemplate,
  SavedWord,
} from '../types/lexnote';

const IS_TAURI = '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) {
    throw new Error(`Tauri not available for command: ${cmd}`);
  }
  // @ts-expect-error Tauri injects this at runtime
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

async function listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  // @ts-expect-error Tauri injects this at runtime
  const unlisten = await window.__TAURI_INTERNALS__.event.listen(event, (e: { payload: unknown }) => {
    handler(e.payload);
  });
  return unlisten;
}

async function emit(event: string, payload?: unknown): Promise<void> {
  if (!IS_TAURI) return;
  // @ts-expect-error Tauri injects this at runtime
  await window.__TAURI_INTERNALS__.event.emit(event, payload);
}

export function isTauri(): boolean {
  return IS_TAURI;
}

export async function getAllWords(): Promise<SavedWord[]> {
  return invoke<SavedWord[]>('get_all_words');
}

export async function searchWords(
  query: string,
  tag?: string,
  source?: string,
  mastery?: string
): Promise<SavedWord[]> {
  return invoke<SavedWord[]>('search_words', { query, tag, source, mastery });
}

export async function saveWord(word: SavedWord): Promise<void> {
  return invoke('save_word', { word });
}

export async function updateWord(id: string, patch: Partial<SavedWord>): Promise<void> {
  return invoke('update_word', { id, patch });
}

export async function deleteWords(ids: string[]): Promise<void> {
  return invoke('delete_words', { ids });
}

export async function getAllTags(): Promise<string[]> {
  return invoke<string[]>('get_all_tags');
}

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_settings');
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke('save_settings', { settings });
}

export async function getTemplates(): Promise<PromptTemplate[]> {
  return invoke<PromptTemplate[]>('get_templates');
}

export async function saveTemplate(template: PromptTemplate): Promise<void> {
  return invoke('save_template', { template });
}

export async function getUsage(): Promise<{ today: number; month: number; tokens: number }> {
  return invoke('get_usage');
}

export async function incrementUsage(tokens: number): Promise<void> {
  return invoke('increment_usage', { tokens });
}

export async function lookupWord(
  selection: string,
  context: string,
  kind: string
): Promise<Entry> {
  return invoke<Entry>('lookup_word', { selection, context, kind });
}

export async function lookupWordStream(
  selection: string,
  context: string,
  kind: string,
  requestId: string
): Promise<void> {
  return invoke('lookup_word_stream', { selection, context, kind, requestId });
}

export interface LookupDeltaEvent {
  requestId: string;
  delta: string;
}

export interface LookupDoneEvent {
  requestId: string;
  entry: Entry;
}

export interface LookupErrorEvent {
  requestId: string;
  error: string;
}

export async function listenLookupDelta(handler: (e: LookupDeltaEvent) => void): Promise<() => void> {
  return listen('lookup://delta', handler as (payload: unknown) => void);
}

export async function listenLookupDone(handler: (e: LookupDoneEvent) => void): Promise<() => void> {
  return listen('lookup://done', handler as (payload: unknown) => void);
}

export async function listenLookupError(handler: (e: LookupErrorEvent) => void): Promise<() => void> {
  return listen('lookup://error', handler as (payload: unknown) => void);
}

export async function emitWordSaved(): Promise<void> {
  return emit('library://word-saved');
}

export async function listenWordSaved(handler: () => void): Promise<() => void> {
  return listen('library://word-saved', handler);
}

export async function toggleClipboardWatch(): Promise<boolean> {
  return invoke<boolean>('toggle_clipboard_watch');
}

export async function getClipboardWatchStatus(): Promise<boolean> {
  return invoke<boolean>('get_clipboard_watch_status');
}

export async function testConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  protocol?: string
): Promise<{ ok: boolean; latency: number; model: string }> {
  return invoke('test_connection', { baseUrl, apiKey, model, protocol: protocol || 'openai' });
}

export async function speakText(text: string, voice: string, rate: number): Promise<void> {
  return invoke('speak_text', { text, voice, rate });
}

export async function listVoices(): Promise<string[]> {
  return invoke<string[]>('list_voices');
}

export async function exportWordsData(
  ids: string[],
  format: string
): Promise<string> {
  return invoke<string>('export_words_data', { ids, format });
}

export async function getDbStats(): Promise<{
  wordCount: number;
  tagCount: number;
  cacheCount: number;
}> {
  return invoke('get_db_stats');
}

export async function backupDatabase(): Promise<string> {
  return invoke<string>('backup_database');
}

export async function listBackups(): Promise<Array<{
  name: string;
  sizeKb: number;
  modifiedTs: number;
  path: string;
}>> {
  return invoke('list_backups');
}

export async function restoreBackup(backupName: string): Promise<void> {
  return invoke('restore_backup', { backupName });
}

export async function changeDataDir(newDir: string): Promise<string> {
  return invoke<string>('change_data_dir', { newDir });
}

export async function openDataFolder(): Promise<void> {
  return invoke('open_data_folder');
}

export async function pickFolder(title?: string): Promise<string | null> {
  return invoke<string | null>('pick_folder', { title });
}

export async function saveFileDialog(
  defaultName: string,
  content: string,
  filterName?: string,
  filterExt?: string[],
): Promise<string | null> {
  return invoke<string | null>('save_file_dialog', {
    defaultName,
    content,
    filterName,
    filterExt,
  });
}

export async function getLastCapture(): Promise<{
  selection: string;
  context: string;
  sourceApp: string;
  sourceTitle: string;
  kind: string;
  method: string;
} | null> {
  const result = await invoke<unknown>('get_last_capture');
  if (!result || typeof result !== 'object') return null;
  return result as {
    selection: string;
    context: string;
    sourceApp: string;
    sourceTitle: string;
    kind: string;
    method: string;
  };
}

export async function createLookupWindow(
  x: number,
  y: number,
  selection?: string,
  context?: string,
  kind?: string
): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const mod = await import('@tauri-apps/api/webviewWindow');
    const WebviewWindow = mod.WebviewWindow;
    const existing = await WebviewWindow.getByLabel('lookup');
    if (existing) {
      await existing.close();
    }

    const params = new URLSearchParams();
    if (selection) params.set('s', selection);
    if (context) params.set('c', context);
    if (kind) params.set('k', kind);
    const qs = params.toString();
    const url = qs ? `/lookup?${qs}` : '/lookup';

    new WebviewWindow('lookup', {
      url,
      title: '鸽鸽词典',
      width: 420,
      height: 560,
      x: Math.max(0, x - 210),
      y: Math.max(0, y + 10),
      decorations: false,
      transparent: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focus: true,
    });
  } catch (e) {
    console.error('Failed to create lookup window:', e);
  }
}

export async function closeLookupWindow(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const mod = await import('@tauri-apps/api/webviewWindow');
    const win = await mod.WebviewWindow.getByLabel('lookup');
    if (win) await win.close();
  } catch (e) {
    console.error('Failed to close lookup window:', e);
  }
}

export { emit };
