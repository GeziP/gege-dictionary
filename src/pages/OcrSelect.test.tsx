import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../lib/tauri-bridge';
import { OcrSelect } from './OcrSelect';

vi.mock('../lib/tauri-bridge', () => ({
  getOcrFrame: vi.fn(),
  getOcrStatus: vi.fn(),
  ocrPickerReady: vi.fn(),
  ocrRecognizeFrame: vi.fn(),
  setOcrCaptureAndLookup: vi.fn(),
  closeOcrPicker: vi.fn(),
  openLanguageSettings: vi.fn(),
}));

/** The picture is 200x100 and the page 100x50 CSS pixels: a screen at 200%. */
const FRAME = { width: 200, height: 100 };
const PAGE = { width: 100, height: 50 };

/** What the backend sends for the picture of the screen. */
function payload(width = FRAME.width, height = FRAME.height, bytes = width * height * 4): ArrayBuffer {
  const buffer = new Uint8Array(8 + bytes);
  const header = new DataView(buffer.buffer);
  header.setUint32(0, width, true);
  header.setUint32(4, height, true);
  return buffer.buffer;
}

const putImageData = vi.fn();

function setPageSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

const recognition = (text: string, extra: Partial<bridge.OcrRecognition> = {}): bridge.OcrRecognition => ({
  text,
  truncated: false,
  length: text.length,
  blank: false,
  ...extra,
});

/** The picker is on screen and the user can drag. */
async function showPicker() {
  render(<OcrSelect />);
  await waitFor(() => expect(bridge.ocrPickerReady).toHaveBeenCalled());
  return screen.getByRole('application', { name: '截图取词' });
}

