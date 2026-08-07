import React, { useCallback, useEffect, useState } from 'react';
import { CheckIcon, ClipboardCopyIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { Toggle } from '../ui/Toggle';
import { SettingsSection } from './SettingsSection';
import * as bridge from '../../lib/tauri-bridge';

export function CaptureSection() {
  const { settings, updateSettings } = useLexNote();
  const [watchEnabled, setWatchEnabled] = useState(true);

  useEffect(() => {
    bridge.getClipboardWatchStatus().then(setWatchEnabled).catch(() => {});
  }, []);

  const handleToggle = useCallback(async () => {
    try {
      const next = await bridge.toggleClipboardWatch();
      setWatchEnabled(next);
    } catch (e) {
      console.error('Failed to toggle clipboard watch:', e);
    }
  }, []);

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
          checked={settings.launchAtLogin}
          onChange={(value) => updateSettings({ launchAtLogin: value })}
          label="开机自启并最小化到托盘"
          description="托盘常驻时，划词即查不受主窗口是否打开影响。" />

        <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-positive">
          <CheckIcon size={12} /> 当前常驻内存约 138 MB · 冷启动 1.4s
        </p>
      </SettingsSection>
    </div>
  );
}
