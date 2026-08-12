import React, { useCallback, useEffect, useState } from 'react';
import { CheckIcon, ClipboardCopyIcon, ShieldIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { Toggle } from '../ui/Toggle';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextInput } from '../ui/TextInput';
import { SettingsSection } from './SettingsSection';
import * as bridge from '../../lib/tauri-bridge';

const CLIPBOARD_MODES = [
  { value: 'smart' as const, label: '智能', icon: <ShieldIcon size={12} /> },
  { value: 'full' as const, label: '全量' },
  { value: 'double' as const, label: '双击 Ctrl+C' },
];

export function CaptureSection() {
  const { settings, updateSettings } = useLexNote();
  const [watchEnabled, setWatchEnabled] = useState(true);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [blacklistInput, setBlacklistInput] = useState(
    (settings.clipboardBlacklist || []).join(', ')
  );

  useEffect(() => {
    bridge.getClipboardWatchStatus().then(setWatchEnabled).catch((error) => {
      console.error('Failed to read clipboard watch status:', error);
    });
  }, []);

  useEffect(() => {
    bridge.getAutostartStatus().then(setAutostartEnabled).catch((error) => {
      setAutostartError(String(error));
    });
  }, []);

  const handleAutostart = useCallback(async (enabled: boolean) => {
    setAutostartError(null);
    try {
      const actual = await bridge.setAutostart(enabled);
      setAutostartEnabled(actual);
      updateSettings({ launchAtLogin: actual });
    } catch (error) {
      setAutostartError(String(error));
    }
  }, [updateSettings]);

  const handleToggle = useCallback(async () => {
    try {
      const next = await bridge.toggleClipboardWatch();
      setWatchEnabled(next);
      updateSettings({ clipboardWatch: next });
    } catch (e) {
      console.error('Failed to toggle clipboard watch:', e);
    }
  }, [updateSettings]);

  const handleBlacklistBlur = () => {
    const entries = blacklistInput
      .split(/[,，\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    updateSettings({ clipboardBlacklist: entries });
  };

  return (
    <div className="space-y-3">
      <SettingsSection
        title="划词即查"
        description="开启后，在任意应用中复制（Ctrl+C）英文单词、短语或句子时，自动弹出查词窗口。也可随时点击托盘图标手动查词。">

        <Toggle
          checked={watchEnabled}
          onChange={handleToggle}
          label="监听剪贴板"
          description="复制英文文本时自动弹出查词窗口。也可在系统托盘右键菜单中开关。" />

        <div className="mt-3">
          <label className="mb-1.5 block text-[11px] font-medium text-ink-muted">触发模式</label>
          <SegmentedControl
            label="剪贴板触发模式"
            options={CLIPBOARD_MODES}
            value={(settings.clipboardMode as 'smart' | 'full' | 'double') || 'smart'}
            onChange={(mode) => updateSettings({ clipboardMode: mode })}
          />
          <p className="mt-1.5 text-[10px] text-ink-subtle">
            {(settings.clipboardMode || 'smart') === 'smart' && '智能模式：自动过滤密钥、代码、路径等非英文学习内容'}
            {settings.clipboardMode === 'full' && '全量模式：任何英文文本都会触发查词（慎用）'}
            {settings.clipboardMode === 'double' && '双击模式：700ms 内连续按两次 Ctrl+C 才触发'}
          </p>
        </div>

        <div className="mt-3">
          <label className="mb-1.5 block text-[11px] font-medium text-ink-muted">应用黑名单</label>
          <TextInput
            label="黑名单"
            hideLabel
            value={blacklistInput}
            onChange={(e) => setBlacklistInput(e.target.value)}
            onBlur={handleBlacklistBlur}
            placeholder="逗号分隔的进程名或窗口标题关键词"
            hint="从这些应用复制时不会触发查词（默认已排除密码管理器和终端）"
          />
        </div>

        <div className="mt-3 rounded-md border border-line bg-raised p-3">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <ClipboardCopyIcon size={13} className="text-accent" /> 使用方式
          </p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[11px] text-ink-muted leading-relaxed">
            <li>在任意应用中选中英文文本</li>
            <li>按 <kbd className="rounded border border-line bg-sunken px-1 py-0.5 font-mono text-[10px]">Ctrl+C</kbd> 复制</li>
            <li>查词窗口自动弹出，显示解析结果</li>
          </ol>
          <p className="mt-2 text-[11px] text-ink-subtle">
            也可以关闭自动监听，随时点击系统托盘图标手动查词（读取剪贴板内容）。
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        title="上下文设置"
        description="控制发送给 LLM 的上下文信息。">

        <Toggle
          checked={settings.captureContext}
          onChange={(value) => updateSettings({ captureContext: value })}
          label="发送上下文句子"
          description="目前剪贴板模式下仅发送复制的文本本身。关闭后可减少 token 消耗。" />
      </SettingsSection>

      <SettingsSection title="常驻行为">
        <Toggle
          checked={autostartEnabled}
          onChange={handleAutostart}
          label="开机自启并最小化到托盘"
          description="托盘常驻时，划词即查不受主窗口是否打开影响。" />

        {autostartError && <p className="mt-1 text-[11px] text-danger">开机自启设置失败，系统状态未更新：{autostartError}</p>}

        <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-positive">
          <CheckIcon size={12} /> 当前常驻内存约 138 MB · 冷启动 1.4s
        </p>
      </SettingsSection>
    </div>
  );
}
