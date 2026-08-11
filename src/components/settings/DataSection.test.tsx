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
    tagCount: 0,
  }),
  listBackups: vi.fn().mockResolvedValue([]),
  getStartupWarnings: vi.fn().mockResolvedValue([]),
  exportDatabaseSnapshot: vi.fn(),
}));

describe('DataSection export', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
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
});
