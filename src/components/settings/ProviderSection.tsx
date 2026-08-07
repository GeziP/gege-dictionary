import React, { useState } from 'react';
import { CheckCircle2Icon, EyeIcon, EyeOffIcon, LoaderIcon, ShieldCheckIcon, ZapIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { PROVIDER_PRESETS } from '../../data/providers';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { SettingsSection } from './SettingsSection';
import { classNames } from '../../utils/format';

type TestState = {status: 'idle';} | {status: 'testing';} | {status: 'ok';latency: number;} | {status: 'error';};

export function ProviderSection() {
  const { settings, updateSettings } = useLexNote();
  const { provider } = settings;
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  const patch = (changes: Partial<typeof provider>) =>
  updateSettings({ provider: { ...provider, ...changes } });

  const runTest = async () => {
    setTest({ status: 'testing' });
    try {
      const { testConnection } = await import('../../lib/tauri-bridge');
      const result = await testConnection(provider.baseUrl, provider.apiKey, provider.model, provider.protocol);
      setTest({ status: 'ok', latency: result.latency });
    } catch (e) {
      setTest({ status: 'error' });
    }
  };

  return (
    <div className="space-y-3">
      <SettingsSection
        title="模型服务"
        description="支持 OpenAI Chat Completions 和 Anthropic Messages 两种协议，自动适配。鸽鸽词典不绑定供应商，也不代理你的请求。">
        
        <div className="mb-3 flex flex-wrap gap-1.5">
          {PROVIDER_PRESETS.map((preset) =>
          <button
            key={preset.id}
            type="button"
            onClick={() => patch({ name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model })}
            title={`${preset.hint}（${preset.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 协议）`}
            className={classNames(
              'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
              provider.baseUrl === preset.baseUrl ?
              'border-accent bg-accent-soft text-accent' :
              'border-line text-ink-muted hover:border-line-strong'
            )}>
            
              {preset.name}
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Base URL</span>
            <TextInput value={provider.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Model</span>
            <TextInput value={provider.model} onChange={(event) => patch({ model: event.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[11px] text-ink-muted">API Key</span>
            <TextInput
              type={showKey ? 'text' : 'password'}
              value={provider.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
              trailing={
              <button
                type="button"
                aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                onClick={() => setShowKey((value) => !value)}
                className="text-ink-subtle hover:text-ink">
                
                  {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                </button>
              } />
            
            <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-subtle">
              <ShieldCheckIcon size={11} className="text-positive" />
              经 Windows DPAPI 加密后存储，不会以明文写入配置文件或日志
            </span>
          </label>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {[
          { label: '温度', value: provider.temperature, step: 0.1, min: 0, max: 2, key: 'temperature' as const },
          { label: '最大 tokens', value: provider.maxTokens, step: 100, min: 200, max: 4000, key: 'maxTokens' as const },
          { label: '超时（秒）', value: provider.timeoutSeconds, step: 1, min: 5, max: 60, key: 'timeoutSeconds' as const }].
          map((field) =>
          <label key={field.key} className="block">
              <span className="mb-1 block text-[11px] text-ink-muted">{field.label}</span>
              <TextInput
              type="number"
              value={field.value}
              step={field.step}
              min={field.min}
              max={field.max}
              onChange={(event) => patch({ [field.key]: Number(event.target.value) } as never)} />
            
            </label>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            icon={test.status === 'testing' ? <LoaderIcon size={13} className="animate-spin" /> : <ZapIcon size={13} />}
            onClick={runTest}
            disabled={test.status === 'testing'}>
            
            测试连接
          </Button>
          {test.status === 'ok' ?
          <span className="inline-flex items-center gap-1.5 text-[11px] text-positive">
              <CheckCircle2Icon size={13} />
              连接正常 · {test.latency}ms · 模型回显 {provider.model}
            </span> :
          null}
          {test.status === 'error' ?
          <span className="text-[11px] text-danger">鉴权失败（401）：API Key 为空或无效</span> :
          null}
        </div>
      </SettingsSection>
    </div>);

}