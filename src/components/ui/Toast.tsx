import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon } from 'lucide-react';
import { classNames } from '../../utils/format';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
}

const TONES: Record<ToastTone, { icon: typeof InfoIcon; className: string }> = {
  info: { icon: InfoIcon, className: 'text-ink-subtle' },
  success: { icon: CheckCircle2Icon, className: 'text-positive' },
  error: { icon: AlertCircleIcon, className: 'text-danger' },
};

interface ToastProps {
  message: ToastMessage | null;
  /** The pointer or the keyboard is on the notice: it should stay while it is read or acted on. */
  onPause?: () => void;
  onResume?: () => void;
}

export function Toast({ message, onPause, onResume }: ToastProps) {
  return (
    <AnimatePresence>
      {message ? (
        <motion.div
          key={message.id}
          // A failure is announced at once; the rest waits for a pause in what is being read out.
          role={message.tone === 'error' ? 'alert' : 'status'}
          aria-live={message.tone === 'error' ? 'assertive' : 'polite'}
          onMouseEnter={onPause}
          onMouseLeave={onResume}
          onFocus={onPause}
          onBlur={onResume}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.16 }}
          className="absolute bottom-4 left-1/2 z-40 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-3 pr-2 shadow-float"
        >
          {React.createElement(TONES[message.tone].icon, {
            size: 14,
            className: classNames('shrink-0', TONES[message.tone].className),
            'aria-hidden': true,
          })}
          <span className="text-xs text-ink-muted">{message.text}</span>
          {message.actionLabel && message.onAction ? (
            <button
              type="button"
              onClick={message.onAction}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
            >
              {message.actionLabel}
            </button>
          ) : (
            <span className="w-1" />
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
