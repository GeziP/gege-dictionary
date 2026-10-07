import React, { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SquareIcon, SunIcon, Volume2Icon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { useSpeech } from '../../hooks/useSpeech';
import * as bridge from '../../lib/tauri-bridge';
import { installedVoiceFor, voiceLabel } from '../../lib/voices';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { SettingsSection } from './SettingsSection';
import { classNames } from '../../utils/format';

const THEMES = [
{ value: 'light' as const, label: '浅色', icon: SunIcon },
{ value: 'dark' as const, label: '深色', icon: MoonIcon },
{ value: 'system' as const, label: '跟随系统', icon: MonitorIcon }];


const SCALES = [
{ value: 'compact' as const, label: '紧凑' },
{ value: 'default' as const, label: '默认' },
{ value: 'large' as const, label: '大字号' }];


const PREVIEW_TEXT = 'The protocol degenerates into a livelock.';

/** "Choose for me": the speech engine takes an English voice, whatever language Windows speaks. */
const AUTOMATIC_VOICE = { value: '', label: '自动（优先英语语音）' };

export function AppearanceSection() {
  const { settings, updateSettings } = useLexNote();
  const { speak } = useSpeech(settings.ttsRate);
  const [voices, setVoices] = useState<string[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // The voices that are really installed, not a list that may name voices this PC does not have.
  useEffect(() => {
    if (!bridge.isTauri()) return;
    let active = true;
    bridge
      .listVoices()
      .then((installed) => {
        if (active) setVoices(installed);
      })
      .catch((error) => {
        if (active) setVoicesError(String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  // The preview goes through the same engine, voice and speed as the reading in the cards.
  const preview = () => {
    setPreviewError(null);
    if (previewing) {
      void bridge.stopSpeaking().catch(() => undefined);
      return;
    }
    if (!bridge.isTauri()) {
      speak(PREVIEW_TEXT, 'preview');
      return;
    }
    setPreviewing(true);
    // Settles when playback has ended, or has been stopped.
    bridge
      .speakText(PREVIEW_TEXT, settings.ttsVoice, settings.ttsRate)
      .catch((error) => setPreviewError(String(error)))
      .finally(() => setPreviewing(false));
  };

  return (
    <div className="space-y-3">
      <SettingsSection title="外观" description="深浅主题均满足 WCAG AA 对比度要求（正文 ≥ 4.5:1）。">
        <div className="grid gap-2 sm:grid-cols-3">
          {THEMES.map((theme) =>
          <button
            key={theme.value}
            type="button"
            onClick={() => updateSettings({ theme: theme.value })}
            className={classNames(
              'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors',
              settings.theme === theme.value ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:border-line-strong'
            )}>
            
              <theme.icon size={15} />
              <span className="text-[12px]">{theme.label}</span>
            </button>
          )}
        </div>

        <div className="mt-4">
          <p className="mb-1.5 text-[11px] text-ink-muted">卡片字号</p>
          <div className="flex gap-1 rounded-md border border-line p-0.5 sm:w-72">
            {SCALES.map((scale) =>
            <button
              key={scale.value}
              type="button"
              onClick={() => updateSettings({ cardScale: scale.value })}
              className={classNames(
                'flex-1 rounded px-2 py-1.5 text-[12px] transition-colors',
                settings.cardScale === scale.value ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-sunken'
              )}>
              
                {scale.label}
              </button>
            )}
          </div>
          <div className="mt-2 rounded-md border border-line bg-raised p-3">
            <p
              className={classNames(
                'font-serif font-bold text-ink',
                settings.cardScale === 'large' ? 'text-[26px]' : settings.cardScale === 'compact' ? 'text-[18px]' : 'text-[22px]'
              )}>
              
              livelock <span className="font-ipa text-[13px] font-normal text-ink-muted">/ˈlaɪvlɑːk/</span>
            </p>
            <p
              className={classNames(
                'mt-1 text-ink-muted',
                settings.cardScale === 'large' ? 'text-[15px]' : settings.cardScale === 'compact' ? 'text-[12px]' : 'text-[13px]'
              )}>
              
              活锁：进程仍在运行，但系统整体没有任何进展。
            </p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="朗读" description="使用 Windows 语音合成引擎，完全离线，不产生任何网络请求。">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">语音</span>
            <Select
              value={installedVoiceFor(settings.ttsVoice, voices)}
              onChange={(event) => updateSettings({ ttsVoice: event.target.value })}
              options={[AUTOMATIC_VOICE, ...voices.map((voice) => ({ value: voice, label: voiceLabel(voice) }))]} />
            
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">语速 {settings.ttsRate.toFixed(1)}×</span>
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.1}
              value={settings.ttsRate}
              onChange={(event) => updateSettings({ ttsRate: Number(event.target.value) })}
              className="mt-2.5 w-full accent-[color:var(--accent)]" />
            
          </label>
        </div>
        {voicesError ? (
          <p role="alert" className="mt-2 text-[11px] text-danger">
            无法读取已安装的语音：{voicesError}
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            icon={previewing ? <SquareIcon size={12} fill="currentColor" /> : <Volume2Icon size={13} />}
            onClick={preview}>
            {previewing ? '停止' : '试听'}
          </Button>
          {previewError ? (
            <p role="alert" className="min-w-0 truncate text-[11px] text-danger" title={previewError}>
              试听失败：{previewError}
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </div>);

}