/**
 * jsdom has no PointerEvent. Without one the events fired here would be bare Events, which have
 * neither the coordinates nor the button the picker reads.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

function drag(target: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y, pointerId: 1, button: 0 });
  fireEvent.pointerMove(target, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y, pointerId: 1, button: 0 });
}

beforeEach(() => {
  setPageSize(PAGE.width, PAGE.height);
  putImageData.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    putImageData,
  } as unknown as RenderingContext);
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.mocked(bridge.getOcrFrame).mockResolvedValue(payload());
  vi.mocked(bridge.getOcrStatus).mockResolvedValue({
    available: true,
    language: 'en-US',
    message: '系统 OCR 可用（en-US）',
  });
  vi.mocked(bridge.ocrPickerReady).mockResolvedValue(undefined);
  vi.mocked(bridge.ocrRecognizeFrame).mockResolvedValue(recognition('hello world'));
  vi.mocked(bridge.setOcrCaptureAndLookup).mockResolvedValue(undefined);
  vi.mocked(bridge.closeOcrPicker).mockResolvedValue(undefined);
  vi.mocked(bridge.openLanguageSettings).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the picture of the screen', () => {
  it('is on the canvas, whole and at its own size, before the window is shown', async () => {
    await showPicker();

    const canvas = screen.getByTestId('ocr-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(FRAME.width);
    expect(canvas.height).toBe(FRAME.height);
    expect(putImageData).toHaveBeenCalledTimes(1);
    const [image, left, top] = putImageData.mock.calls[0];
    expect(image).toMatchObject({ width: FRAME.width, height: FRAME.height });
    expect([left, top]).toEqual([0, 0]);
    // A window shown first is a blank one for as long as the page takes to draw.
    expect(putImageData.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bridge.ocrPickerReady).mock.invocationCallOrder[0],
    );
  });

  it('asks the user to drag over the text', async () => {
    await showPicker();

    expect(screen.getByText(/拖拽框选要识别的英文/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is not drawn when its data does not add up, and the window is shown with the reason', async () => {
    vi.mocked(bridge.getOcrFrame).mockResolvedValue(payload(FRAME.width, FRAME.height, 12));

    await showPicker();

    expect(putImageData).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('没能取得屏幕截图：截图数据与它的尺寸不符');
  });

  it('that cannot be had is explained in the window, which is shown all the same', async () => {
    vi.mocked(bridge.getOcrFrame).mockRejectedValue(new Error('没有可用的截图，请重新截图取词'));

    await showPicker();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('没能取得屏幕截图：没有可用的截图，请重新截图取词');
    // Nothing to be done in the system settings about a picture that was not taken.
    expect(screen.queryByRole('button', { name: '打开系统语言设置' })).not.toBeInTheDocument();
    expect(bridge.ocrRecognizeFrame).not.toHaveBeenCalled();
  });
});

describe('dragging a region', () => {
  it('reads it in the pixels of the picture, and hands the text to the lookup', async () => {
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });

    // 30x20 CSS pixels at 200% are 60x40 pixels of the picture, from (20, 20).
    await waitFor(() => expect(bridge.ocrRecognizeFrame).toHaveBeenCalledWith(20, 20, 60, 40));
    await waitFor(() => expect(bridge.setOcrCaptureAndLookup).toHaveBeenCalledWith('hello world'));
    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
  });

  it('reads the same region whichever way it is dragged', async () => {
    const picker = await showPicker();

    drag(picker, { x: 40, y: 30 }, { x: 10, y: 10 });

    await waitFor(() => expect(bridge.ocrRecognizeFrame).toHaveBeenCalledWith(20, 20, 60, 40));
  });

  it('is marked on the picture while it is dragged, and the rest is dimmed by it', async () => {
    const picker = await showPicker();

    fireEvent.pointerDown(picker, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(picker, { clientX: 40, clientY: 30, pointerId: 1 });

    const selection = screen.getByTestId('ocr-selection');
    expect(selection).toHaveStyle({ left: '10px', top: '10px', width: '30px', height: '20px' });
    expect(selection.style.boxShadow.replace(/\s/g, '')).toContain('rgba(0,0,0,0.4)');
  });

  it('while it is being read, says so and takes no other drag', async () => {
    let finish!: (value: bridge.OcrRecognition) => void;
    vi.mocked(bridge.ocrRecognizeFrame).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });
    expect(await screen.findByText('正在本地识别…')).toBeInTheDocument();
    drag(picker, { x: 50, y: 5 }, { x: 90, y: 40 });

    expect(bridge.ocrRecognizeFrame).toHaveBeenCalledTimes(1);
    finish(recognition('hello world'));
    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalled());
  });

  it('that is only a click is not read, and the user is told to drag a larger one', async () => {
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 13, y: 12 });

    expect(await screen.findByRole('alert')).toHaveTextContent('选区太小');
    expect(bridge.ocrRecognizeFrame).not.toHaveBeenCalled();
    expect(bridge.closeOcrPicker).not.toHaveBeenCalled();
  });

  it('is not started by the other buttons of the mouse', async () => {
    const picker = await showPicker();

    fireEvent.pointerDown(picker, { clientX: 10, clientY: 10, pointerId: 1, button: 1 });
    fireEvent.pointerMove(picker, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(picker, { clientX: 40, clientY: 30, pointerId: 1, button: 1 });

    expect(screen.queryByTestId('ocr-selection')).not.toBeInTheDocument();
    expect(bridge.ocrRecognizeFrame).not.toHaveBeenCalled();
  });
});

describe('when nothing comes of a region', () => {
  it('says that no text was found, and lets the user drag again on the same picture', async () => {
    vi.mocked(bridge.ocrRecognizeFrame)
      .mockResolvedValueOnce(recognition('   '))
      .mockResolvedValueOnce(recognition('second try'));
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });
    expect(await screen.findByRole('alert')).toHaveTextContent('没识别到文字');
    expect(bridge.closeOcrPicker).not.toHaveBeenCalled();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });
    await waitFor(() => expect(bridge.setOcrCaptureAndLookup).toHaveBeenCalledWith('second try'));
    // The picture was taken once, not again for each try.
    expect(bridge.getOcrFrame).toHaveBeenCalledTimes(1);
  });

  it('says that a region of one colour has nothing in it, and why it may be so', async () => {
    vi.mocked(bridge.ocrRecognizeFrame).mockResolvedValue(recognition('', { blank: true }));
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('纯色');
    expect(alert).toHaveTextContent('受保护或硬件加速');
    expect(bridge.setOcrCaptureAndLookup).not.toHaveBeenCalled();
  });

  it('shows the reason when the engine fails, and keeps the picture to try again', async () => {
    vi.mocked(bridge.ocrRecognizeFrame).mockRejectedValue(new Error('OCR 异步失败: 0x88982F50'));
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });

    expect(await screen.findByRole('alert')).toHaveTextContent('OCR 异步失败: 0x88982F50');
    expect(screen.getByText(/拖拽框选要识别的英文/)).toBeInTheDocument();
    expect(bridge.closeOcrPicker).not.toHaveBeenCalled();
  });

  it('shows why the text was refused by the lookup (a password, a long number), and stays', async () => {
    vi.mocked(bridge.setOcrCaptureAndLookup).mockRejectedValue('内容被过滤（secret），未发送');
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });

    expect(await screen.findByRole('alert')).toHaveTextContent('内容被过滤（secret），未发送');
    expect(bridge.closeOcrPicker).not.toHaveBeenCalled();
  });
});

describe('a text that is long', () => {
  it('is said to be cut, and then goes on to the lookup', async () => {
    vi.mocked(bridge.ocrRecognizeFrame).mockResolvedValue(
      recognition('x'.repeat(2000), { truncated: true, length: 2000 }),
    );
    const picker = await showPicker();

    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });

    expect(await screen.findByText('文本较长，已截取前 2000 字')).toBeInTheDocument();
    await waitFor(() => expect(bridge.setOcrCaptureAndLookup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
  });
});

describe('leaving the picker', () => {
  it('is done with Esc, and nothing is read', async () => {
    await showPicker();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
    expect(bridge.ocrRecognizeFrame).not.toHaveBeenCalled();
  });

  it('is done with the right button of the mouse, without its menu', async () => {
    const picker = await showPicker();

    const notPrevented = fireEvent.contextMenu(picker);

    expect(notPrevented).toBe(false);
    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
  });

  it('is done with the cancel button, which does not start a selection', async () => {
    await showPicker();

    await userEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
    expect(bridge.ocrRecognizeFrame).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ocr-selection')).not.toBeInTheDocument();
  });

  it('falls back to closing the window itself when the backend cannot', async () => {
    vi.mocked(bridge.closeOcrPicker).mockRejectedValue(new Error('不可用'));
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    await showPicker();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(closeWindow).toHaveBeenCalledTimes(1));
  });
});

describe('when text cannot be read for want of the language pack', () => {
  const missing = {
    available: false,
    language: '',
    installed: ['zh-Hans-CN'],
    message: '没有安装英文 OCR 识别包（本机只有：zh-Hans-CN）。请到「设置 → 时间和语言 → 语言和区域」添加 English (United States)。',
  };

  it('says so, in the window that is shown, and does not let the user drag', async () => {
    vi.mocked(bridge.getOcrStatus).mockResolvedValue(missing);

    const picker = await showPicker();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('现在还不能截图取词');
    expect(alert).toHaveTextContent('没有安装英文 OCR 识别包（本机只有：zh-Hans-CN）');
    drag(picker, { x: 10, y: 10 }, { x: 40, y: 30 });
    expect(bridge.ocrRecognizeFrame).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ocr-selection')).not.toBeInTheDocument();
  });

  it('opens the language settings, and gets out of their way', async () => {
    vi.mocked(bridge.getOcrStatus).mockResolvedValue(missing);
    await showPicker();

    await userEvent.click(await screen.findByRole('button', { name: '打开系统语言设置' }));

    await waitFor(() => expect(bridge.openLanguageSettings).toHaveBeenCalledTimes(1));
    // The picker covers the screen and stays on top: the settings would open behind it.
    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bridge.openLanguageSettings).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bridge.closeOcrPicker).mock.invocationCallOrder[0],
    );
  });

  it('stays, with the reason, when the settings cannot be opened', async () => {
    vi.mocked(bridge.getOcrStatus).mockResolvedValue(missing);
    vi.mocked(bridge.openLanguageSettings).mockRejectedValue(new Error('explorer 不可用'));
    await showPicker();

    await userEvent.click(await screen.findByRole('button', { name: '打开系统语言设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('没能打开系统设置：explorer 不可用');
    expect(bridge.closeOcrPicker).not.toHaveBeenCalled();
  });

  it('can be closed with its button', async () => {
    vi.mocked(bridge.getOcrStatus).mockResolvedValue(missing);
    await showPicker();

    await userEvent.click(await screen.findByRole('button', { name: '关闭' }));

    await waitFor(() => expect(bridge.closeOcrPicker).toHaveBeenCalledTimes(1));
  });

  it('is not assumed when the check itself fails: the user may drag, and the reading says what is wrong', async () => {
    vi.mocked(bridge.getOcrStatus).mockRejectedValue(new Error('命令执行失败'));

    await showPicker();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/拖拽框选要识别的英文/)).toBeInTheDocument();
  });
});
