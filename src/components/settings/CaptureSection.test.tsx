import { act, cleanup, render, screen } from '@testing-library/react';
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

const WORKS = '内置 OCR 可用：自检读出了 9/9 个词，用时 120 毫秒';
const BROKEN = '内置 OCR 引擎没能启动：找不到 OCR 运行库 C:\\gege\\onnxruntime.dll。请重新安装鸽鸽词典';

const ocrStatus = (available: boolean, message: string) => ({
  available,
  engine: 'PP-OCRv6',
  message,
});

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
      vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(true, WORKS));
      render(<CaptureSection />);

      await check();

      const result = await screen.findByRole('status');
      expect(result).toHaveTextContent(WORKS);
      expect(result).toHaveClass('text-positive');
      expect(nativeDialog).not.toHaveBeenCalled();
    });

    it('says that it cannot, and why, as a problem', async () => {
      vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(false, BROKEN));
      render(<CaptureSection />);

      await check();

      const result = await screen.findByRole('alert');
      expect(result).toHaveTextContent(BROKEN);
      expect(result).toHaveClass('text-danger');
      expect(nativeDialog).not.toHaveBeenCalled();
    });

    it('sends nobody to the settings of the system: the engine needs no language pack', async () => {
      vi.mocked(bridge.getOcrStatus).mockResolvedValue(ocrStatus(false, BROKEN));
      render(<CaptureSection />);

      await check();
      await screen.findByRole('alert');

      expect(screen.queryByRole('button', { name: /语言/ })).not.toBeInTheDocument();
      expect(screen.getByText(/不依赖系统语言包/)).toBeInTheDocument();
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
        .mockResolvedValueOnce(ocrStatus(false, BROKEN))
        .mockResolvedValueOnce(ocrStatus(true, WORKS));
      render(<CaptureSection />);

      await check();
      await screen.findByRole('alert');
      await check();

      expect(await screen.findByRole('status')).toHaveTextContent(WORKS);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows that it is working, and cannot be started again meanwhile', async () => {
      let answer: (status: ReturnType<typeof ocrStatus>) => void = () => undefined;
      vi.mocked(bridge.getOcrStatus).mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      render(<CaptureSection />);

      await check();

      const working = screen.getByRole('button', { name: '检测中…' });
      expect(working).toBeDisabled();
      await userEvent.click(working);
      expect(bridge.getOcrStatus).toHaveBeenCalledTimes(1);

      await act(async () => answer(ocrStatus(true, WORKS)));

      expect(await screen.findByRole('status')).toHaveTextContent(WORKS);
      expect(screen.getByRole('button', { name: '检测 OCR 可用性' })).toBeEnabled();
    });

    it('can be asked again after it failed', async () => {
      vi.mocked(bridge.getOcrStatus).mockRejectedValue(new Error('命令执行失败'));
      render(<CaptureSection />);

      await check();
      await screen.findByRole('alert');

      expect(screen.getByRole('button', { name: '检测 OCR 可用性' })).toBeEnabled();
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
