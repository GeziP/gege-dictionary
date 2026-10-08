import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import { DataSection } from './DataSection';

vi.mock('../../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({}),
  getTemplates: vi.fn().mockResolvedValue([]),
  getUsage: vi.fn().mockResolvedValue({ today: 0, month: 0, tokens: 0 }),
  listenLookupDone: vi.fn().mockResolvedValue(() => undefined),
  listenLookupError: vi.fn().mockResolvedValue(() => undefined),
  listenLookupDelta: vi.fn().mockResolvedValue(() => undefined),
  saveTemplate: vi.fn().mockResolvedValue(undefined),
  saveAnalysisPreferences: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getDbStats: vi.fn().mockResolvedValue({
    wordCount: 1,
    sizeBytes: 4096,
    dataDir: 'C:\\Data',
    cacheCount: 0,
    cacheSizeBytes: 0,
    historyCount: 4,
    tagCount: 0,
  }),
  clearLookupHistory: vi.fn().mockResolvedValue(4),
  listBackups: vi.fn().mockResolvedValue([]),
  getStartupWarnings: vi.fn().mockResolvedValue([]),
  exportDatabaseSnapshot: vi.fn(),
  restoreBackup: vi.fn().mockResolvedValue(undefined),
  changeDataDir: vi.fn().mockResolvedValue({
    oldDbPath: 'C:\\Data\\gege.db',
    newDbPath: 'D:\\Data\\gege.db',
    backupsCopied: 0,
    warnings: [],
  }),
}));

describe('DataSection export', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.exportDatabaseSnapshot).mockReset();
  });

  function renderSection() {
    return render(
      <LexNoteProvider>
        <DataSection />
      </LexNoteProvider>,
    );
  }

  it('does not report success when the native save dialog is cancelled', async () => {
    vi.mocked(bridge.exportDatabaseSnapshot).mockResolvedValue(null);
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: '导出全部数据' }));
    await waitFor(() => expect(bridge.exportDatabaseSnapshot).toHaveBeenCalled());
    expect(screen.queryByText(/已导出完整 SQLite 快照/)).not.toBeInTheDocument();
  });

  it('reports the path after exporting a complete snapshot', async () => {
    vi.mocked(bridge.exportDatabaseSnapshot).mockResolvedValue('C:\\exports\\gege.db');
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: '导出全部数据' }));
    await waitFor(() => expect(screen.getByText(/已导出完整 SQLite 快照/)).toBeInTheDocument());
    expect(bridge.exportDatabaseSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rehydrates words and settings after restoring a backup', async () => {
    vi.mocked(bridge.listBackups).mockResolvedValueOnce([
      {
        name: 'gege-backup-test.db',
        sizeKb: 1,
        modifiedTs: 1,
        path: 'C:\\Data\\backups\\gege-backup-test.db',
        kind: 'auto',
        restorable: true,
      },
    ]);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderSection();

    const restoreButton = (await screen.findAllByRole('button', { name: /恢复/ }))
      .find((button) => button.textContent === '恢复');
    expect(restoreButton).toBeDefined();
    await userEvent.click(restoreButton as HTMLElement);
    await waitFor(() => expect(bridge.restoreBackup).toHaveBeenCalledWith('gege-backup-test.db'));
    await waitFor(() => expect(bridge.getAllWords).toHaveBeenCalledTimes(2));
    expect(bridge.getSettings).toHaveBeenCalledTimes(2);
    expect(bridge.getTemplates).toHaveBeenCalledTimes(2);
    expect(bridge.getUsage).toHaveBeenCalledTimes(2);
  });

  it('rehydrates all state after migrating to a new data directory', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderSection();

    await waitFor(() => expect(screen.getByDisplayValue('C:\\Data')).toBeInTheDocument());
    const input = screen.getByDisplayValue('C:\\Data');
    await userEvent.clear(input);
    await userEvent.type(input, 'D:\\Data');
    await userEvent.click(screen.getByRole('button', { name: '迁移' }));

    await waitFor(() => expect(bridge.changeDataDir).toHaveBeenCalledWith('D:\\Data'));
    await waitFor(() => expect(bridge.getAllWords).toHaveBeenCalledTimes(2));
    expect(bridge.getSettings).toHaveBeenCalledTimes(2);
    expect(bridge.getTemplates).toHaveBeenCalledTimes(2);
    expect(bridge.getUsage).toHaveBeenCalledTimes(2);
  });

  describe('lookup history', () => {
    const stats = (historyCount: number) => ({
      wordCount: 1,
      sizeBytes: 4096,
      dataDir: 'C:\\Data',
      cacheCount: 0,
      cacheSizeBytes: 0,
      historyCount,
      tagCount: 0,
    });

    it('is recorded unless the user switches it off, and the choice is saved', async () => {
      renderSection();
      const recording = await screen.findByRole('switch', { name: '记录查词历史' });
      expect(recording).toHaveAttribute('aria-checked', 'true');

      await userEvent.click(recording);

      expect(recording).toHaveAttribute('aria-checked', 'false');
      await waitFor(() =>
        expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ historyEnabled: false })),
      );
    });

    it('shows how many lookups are remembered and clears them only after asking', async () => {
      const ask = vi.fn(() => false);
      vi.stubGlobal('confirm', ask);
      renderSection();
      expect(await screen.findByText('当前 4 条')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: '清空历史' }));
      expect(ask).toHaveBeenCalledWith(expect.stringContaining('4 条'));
      expect(bridge.clearLookupHistory).not.toHaveBeenCalled();

      ask.mockReturnValue(true);
      vi.mocked(bridge.getDbStats).mockResolvedValueOnce(stats(0));
      await userEvent.click(screen.getByRole('button', { name: '清空历史' }));

      await waitFor(() => expect(bridge.clearLookupHistory).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('已清空 4 条查词历史')).toBeInTheDocument();
      expect(await screen.findByText('当前 0 条')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '清空历史' })).toBeDisabled();
    });

    it('says so when clearing fails, and keeps the count', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true));
      vi.mocked(bridge.clearLookupHistory).mockRejectedValueOnce('数据库被占用');
      renderSection();
      await screen.findByText('当前 4 条');

      await userEvent.click(screen.getByRole('button', { name: '清空历史' }));

      expect(await screen.findByText(/清空查词历史失败.*数据库被占用/)).toBeInTheDocument();
      expect(screen.getByText('当前 4 条')).toBeInTheDocument();
    });

    it('has nothing to clear when there is no history', async () => {
      vi.mocked(bridge.getDbStats).mockResolvedValueOnce(stats(0));
      renderSection();

      expect(await screen.findByText('当前 0 条')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '清空历史' })).toBeDisabled();
    });
  });
});
