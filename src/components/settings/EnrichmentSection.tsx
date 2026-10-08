import React from 'react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { PACE_LABELS, effectiveDailyTokens, effectivePace, formatTokens } from '../../lib/enrichment';
import type { EnrichmentPace } from '../../types/lexnote';
import { Select } from '../ui/Select';
import { SettingsSection } from './SettingsSection';

/** What a day's limit can be set to; the words are what it buys at about 1,500 tokens a word. */
const LIMITS: Array<{ tokens: number; label: string }> = [
  { tokens: 50_000, label: '5 万 tokens（约 30 个词）' },
  { tokens: 100_000, label: '10 万 tokens（约 60 个词，推荐）' },
  { tokens: 300_000, label: '30 万 tokens（约 200 个词）' },
  { tokens: 1_000_000, label: '100 万 tokens（约 650 个词）' },
  { tokens: 0, label: '不限制' },
];

export function EnrichmentSection() {
  const { settings, updateSettings } = useLexNote();
  const limit = effectiveDailyTokens(settings.enrichDailyTokens);
  const pace = effectivePace(settings.enrichPace);

  // A limit written into the settings by hand stays what it is, and is shown as such.
  const limits = LIMITS.some((option) => option.tokens === limit)
    ? LIMITS
    : [...LIMITS, { tokens: limit, label: `${formatTokens(limit)} tokens（自定义）` }];

  return (
    <SettingsSection
      title="批量补全"
      description="把导入时只有释义的词，补全成带义项、例句的完整词条：在生词库里点“开始补全”，或选中几个词再点“补全所选”。用的是上面的主模型，主模型出问题时也会像查词一样改用备用模型。只填空缺的部分，不会覆盖你写的释义、笔记、标签和复习进度。"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-muted">
          每天最多用
          <Select
            className="mt-1.5"
            value={String(limit)}
            onChange={(event) => updateSettings({ enrichDailyTokens: Number(event.target.value) })}
            options={limits.map((option) => ({ value: String(option.tokens), label: option.label }))}
          />
        </label>
        <label className="block text-xs text-ink-muted">
          请求节奏
          <Select
            className="mt-1.5"
            value={pace}
            onChange={(event) => updateSettings({ enrichPace: event.target.value as EnrichmentPace })}
            options={(Object.keys(PACE_LABELS) as EnrichmentPace[]).map((value) => ({
              value,
              label: PACE_LABELS[value],
            }))}
          />
        </label>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-subtle">
        额度按今天查词和补全一共用掉的 tokens 估算，是估算值，不是服务商的账单；快到上限时补全会自动停下，没补完的词明天可以接着补。
        节奏越快越容易被服务商限流，被限流时会自动放慢重试。
      </p>
    </SettingsSection>
  );
}
