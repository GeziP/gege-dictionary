import React, { useState } from 'react';
import { PlusIcon, RotateCcwIcon, SaveIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import type { PromptTemplate } from '../../types/lexnote';
import { Button } from '../ui/Button';
import { SettingsSection } from './SettingsSection';
import { classNames } from '../../utils/format';

const VARIABLES = ['{{selection}}', '{{context}}', '{{native_lang}}'];

export function PromptSection() {
  const { templates, saveTemplate, resetTemplates } = useLexNote();
  const [activeId, setActiveId] = useState(templates[0].id);
  const active = templates.find((template) => template.id === activeId) ?? templates[0];
  const [draft, setDraft] = useState(active.body);
  const [savedFlash, setSavedFlash] = useState(false);

  const select = (template: PromptTemplate) => {
    setActiveId(template.id);
    setDraft(template.body);
    setSavedFlash(false);
  };

  const save = () => {
    saveTemplate({ ...active, body: draft });
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1600);
  };

  const addTemplate = () => {
    const template: PromptTemplate = {
      id: `tpl-${Date.now()}`,
      name: '新模板',
      scope: 'all',
      builtIn: false,
      body: '解析 {{selection}}，上下文为 {{context}}，用 {{native_lang}} 回答，输出 JSON。'
    };
    saveTemplate(template);
    select(template);
  };

  return (
    <SettingsSection
      title="Prompt 模板"
      description="解析质量取决于 Prompt。单词、短语与整句分别使用不同模板，可自由编辑并保存多套。">
      
      <div className="flex gap-3">
        <div className="w-44 shrink-0 space-y-1">
          {templates.map((template) =>
          <button
            key={template.id}
            type="button"
            onClick={() => select(template)}
            className={classNames(
              'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
              activeId === template.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'
            )}>
            
              <span className={classNames('block truncate text-[12px]', activeId === template.id ? 'text-accent' : 'text-ink')}>
                {template.name}
              </span>
              <span className="mt-0.5 block text-[10px] text-ink-subtle">
                {template.scope === 'all' ? '全部类型' : template.scope === 'sentence' ? '整句' : '单词 / 短语'}
                {template.builtIn ? ' · 内置' : ''}
              </span>
            </button>
          )}
          <Button size="sm" fullWidth icon={<PlusIcon size={12} />} onClick={addTemplate}>
            新建模板
          </Button>
        </div>

        <div className="min-w-0 flex-1">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Prompt 模板内容"
            rows={12}
            className="thin-scroll w-full resize-none rounded-md border border-line bg-raised p-3 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-accent" />
          
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink-subtle">插入变量</span>
            {VARIABLES.map((variable) =>
            <button
              key={variable}
              type="button"
              onClick={() => setDraft((value) => `${value}${variable}`)}
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-accent hover:text-accent">
              
                {variable}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {savedFlash ? <span className="text-[11px] text-positive">已保存</span> : null}
              <Button size="sm" icon={<RotateCcwIcon size={12} />} onClick={resetTemplates}>
                恢复默认模板
              </Button>
              <Button size="sm" variant="primary" icon={<SaveIcon size={12} />} onClick={save}>
                保存
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
            若模板导致模型输出不再是合法 JSON，卡片会自动降级为纯文本展示，并提示恢复默认模板。
          </p>
        </div>
      </div>
    </SettingsSection>);

}