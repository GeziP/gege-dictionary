import React, { useCallback, useState } from 'react';
import { Volume2Icon, SquareIcon } from 'lucide-react';
import { useSpeech } from '../../hooks/useSpeech';
import { useLexNote } from '../../contexts/LexNoteContext';
import { classNames } from '../../utils/format';
import { isTauri, speakText, stopSpeaking } from '../../lib/tauri-bridge';

interface SpeakButtonProps {
  text: string;
  label?: string;
  size?: number | 'sm';
  className?: string;
}

export function SpeakButton({ text, label, size = 14, className }: SpeakButtonProps) {
  const { settings } = useLexNote();
  const { speak, stop, speakingId, supported } = useSpeech(settings.ttsRate);
  const [nativeSpeaking, setNativeSpeaking] = useState(false);

  const iconSize = size === 'sm' ? 12 : typeof size === 'number' ? size : 14;
  const active = speakingId === text || nativeSpeaking;

  const handleClick = useCallback(() => {
    if (active) {
      stop();
      if (nativeSpeaking) void stopSpeaking().catch(() => undefined);
      setNativeSpeaking(false);
      return;
    }
    if (isTauri()) {
      setNativeSpeaking(true);
      // speakText settles when playback really ends (or is superseded/stopped),
      // so the button state tracks the engine instead of a guessed timeout.
      speakText(text, settings.ttsVoice, settings.ttsRate)
        .catch((error) => console.warn('Speech failed:', error))
        .finally(() => setNativeSpeaking(false));
    } else if (supported) {
      speak(text, text);
    }
  }, [active, nativeSpeaking, text, settings.ttsVoice, settings.ttsRate, speak, stop, supported]);

  if (!supported && !isTauri()) return null;

  return (
    <button
      type="button"
      aria-label={label || '朗读'}
      title={label || '朗读'}
      onClick={handleClick}
      className={classNames(
        'inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-ink-subtle transition-colors hover:border-line hover:bg-raised hover:text-accent',
        size === 'sm' ? 'h-5 w-5' : 'h-6 w-6',
        active && 'border-accent-line bg-accent-soft text-accent',
        className
      )}
    >
      {active ? (
        <SquareIcon size={iconSize - 3} fill="currentColor" />
      ) : (
        <Volume2Icon size={iconSize} />
      )}
    </button>
  );
}
