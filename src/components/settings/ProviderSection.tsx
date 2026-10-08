import React from 'react';
import { CheckCircle2Icon, LoaderIcon, ZapIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { SettingsSection } from './SettingsSection';
import { ProviderFields } from './ProviderFields';
import { connectionOkText, useConnectionTest } from '../../hooks/useConnectionTest';

export function ProviderSection() {
  const { settings, updateSettings } = useLexNote();
  const { provider } = settings;
  const { state: test, test: runTest } = useConnectionTest(provider);

  const patch = (changes: Partial<typeof provider>) =>
  updateSettings({ provider: changes });

  return (
    <div className="space-y-3">
      <SettingsSection
        title="模型服务"
        description="支持 OpenAI Chat Completions 和 Anthropic Messages 两种协议，自动适配。鸽鸽词典不绑定供应商，也不代理你的请求。">

        <ProviderFields provider={provider} onChange={patch} keyError={settings.apiKeyError} />

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
              {connectionOkText(test)}
            </span> :
          null}
          {test.status === 'error' ?
          <span role="alert" className="text-[11px] text-danger">{test.message}</span> :
          null}
        </div>
        <p className="mt-1 text-[10px] text-ink-subtle">
          连接测试只验证鉴权、模型名和短响应；完整翻译会按上方 tokens 与超时设置执行。
        </p>

        <div className="mt-4 border-t border-line pt-3">
          <label className="flex items-center gap-2.5 text-[12px]">
            <input
              type="checkbox"
              checked={settings.streamingEnabled !== false}
              onChange={(e) => updateSettings({ streamingEnabled: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-line accent-accent"
            />
            <span className="text-ink">流式渲染（实时显示查词结果）</span>
          </label>
          <p className="ml-6 mt-0.5 text-[10px] text-ink-subtle">
            关闭后等待完整响应再一次性显示，适合不稳定的网络环境
          </p>
        </div>
      </SettingsSection>
    </div>);

}
