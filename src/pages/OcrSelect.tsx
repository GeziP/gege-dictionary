import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as bridge from '../lib/tauri-bridge';

type Phase = 'select' | 'working' | 'error';

export function OcrSelect() {
  const [phase, setPhase] = useState<Phase>('select');
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState('拖拽框选英文区域，Esc 取消');
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);

  const closeSelf = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().close();
    } catch {
      window.close();
    }
  }, []);

  const finishCapture = useCallback(
    async (r: { x: number; y: number; w: number; h: number }) => {
      if (r.w < 8 || r.h < 8) {
        setHint('选区太小，请重新框选');
        setRect(null);
        return;
      }
      setPhase('working');
      setHint('正在本地识别…');
      try {
        const result = await bridge.ocrRecognizeRegion(r.x, r.y, r.w, r.h);
        const text = (result?.text || '').trim();
        if (!text) {
          setPhase('error');
          setError('未识别到英文，请换一块更清晰的区域');
          return;
        }
        await bridge.setOcrCaptureAndLookup(text);
        await closeSelf();
      } catch (e) {
        setPhase('error');
        setError(String(e));
      }
    },
    [closeSelf]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void closeSelf();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSelf]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (phase !== 'select') return;
    draggingRef.current = true;
    startRef.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current || !startRef.current) return;
    const sx = startRef.current.x;
    const sy = startRef.current.y;
    const x = Math.min(sx, e.clientX);
    const y = Math.min(sy, e.clientY);
    const w = Math.abs(e.clientX - sx);
    const h = Math.abs(e.clientY - sy);
    setRect({ x, y, w, h });
  };

  const onPointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (!rect) return;
    // Convert CSS pixels to physical via devicePixelRatio.
    const dpr = window.devicePixelRatio || 1;
    void finishCapture({
      x: Math.round(rect.x * dpr),
      y: Math.round(rect.y * dpr),
      w: Math.round(rect.w * dpr),
      h: Math.round(rect.h * dpr),
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] cursor-crosshair select-none bg-black/40"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {rect && rect.w > 0 && rect.h > 0 && (
        <div
          className="pointer-events-none absolute border-2 border-accent bg-accent/10"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center">
        <div className="rounded-full bg-ink/90 px-4 py-2 text-[12px] text-canvas shadow-window">
          {phase === 'working' ? hint : phase === 'error' ? error || hint : hint}
          {phase === 'error' && (
            <button
              type="button"
              className="pointer-events-auto ml-3 rounded bg-canvas/20 px-2 py-0.5"
              onClick={() => {
                setPhase('select');
                setError(null);
                setRect(null);
                setHint('拖拽框选英文区域，Esc 取消');
              }}
            >
              重试
            </button>
          )}
          <button
            type="button"
            className="pointer-events-auto ml-3 rounded bg-canvas/20 px-2 py-0.5"
            onClick={() => void closeSelf()}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export default OcrSelect;
