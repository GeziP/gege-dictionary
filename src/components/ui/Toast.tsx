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

export function Toast({ message }: { message: ToastMessage | null }) {
  return (
    <AnimatePresence>
      {message ? (
        <motion.div
          key={message.id}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.16 }}
          className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-3 pr-2 shadow-float"
        >
          {React.createElement(TONES[message.tone].icon, {
            size: 14,
            className: classNames('shrink-0', TONES[message.tone].className),
            'aria-hidden': true,
          })}
          <span className="text-2xs text-ink-muted">{message.text}</span>
          {message.actionLabel && message.onAction ? (
            <button
              type="button"
              onClick={message.onAction}
              className="rounded-full px-2 py-0.5 text-2xs font-medium text-accent hover:bg-accent-soft"
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
