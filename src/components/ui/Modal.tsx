import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { XIcon } from 'lucide-react';

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: number;
  children: React.ReactNode;
}

export function Modal({ title, description, onClose, footer, width = 560, children }: ModalProps) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true" />
      
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16 }}
        style={{ width }}
        className="relative flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-window">
        
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-ink-subtle">{description}</p> : null}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded text-ink-subtle hover:bg-sunken hover:text-ink">
            
            <XIcon size={14} />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="flex items-center gap-2 border-t border-line px-4 py-3">{footer}</div> : null}
      </motion.div>
    </div>);

}