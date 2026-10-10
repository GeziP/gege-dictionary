import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as bridge from '../lib/tauri-bridge';
import {
  MIN_SELECTION,
  decodeFrame,
  rectBetween,
  toFrameRegion,
  type Rect,
  type Size,
} from '../lib/ocr-frame';
import { errorText } from '../utils/format';

/**
 * The window in which the user picks the text to read off the screen.
 *
 * The backend photographs the screen before this window is shown, and the window is that
 * picture: it is drawn on a canvas, dimmed, and the user drags a rectangle on it. Nothing of the
 * desktop has to show through (so none of it depends on a transparent window), nothing has to be
 * hidden to be photographed, and what is read is exactly what was seen. The window stays hidden
 * until the picture is on the canvas, or until there is a problem to show in its place.
 */

type Phase = 'loading' | 'select' | 'working' | 'blocked';

interface Notice {
  tone: 'info' | 'error';
  text: string;
}

interface Blocked {
  message: string;
  /** The way out is in the system settings (a missing OCR pack), not in this app. */
  canOpenLanguageSettings: boolean;
}

const SELECT_HINT = '拖拽框选要识别的英文，Esc 或右键取消';
const TOO_SMALL = '选区太小，请重新框选';
const NO_TEXT = '没识别到文字，换一块更清晰的区域再试';
const BLANK_REGION =
  '这块是纯色的，里面没有文字。如果这里本该有画面（比如视频字幕），可能是受保护或硬件加速的内容，截图取不到。';
/** How long the notice that the text was cut is read before the lookup window takes over. */
const TRUNCATED_SHOWN_MS = 900;

const keepPointer = (event: React.PointerEvent) => event.stopPropagation();

export function OcrSelect() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameSize = useRef<Size | null>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [rect, setRect] = useState<Rect | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const close = useCallback(async () => {
    try {
      await bridge.closeOcrPicker();
    } catch {
      window.close();
    }
  }, []);

  // Draws the picture of the screen, then lets the backend show the window.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [buffer, status] = await Promise.all([
          bridge.getOcrFrame(),
          bridge.getOcrStatus().catch(() => null),
        ]);
        if (cancelled) return;
        const frame = decodeFrame(buffer);
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) throw new Error('页面无法绘制截图');
        canvas.width = frame.width;
        canvas.height = frame.height;
        context.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
        frameSize.current = { width: frame.width, height: frame.height };
        if (status && !status.available) {
          setBlocked({ message: status.message, canOpenLanguageSettings: true });
          setPhase('blocked');
        } else {
          setPhase('select');
        }
      } catch (reason) {
        if (cancelled) return;
        setBlocked({
          message: `没能取得屏幕截图：${errorText(reason)}`,
          canOpenLanguageSettings: false,
        });
        setPhase('blocked');
      }
      // Whatever happened, the window is shown: a problem has to be seen, not hidden.
      try {
        await bridge.ocrPickerReady();
      } catch {
        /* the window is already gone */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const read = useCallback(
    async (selection: Rect) => {
      const frame = frameSize.current;
      const page = { width: window.innerWidth, height: window.innerHeight };
      const region =
        frame && selection.w >= MIN_SELECTION && selection.h >= MIN_SELECTION
          ? toFrameRegion(selection, page, frame)
          : null;
      if (!region) {
        setRect(null);
        setNotice({ tone: 'error', text: TOO_SMALL });
        return;
      }
      setPhase('working');
      setNotice(null);
      try {
        const result = await bridge.ocrRecognizeFrame(region.x, region.y, region.w, region.h);
        const text = (result.text || '').trim();
        if (result.blank || !text) {
          setRect(null);
          setPhase('select');
          setNotice({ tone: 'error', text: result.blank ? BLANK_REGION : NO_TEXT });
          return;
        }
        if (result.truncated) {
          setNotice({ tone: 'info', text: `文本较长，已截取前 ${result.length} 字` });
          await new Promise((resolve) => setTimeout(resolve, TRUNCATED_SHOWN_MS));
        }
        await bridge.setOcrCaptureAndLookup(text);
        await close();
      } catch (reason) {
        // The picture is still here, so the user can simply try again.
        setRect(null);
        setPhase('select');
        setNotice({ tone: 'error', text: errorText(reason) });
      }
    },
    [close],
  );

  const openLanguageSettings = useCallback(async () => {
    try {
      await bridge.openLanguageSettings();
    } catch (reason) {
      setBlocked((current) =>
        current
          ? { ...current, message: `${current.message}\n（没能打开系统设置：${errorText(reason)}）` }
          : current,
      );
      return;
    }
    // The picker covers the screen and stays on top, so the settings would open behind it.
    await close();
  }, [close]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== 'select' || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragFrom.current = { x: event.clientX, y: event.clientY };
    setNotice(null);
    setRect({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    setRect(rectBetween(from, { x: event.clientX, y: event.clientY }));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    dragFrom.current = null;
    void read(rectBetween(from, { x: event.clientX, y: event.clientY }));
  };

  const onPointerCancel = () => {
    dragFrom.current = null;
    setRect(null);
  };

  const cursor =
    phase === 'select' ? 'cursor-crosshair' : phase === 'working' ? 'cursor-progress' : 'cursor-default';
  const selecting = rect !== null && rect.w > 0 && rect.h > 0;
  const status =
    phase === 'working' ? '正在本地识别…' : phase === 'loading' ? '正在载入截图…' : SELECT_HINT;

  return (
    <div
      role="application"
      aria-label="截图取词"
      className={`fixed inset-0 touch-none select-none overflow-hidden bg-black ${cursor}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => {
        event.preventDefault();
        void close();
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="ocr-canvas"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      />
      {selecting ? (
        // The shadow is what dims everything but the selection.
        <div
          data-testid="ocr-selection"
          className="pointer-events-none absolute border-2 border-[#4fc0ae]"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.55), 0 0 0 100vmax rgba(0,0,0,0.4)',
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/40" />
      )}

      {blocked ? (
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <div
            role="alert"
            className="max-w-lg rounded-2xl bg-black/85 p-6 text-white shadow-window"
            onPointerDown={keepPointer}
          >
            <p className="text-[15px] font-semibold">现在还不能截图取词</p>
            <p className="mt-2 whitespace-pre-line text-[12.5px] leading-relaxed text-white/85">
              {blocked.message}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              {blocked.canOpenLanguageSettings ? (
                <button
                  type="button"
                  className="rounded-md bg-[#4fc0ae] px-3 py-1.5 text-[12px] font-medium text-black hover:bg-[#63d0be]"
                  onClick={() => void openLanguageSettings()}
                >
                  打开系统语言设置
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-md bg-white/20 px-3 py-1.5 text-[12px] hover:bg-white/30"
                onClick={() => void close()}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-x-0 top-6 flex flex-col items-center gap-2">
          <div
            className="pointer-events-auto flex items-center gap-3 rounded-full bg-black/80 px-4 py-2 text-[12px] text-white shadow-window"
            onPointerDown={keepPointer}
          >
            <span>{status}</span>
            <button
              type="button"
              className="rounded bg-white/20 px-2 py-0.5 hover:bg-white/30"
              onClick={() => void close()}
            >
              取消
            </button>
          </div>
          {notice ? (
            <div
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto max-w-xl rounded-xl px-4 py-2 text-[12px] leading-relaxed text-white shadow-window ${
                notice.tone === 'error' ? 'bg-red-700/90' : 'bg-black/80'
              }`}
              onPointerDown={keepPointer}
            >
              {notice.text}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default OcrSelect;
