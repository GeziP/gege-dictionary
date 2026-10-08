import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as bridge from '../../lib/tauri-bridge';
import { CaptureSection } from './CaptureSection';

const context = vi.hoisted(() => ({
  settings: { ocr: { enabled: true, hotkey: 'Control+Shift+O' } } as Record<string, unknown>,
  updateSettings: vi.fn(),
}));

vi.mock('../../contexts/LexNoteContext', () => ({
  useLexNote: () => context,
}));

vi.mock('../../lib/tauri-bridge', () => ({
  getClipboardWatchStatus: vi.fn(),
  getAutostartStatus: vi.fn(),
  setAutostart: vi.fn(),
  toggleClipboardWatch: vi.fn(),
  registerOcrHotkey: vi.fn(),
  startOcrCapture: vi.fn(),
  getOcrStatus: vi.fn(),
}));

const ocrStatus = (available: boolean, message: string) => ({ available, language: 'en', message });

describe('the settings of capturing text', () => {
  let nativeDialog: MockInstance<typeof window.alert>;

  beforeEach(() => {
    vi.resetAllMocks();
    nativeDialog = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.mocked(bridge.getClipboardWatchStatus).mockResolvedValue(true);
    vi.mocked(bridge.getAutostartStatus).mockResolvedValue(false);
    vi.mocked(bridge.registerOcrHotkey).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    nativeDialog.mockRestore();
  });

  describe('checking that text can be recognized in a picture', () => {
    const check = () => userEvent.click(screen.getByRole('button', { name: '检测 OCR 可用性' }));

    it('says that it can, beside the button, and not in a dialog of the system', async () => {
      vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(true, 'OCR 可用（语言：英文）'));
      render(<CaptureSection />);

      await check();

      const result = await screen.findByRole('status');
      expect(result).toHaveTextContent('OCR 可用（语言：英文）');
      expect(result).toHaveClass('text-positive');
      expect(nativeDialog).not.toHaveBeenCalled();
    });

    it('says that it cannot, and why, as a problem', async () => {
      vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(false, '没有安装英文 OCR 语言包'));
      render(<CaptureSection />);

      await check();

      const result = await screen.findByRole('alert');
      expect(result).toHaveTextContent('没有安装英文 OCR 语言包');
      expect(result).toHaveClass('text-danger');
      expect(nativeDialog).not.toHaveBeenCalled();
    });

    it('says that the check itself failed, with the reason', async () => {
      vi.mocked(bridge.getOcrStatus).mockRejectedValue(new Error('命令执行失败'));
      render(<CaptureSection />);

      await check();

      expect(await screen.findByRole('alert')).toHaveTextContent('检测失败：命令执行失败');
      expect(nativeDialog).not.toHaveBeenCalled();
    });

    it('does not say anything before it was asked', () => {
      render(<CaptureSection />);

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(bridge.getOcrStatus).not.toHaveBeenCalled();
    });

    it('gives way to the answer of the next time it is asked', async () => {
      vi.mocked(bridge.getOcrStatus)
        .mockResolvedValueOnce(ocrStatus(false, '没有安装英文 OCR 语言包'))
        .mockResolvedValueOnce(ocrStatus(true, 'OCR 可用（语言：英文）'));
      render(<CaptureSection />);

      await check();
      await screen.findByRole('alert');
      await check();

      expect(await screen.findByRole('status')).toHaveTextContent('OCR 可用（语言：英文）');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('names the box of the hotkey of the capture by its caption', () => {
    render(<CaptureSection />);

    expect(screen.getByLabelText('热键')).toHaveValue('Control+Shift+O');
  });
});
