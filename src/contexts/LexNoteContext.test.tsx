import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LexNoteProvider, useLexNote } from './LexNoteContext';
import * as bridge from '../lib/tauri-bridge';

vi.mock('../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({}),
  getTemplates: vi.fn().mockResolvedValue([]),
  getUsage: vi.fn().mockResolvedValue({ today: 0, month: 0, tokens: 0 }),
  saveSettings: vi.fn(),
  saveTemplate: vi.fn().mockResolvedValue(undefined),
  saveAnalysisPreferences: vi.fn().mockResolvedValue(undefined),
  listenLookupDone: vi.fn().mockResolvedValue(() => undefined),
  listenLookupError: vi.fn().mockResolvedValue(() => undefined),
  listenLookupDelta: vi.fn().mockResolvedValue(() => undefined),
}));

function Harness() {
  const { settings, updateSettings, settingsSaveStatus } = useLexNote();
  return (
    <>
      <span data-testid="theme">{settings.theme}</span>
      <span data-testid="status">{settingsSaveStatus}</span>
      <button type="button" onClick={() => updateSettings({ theme: 'dark' })}>dark</button>
    </>
  );
}

describe('settings persistence', () => {
  it('serializes writes and rolls back the optimistic UI on failure', async () => {
    let rejectSave: ((reason?: unknown) => void) | undefined;
    vi.mocked(bridge.saveSettings).mockImplementationOnce(() => new Promise<void>((_, reject) => {
      rejectSave = reject;
    }));
    render(<LexNoteProvider><Harness /></LexNoteProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    rejectSave?.(new Error('disk is read-only'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });
});
