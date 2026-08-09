import React from 'react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { SettingsSection } from './SettingsSection';

export function ReviewSection() {
  const { settings, updateSettings } = useLexNote();
  return (
    <div className="space-y-4">
      <SettingsSection title="每日回顾" description="三档轻量复习：答对后间隔 1 / 3 / 7 天，答错回到第一档。">
        <label className="block text-xs text-ink-muted">
          每日上限
          <Select
            className="mt-1.5 max-w-xs"
            value={String(settings.reviewLimit ?? 20)}
            onChange={(event) => updateSettings({ reviewLimit: Number(event.target.value) as 0 | 10 | 20 | 50 })}
            options={[
              { value: '10', label: '10 词' },
              { value: '20', label: '20 词（推荐）' },
              { value: '50', label: '50 词' },
              { value: '0', label: '不限' },
            ]}
          />
        </label>
        <Toggle
          checked={settings.includeLongFormReview === true}
          onChange={(includeLongFormReview) => updateSettings({ includeLongFormReview })}
          label="句子与段落也加入复习"
          description="默认仅复习单词和短语；开启后新收藏的长内容也会入池。"
        />
      </SettingsSection>
      <SettingsSection title="阅读会话" description="同一来源且相邻查词间隔小于阈值时，自动聚合为一次阅读会话。">
        <label className="block text-xs text-ink-muted">
          会话切分间隔
          <Select
            className="mt-1.5 max-w-xs"
            value={String(settings.sessionGapMinutes ?? 30)}
            onChange={(event) => updateSettings({ sessionGapMinutes: Number(event.target.value) as 15 | 30 | 60 })}
            options={[
              { value: '15', label: '15 分钟' },
              { value: '30', label: '30 分钟（推荐）' },
              { value: '60', label: '60 分钟' },
            ]}
          />
        </label>
      </SettingsSection>
    </div>
  );
}
