import React, { useState } from 'react';
import { WindowFrame } from '../components/shell/WindowFrame';
import { ProviderSection } from '../components/settings/ProviderSection';
import { CaptureSection } from '../components/settings/CaptureSection';
import { PromptSection } from '../components/settings/PromptSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { DataSection } from '../components/settings/DataSection';
import { ReviewSection } from '../components/settings/ReviewSection';
import { UpdateSection } from '../components/settings/UpdateSection';
import { GlossarySection } from '../components/settings/GlossarySection';
import { classNames } from '../utils/format';

const TABS = [
{ id: 'provider', label: '模型服务' },
{ id: 'capture', label: '热键与取词' },
{ id: 'prompt', label: 'Prompt 模板' },
{ id: 'glossary', label: '术语与领域' },
{ id: 'appearance', label: '外观与朗读' },
{ id: 'review', label: '复习与会话' },
{ id: 'update', label: '应用更新' },
{ id: 'data', label: '数据与隐私' }];


export function Settings() {
  const [tab, setTab] = useState('provider');

  return (
    <WindowFrame title="设置">
      <div className="thin-scroll flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface px-3">
        {TABS.map((item) =>
        <button
          key={item.id}
          type="button"
          onClick={() => setTab(item.id)}
          className={classNames(
            'relative h-full shrink-0 whitespace-nowrap px-3 text-[12px] transition-colors',
            tab === item.id ? 'text-accent' : 'text-ink-muted hover:text-ink'
          )}>
          
            {item.label}
            <span
            className={classNames(
              'absolute inset-x-2 bottom-0 h-0.5 rounded-t',
              tab === item.id ? 'bg-accent' : 'bg-transparent'
            )} />
          
          </button>
        )}
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl">
          {tab === 'provider' ? <ProviderSection /> : null}
          {tab === 'capture' ? <CaptureSection /> : null}
          {tab === 'prompt' ? <PromptSection /> : null}
          {tab === 'glossary' ? <GlossarySection /> : null}
          {tab === 'appearance' ? <AppearanceSection /> : null}
          {tab === 'review' ? <ReviewSection /> : null}
          {tab === 'update' ? <UpdateSection /> : null}
          {tab === 'data' ? <DataSection /> : null}
        </div>
      </div>
    </WindowFrame>);

}
