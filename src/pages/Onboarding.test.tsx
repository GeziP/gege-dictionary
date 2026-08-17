import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../contexts/LexNoteContext';
import * as bridge from '../lib/tauri-bridge';
import { Onboarding } from './Onboarding';

vi.mock('../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({}),
  getTemplates: vi.fn().mockResolvedValue([]),
  getUsage: vi.fn().mockResolvedValue({ today: 0, month: 0, tokens: 0 }),
  getStartupWarnings: vi.fn().mockResolvedValue([]),
  listenLookupDone: vi.fn().mockResolvedValue(() => undefined),
  listenLookupError: vi.fn().mockResolvedValue(() => undefined),
  listenLookupDelta: vi.fn().mockResolvedValue(() => undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue({ ok: true }),
  getAutostartStatus: vi.fn().mockResolvedValue(false),
  setAutostart: vi.fn().mockResolvedValue(false),
}));

describe('onboarding autostart', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const clickFooterNext = async () => {
    const buttons = screen.getAllByRole('button');
    await userEvent.click(buttons[buttons.length - 1]);
  };

  const clickConnectionTest = async () => {
    const buttons = screen.getAllByRole('button');
    await userEvent.click(buttons[buttons.length - 2]);
    await waitFor(() => expect(bridge.testConnection).toHaveBeenCalled());
  };

  const renderOnboarding = () => render(
    <MemoryRouter>
      <LexNoteProvider>
        <Onboarding />
      </LexNoteProvider>
    </MemoryRouter>,
  );

  it('keeps the toggle off and shows an error when the OS registration fails', async () => {
    vi.mocked(bridge.setAutostart).mockRejectedValueOnce(new Error('permission denied'));
    renderOnboarding();
    await clickConnectionTest();
    await clickFooterNext();
    await clickFooterNext();

    const autostart = screen.getAllByRole('switch')[0];
    expect(autostart).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(autostart);

    await waitFor(() => expect(screen.getByText(/permission denied/)).toBeInTheDocument());
    expect(autostart).toHaveAttribute('aria-checked', 'false');
    expect(bridge.setAutostart).toHaveBeenCalledWith(true);
  });

  it('shows the operating system autostart state on first render', async () => {
    vi.mocked(bridge.getAutostartStatus).mockResolvedValueOnce(true);
    renderOnboarding();
    await clickConnectionTest();
    await clickFooterNext();
    await clickFooterNext();

    const autostart = screen.getAllByRole('switch')[0];
    await waitFor(() => expect(autostart).toHaveAttribute('aria-checked', 'true'));
    expect(bridge.getAutostartStatus).toHaveBeenCalled();
  });
});
