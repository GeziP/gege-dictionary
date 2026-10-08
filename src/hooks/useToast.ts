import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastMessage, ToastTone } from '../components/ui/Toast';

/** How long a notice stays up. */
const PLAIN_MS = 4_000;
/** A notice that offers something to do (an undo) stays longer: it has to be read, and then decided on. */
const WITH_ACTION_MS = 8_000;

export interface ToastOptions {
  actionLabel?: string;
  /** Taking the action puts the notice away; whatever the handler shows next replaces it. */
  onAction?: () => void;
  durationMs?: number;
}

export interface ToastControl {
  toast: ToastMessage | null;
  show: (text: string, tone?: ToastTone, options?: ToastOptions) => void;
  dismiss: () => void;
  /** While the pointer or the keyboard is on the notice it is not put away. */
  pause: () => void;
  /** Gives the notice its whole time again. */
  resume: () => void;
}

/** The one notice a page shows at the bottom of its window, and when it goes away. */
export function useToast(): ToastControl {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const counter = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const duration = useRef(PLAIN_MS);

  const stopTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timer.current = window.setTimeout(() => setToast(null), duration.current);
  }, [stopTimer]);

  const dismiss = useCallback(() => {
    stopTimer();
    setToast(null);
  }, [stopTimer]);

  const show = useCallback(
    (text: string, tone: ToastTone = 'info', options: ToastOptions = {}) => {
      counter.current += 1;
      duration.current = options.durationMs ?? (options.onAction ? WITH_ACTION_MS : PLAIN_MS);
      const { actionLabel, onAction } = options;
      // The notice fades out for a moment after it was put away, and its button can still be
      // pressed then: the action is done once, however often that happens.
      let done = false;
      setToast({
        id: counter.current,
        text,
        tone,
        ...(actionLabel && onAction
          ? {
              actionLabel,
              onAction: () => {
                if (done) return;
                done = true;
                dismiss();
                onAction();
              },
            }
          : {}),
      });
      startTimer();
    },
    [dismiss, startTimer],
  );

  useEffect(() => stopTimer, [stopTimer]);

  return { toast, show, dismiss, pause: stopTimer, resume: startTimer };
}
