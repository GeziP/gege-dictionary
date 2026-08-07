import React, { useState } from 'react';
import { ChevronDownIcon, FlaskConicalIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import type { CaptureMethod, NetworkMode } from '../../types/lexnote';
import { classNames } from '../../utils/format';

const NETWORKS: {value: NetworkMode;label: string;}[] = [
{ value: 'ok', label: '正常流式' },
{ value: 'cached', label: '缓存命中' },
{ value: 'timeout', label: '超时' },
{ value: 'auth', label: '鉴权失败' },
{ value: 'offline', label: '离线' },
{ value: 'malformed', label: 'JSON 解析失败' }];


const METHODS: {value: CaptureMethod;label: string;}[] = [
{ value: 'uia', label: 'UI Automation' },
{ value: 'clipboard', label: '剪贴板回退' }];


interface DemoControlsProps {
  scaled: boolean;
  onScaleChange: (value: boolean) => void;
}

export function DemoControls({ scaled, onScaleChange }: DemoControlsProps) {
  const { network, setNetwork, captureMethod, setCaptureMethod } = useLexNote();
  const [open, setOpen] = useState(true);

  return (
    <div className="w-[212px] rounded-lg border border-line bg-surface/90 shadow-panel backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium text-ink-muted">
        
        <FlaskConicalIcon size={12} className="text-accent" />
        演示控制
        <ChevronDownIcon
          size={12}
          className={classNames('ml-auto transition-transform', !open && '-rotate-90')} />
        
      </button>
      {open ?
      <div className="space-y-2.5 border-t border-line px-2.5 py-2.5">
          <fieldset>
            <legend className="mb-1 text-[10px] uppercase tracking-wider text-ink-subtle">模型响应</legend>
            <div className="grid grid-cols-2 gap-1">
              {NETWORKS.map((option) =>
            <button
              key={option.value}
              type="button"
              onClick={() => setNetwork(option.value)}
              className={classNames(
                'rounded border px-1.5 py-1 text-[10px] transition-colors',
                network === option.value ?
                'border-accent bg-accent-soft text-accent' :
                'border-line text-ink-muted hover:border-line-strong'
              )}>
              
                  {option.label}
                </button>
            )}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-[10px] uppercase tracking-wider text-ink-subtle">取词方式</legend>
            <div className="grid grid-cols-2 gap-1">
              {METHODS.map((option) =>
            <button
              key={option.value}
              type="button"
              onClick={() => setCaptureMethod(option.value)}
              className={classNames(
                'rounded border px-1.5 py-1 text-[10px] transition-colors',
                captureMethod === option.value ?
                'border-accent bg-accent-soft text-accent' :
                'border-line text-ink-muted hover:border-line-strong'
              )}>
              
                  {option.label}
                </button>
            )}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[11px] text-ink-muted">
            <input
            type="checkbox"
            checked={scaled}
            onChange={(event) => onScaleChange(event.target.checked)}
            className="h-3 w-3 accent-[color:var(--accent)]" />
          
            模拟 150% DPI 缩放
          </label>
        </div> :
      null}
    </div>);

}