import React from 'react';
import { CheckCircle2Icon, LoaderIcon, ZapIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { connectionOkText, useConnectionTest } from '../../hooks/useConnectionTest';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { ProviderFields } from './ProviderFields';
import { SettingsSection } from './SettingsSection';

/** Which of the three things a backup cannot work without are still missing, in words. */
function missingParts(backup: { baseUrl: string; model: string; apiKey: string }): string[] {
  const missing: string[] = [];
  if (!backup.baseUrl.trim()) missing.push('Base URL');
  if (!backup.model.trim()) missing.push('Model');
  if (!backup.apiKey.trim()) missing.push('API Key');
  return missing;
}

export function BackupProviderSection() {
  const { settings, updateSettings } = useLexNote();
  const backup = settings.backupProvider;
  const { state: test, test: runTest } = useConnectionTest(backup, true);

  const patch = (changes: Partial<typeof backup>) => updateSettings({ backupProvider: changes });
  const missing = missingParts(backup);

  return (
    <SettingsSection
      title="备用模型"
      description="主模型太忙（429）、服务出错（5xx）、超时或连不上时，自动改用这里的服务再试一次，并在查词结果里写明是哪个模型回答的。Key 无效、模型不存在这类要你去改配置的错误不会触发备用，免得把问题盖住。"
    >
      <Toggle
        checked={backup.enabled}
        onChange={(enabled) => patch({ enabled })}
        label="启用备用模型"
        description="触发时，备用服务会收到与主模型相同的选中文本和上下文，请选择你信任的服务。关闭时不会向它发送任何内容。"
      />

      {backup.enabled ? (
        <div className="mt-3">
          <ProviderFields provider={backup} onChange={patch} keyError={settings.backupApiKeyError} />

          {missing.length > 0 ? (
            <p role="status" className="mt-3 text-[11px] text-ink-muted">
              还缺 {missing.join('、')}，补全之前备用模型不会生效。
            </p>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="primary"
              icon={test.status === 'testing' ? <LoaderIcon size={13} className="animate-spin" /> : <ZapIcon size={13} />}
              onClick={runTest}
              disabled={test.status === 'testing'}
            >
              测试备用连接
            </Button>
            {test.status === 'ok' ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-positive">
                <CheckCircle2Icon size={13} />
                {connectionOkText(test)}
              </span>
            ) : null}
            {test.status === 'error' ? (
              <span role="alert" className="text-[11px] text-danger">{test.message}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
