import React from 'react';
import { MonitorIcon, MoonIcon, SunIcon, Volume2Icon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { useSpeech } from '../../hooks/useSpeech';
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


const VOICES = [
'Microsoft Zira - English (United States)',
'Microsoft David - English (United States)',
'Microsoft Hazel - English (United Kingdom)'];


export function AppearanceSection() {
  const { settings, updateSettings } = useLexNote();
  const { speak } = useSpeech(settings.ttsRate);

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
              value={settings.ttsVoice}
              onChange={(event) => updateSettings({ ttsVoice: event.target.value })}
              options={VOICES.map((voice) => ({ value: voice, label: voice.replace('Microsoft ', '') }))} />
            
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
        <Button
          className="mt-3"
          size="sm"
          icon={<Volume2Icon size={13} />}
          onClick={() => speak('The protocol degenerates into a livelock.', 'preview')}>
          
          试听
        </Button>
      </SettingsSection>
    </div>);

}