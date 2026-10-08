import React, { useState } from 'react';
import { EyeIcon, EyeOffIcon, ShieldCheckIcon } from 'lucide-react';
import { PROVIDER_PRESETS } from '../../data/providers';
import type { ProviderConfig } from '../../types/lexnote';
import { classNames } from '../../utils/format';
import { TextInput } from '../ui/TextInput';

function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return key ? '••••••••' : '';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

interface ProviderFieldsProps {
  provider: ProviderConfig;
  /** What the user changed; the caller knows which of the settings it belongs to. */
  onChange: (changes: Partial<ProviderConfig>) => void;
  /** Why the stored key could not be used, when it could not. */
  keyError?: string;
}

/**
 * The part of a model service that is the same for the main one and the backup: which service
 * (a preset or a Base URL), which model, and the key, which is never shown once it is stored.
 */
export function ProviderFields({ provider, onChange, keyError }: ProviderFieldsProps) {
  const [showKey, setShowKey] = useState(false);
  const [editingKey, setEditingKey] = useState(false);

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PROVIDER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChange({ name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model })}
            title={`${preset.hint}（${preset.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 协议）`}
            className={classNames(
              'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
              provider.baseUrl === preset.baseUrl
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-ink-muted hover:border-line-strong'
            )}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Base URL</span>
          <TextInput
            value={provider.baseUrl}
            onChange={(event) => {
              const url = event.target.value;
              const matchedPreset = PROVIDER_PRESETS.find((p) => p.baseUrl === url);
              if (matchedPreset) {
                onChange({ baseUrl: url, protocol: matchedPreset.protocol });
              } else {
                const inferredProtocol = (url.includes('/anthropic') || url.includes('anthropic.com'))
                  ? 'anthropic' as const : 'openai' as const;
                onChange({ baseUrl: url, protocol: inferredProtocol });
              }
            }}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Model</span>
          <TextInput value={provider.model} onChange={(event) => onChange({ model: event.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] text-ink-muted">API Key</span>
          {provider.hasApiKey && !editingKey ? (
            <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[12px]">
              <ShieldCheckIcon size={13} className="text-positive" />
              <span className="text-ink">已配置</span>
              <button
                type="button"
                className="ml-auto text-[11px] text-accent hover:underline"
                onClick={() => {
                  setEditingKey(true);
                  onChange({ apiKey: '', hasApiKey: false });
                }}
              >
                更换 Key
              </button>
            </div>
          ) : null}
          <TextInput
            type={showKey || editingKey ? 'text' : 'password'}
            value={editingKey || showKey ? provider.apiKey : ''}
            placeholder={!editingKey && !showKey && provider.apiKey ? maskApiKey(provider.apiKey) : '输入 API Key'}
            onFocus={() => setEditingKey(true)}
            onBlur={() => setEditingKey(false)}
            onChange={(event) => onChange({ apiKey: event.target.value })}
            trailing={
              <button
                type="button"
                aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                onClick={() => setShowKey((value) => !value)}
                className="text-ink-subtle hover:text-ink"
              >
                {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
              </button>
            }
          />

          <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-subtle">
            <ShieldCheckIcon size={11} className="text-positive" />
            经 Windows DPAPI 加密后存储；界面不显示明文，也不会写入日志
          </span>
          {keyError && <span className="mt-1 block text-[11px] text-danger">{keyError}</span>}
        </label>
      </div>
    </>
  );
}
