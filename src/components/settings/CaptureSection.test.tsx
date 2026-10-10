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
  openLanguageSettings: vi.fn(),
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

    describe('when text cannot be recognized for want of the language pack', () => {
      const openSettings = () =>
        userEvent.click(screen.getByRole('button', { name: '打开系统语言设置' }));

      it('offers the page of the system settings where the pack is added', async () => {
        vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(false, '没有安装英文 OCR 识别包'));
        vi.mocked(bridge.openLanguageSettings).mockResolvedValue(undefined);
        render(<CaptureSection />);

        await check();
        await screen.findByRole('alert');
        await openSettings();

        expect(bridge.openLanguageSettings).toHaveBeenCalledTimes(1);
        // What was said stays: the user is reading it while the settings open.
        expect(screen.getByRole('alert')).toHaveTextContent('没有安装英文 OCR 识别包');
      });

      it('says why when those settings cannot be opened', async () => {
        vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(false, '没有安装英文 OCR 识别包'));
        vi.mocked(bridge.openLanguageSettings).mockRejectedValue(new Error('explorer 不可用'));
        render(<CaptureSection />);

        await check();
        await screen.findByRole('alert');
        await openSettings();

        expect(await screen.findByRole('alert')).toHaveTextContent('没能打开系统设置：explorer 不可用');
      });

      it('does not offer them when text can be recognized, or before it is known', async () => {
        vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(true, 'OCR 可用（语言：英文）'));
        render(<CaptureSection />);

        expect(screen.queryByRole('button', { name: '打开系统语言设置' })).not.toBeInTheDocument();
        await check();
        await screen.findByRole('status');

        expect(screen.queryByRole('button', { name: '打开系统语言设置' })).not.toBeInTheDocument();
      });

      it('does not offer them when the check itself failed: that is no matter of a language', async () => {
        vi.mocked(bridge.getOcrStatus).mockRejectedValue(new Error('命令执行失败'));
        render(<CaptureSection />);

        await check();
        await screen.findByRole('alert');

        expect(screen.queryByRole('button', { name: '打开系统语言设置' })).not.toBeInTheDocument();
      });
    });
  });

  describe('starting a capture by hand', () => {
    const start = () => userEvent.click(screen.getByRole('button', { name: '立即框选取词' }));

    it('opens the picker, and says nothing when it opens', async () => {
      vi.mocked(bridge.startOcrCapture).mockResolvedValue(undefined);
      render(<CaptureSection />);

      await start();

      expect(bridge.startOcrCapture).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says why the picker could not be opened, where the button is, not nowhere', async () => {
      vi.mocked(bridge.startOcrCapture).mockRejectedValue('屏幕截下来是一片纯黑');
      render(<CaptureSection />);

      await start();

      const result = await screen.findByRole('alert');
      expect(result).toHaveTextContent('截图取词没能开始：屏幕截下来是一片纯黑');
      expect(nativeDialog).not.toHaveBeenCalled();
    });
  });

  it('names the box of the hotkey of the capture by its caption', () => {
    render(<CaptureSection />);

    expect(screen.getByLabelText('热键')).toHaveValue('Control+Shift+O');
  });
});
