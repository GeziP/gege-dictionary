import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexNoteProvider } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import { AppearanceSection } from './AppearanceSection';

vi.mock('../../lib/tauri-bridge', () => ({
  isTauri: () => true,
  getAllWords: vi.fn(),
  getSettings: vi.fn(),
  getTemplates: vi.fn(),
  getUsage: vi.fn(),
  getStartupWarnings: vi.fn(),
  saveSettings: vi.fn(),
  listenLookupDone: vi.fn(),
  listenLookupError: vi.fn(),
  listenLookupDelta: vi.fn(),
  listVoices: vi.fn(),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));

const PREVIEW = 'The protocol degenerates into a livelock.';
const AUTOMATIC = '自动（优先英语语音）';

/** A Chinese Windows with an English voice added: the system default is the Chinese one. */
const INSTALLED = ['Microsoft Huihui Desktop', 'Microsoft Zira Desktop'];

function renderSection() {
  return render(
    <LexNoteProvider>
      <AppearanceSection />
    </LexNoteProvider>,
  );
}

const voiceSelect = () => screen.getByRole('combobox', { name: /^语音/ });
const optionNames = () => within(voiceSelect()).getAllByRole('option').map((option) => option.textContent);

describe('the voice and the preview in the appearance settings', () => {
  beforeEach(() => {
    vi.mocked(bridge.getAllWords).mockResolvedValue([]);
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
      ttsVoice: 'Microsoft Zira',
      ttsRate: 1.2,
    } as never);
    vi.mocked(bridge.getTemplates).mockResolvedValue([]);
    vi.mocked(bridge.getUsage).mockResolvedValue({ today: 0, month: 0, tokens: 0 });
    vi.mocked(bridge.getStartupWarnings).mockResolvedValue([]);
    vi.mocked(bridge.saveSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.listenLookupDone).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupError).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listenLookupDelta).mockResolvedValue(() => undefined);
    vi.mocked(bridge.listVoices).mockResolvedValue(INSTALLED);
    vi.mocked(bridge.speakText).mockResolvedValue(undefined);
    vi.mocked(bridge.stopSpeaking).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('offers the voices that are installed, after an automatic choice, and shows the one in use', async () => {
    renderSection();

    await screen.findByRole('option', { name: 'Zira Desktop' });
    expect(optionNames()).toEqual([AUTOMATIC, 'Huihui Desktop', 'Zira Desktop']);
    // The saved setting is only part of the name, which is enough for the engine.
    expect(voiceSelect()).toHaveValue('Microsoft Zira Desktop');
  });

  it('shows the automatic choice when the saved voice is not installed on this PC', async () => {
    vi.mocked(bridge.getSettings).mockResolvedValue({
      provider: { model: 'qwen-test', apiKey: 'sk-test' },
      ttsVoice: 'Microsoft Hazel - English (United Kingdom)',
    } as never);
    renderSection();

    await screen.findByRole('option', { name: 'Zira Desktop' });
    expect(voiceSelect()).toHaveValue('');
  });

  it('saves the full name of the voice that was picked, and nothing for the automatic choice', async () => {
    renderSection();
    await screen.findByRole('option', { name: 'Huihui Desktop' });

    await userEvent.selectOptions(voiceSelect(), 'Microsoft Huihui Desktop');
    await waitFor(() =>
      expect(bridge.saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ ttsVoice: 'Microsoft Huihui Desktop' }),
      ),
    );

    await userEvent.selectOptions(voiceSelect(), AUTOMATIC);
    await waitFor(() =>
      expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ ttsVoice: '' })),
    );
    expect(voiceSelect()).toHaveValue('');
  });

  it('says that the voices could not be read, and still offers the automatic choice', async () => {
    vi.mocked(bridge.listVoices).mockRejectedValue('无法列出语音: powershell 不可用');
    renderSection();

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取已安装的语音：无法列出语音: powershell 不可用');
    expect(optionNames()).toEqual([AUTOMATIC]);
  });

  it('previews with the engine, the voice and the speed that the cards are read with', async () => {
    let finish: () => void = () => undefined;
    vi.mocked(bridge.speakText).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderSection();
    await screen.findByRole('option', { name: 'Zira Desktop' });

    await userEvent.click(screen.getByRole('button', { name: '试听' }));

    expect(bridge.speakText).toHaveBeenCalledWith(PREVIEW, 'Microsoft Zira', 1.2);
    // While it plays, the button stops it; when the playback ends it offers the preview again.
    await userEvent.click(await screen.findByRole('button', { name: '停止' }));
    expect(bridge.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(bridge.speakText).toHaveBeenCalledTimes(1);

    finish();
    expect(await screen.findByRole('button', { name: '试听' })).toBeEnabled();
  });

  it('says why a preview failed, and can be tried again', async () => {
    vi.mocked(bridge.speakText).mockRejectedValueOnce('TTS 启动失败: 找不到 powershell');
    renderSection();
    await screen.findByRole('option', { name: 'Zira Desktop' });

    await userEvent.click(screen.getByRole('button', { name: '试听' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('试听失败：TTS 启动失败: 找不到 powershell');
    expect(screen.getByRole('button', { name: '试听' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '试听' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(bridge.speakText).toHaveBeenCalledTimes(2);
  });
});
