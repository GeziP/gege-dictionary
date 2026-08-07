import React from 'react';
import { HashIcon, MessageSquareIcon } from 'lucide-react';
import { CHAT } from '../../data/scenes';
import { MockWindowChrome } from './MockWindowChrome';
import { MarkedText } from './MarkedText';

interface ChatWindowProps {
  active: boolean;
  onFocus: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function ChatWindow({ active, onFocus, className, style }: ChatWindowProps) {
  return (
    <MockWindowChrome
      title={CHAT.title}
      subtitle={CHAT.app}
      icon={<MessageSquareIcon size={13} />}
      active={active}
      onFocus={onFocus}
      className={className}
      style={style}>
      
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-3 text-xs text-ink-muted">
        <HashIcon size={12} />
        proj-atlas
        <span className="text-ink-subtle">· 12 位成员</span>
      </div>
      <div data-selectable className="selection-demo thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {CHAT.messages.map((message) =>
        <div key={message.id} className="flex gap-2.5">
            <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
            style={{ backgroundColor: message.accent }}
            aria-hidden="true">
            
              {message.initials}
            </span>
            <div className="min-w-0">
              <p className="flex items-baseline gap-1.5">
                <span className="text-xs font-semibold text-ink">{message.author}</span>
                <span className="text-[10px] text-ink-subtle">{message.time}</span>
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
                <MarkedText text={message.text} />
              </p>
            </div>
          </div>
        )}
      </div>
    </MockWindowChrome>);

}