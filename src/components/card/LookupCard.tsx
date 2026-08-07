import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircleIcon,
  ClipboardIcon,
  DatabaseIcon,
  KeyboardIcon,
  LoaderIcon,
  MousePointerClickIcon,
  PinIcon,
  RefreshCwIcon,
  SettingsIcon,
  WifiOffIcon,
  XIcon,
  ChevronDownIcon,
  ChevronRightIcon } from
'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { useLookup } from '../../hooks/useLookup';
import { useSpeech } from '../../hooks/useSpeech';
import type { LookupRequest, SavedWord } from '../../types/lexnote';
import { classNames } from '../../utils/format';
import { toPlainText, truncateSelection } from '../../utils/lookup';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { CardDetails } from './CardDetails';
import { CardPrimary } from './CardPrimary';
import { SaveBar } from './SaveBar';

const METHOD_META = {
  uia: { icon: MousePointerClickIcon, label: 'UI Automation 取词' },
  clipboard: { icon: ClipboardIcon, label: '剪贴板取词 · 已还原原剪贴板' },
  manual: { icon: KeyboardIcon, label: '手动输入' }
};

interface LookupCardProps {
  request: LookupRequest;
  attempt: number;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onRetry: () => void;
  onTryTerm: (term: string) => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  suggestions: string[];
}

export function LookupCard({
  request,
  attempt,
  pinned,
  onTogglePin,
  onClose,
  onRetry,
  onTryTerm,
  onOpenLibrary,
  onOpenSettings,
  suggestions
}: LookupCardProps) {
  const { settings, network, countLookup, saveWord } = useLexNote();
  const state = useLookup(request, network, attempt);
  const { speak } = useSpeech(settings.ttsRate);
  const [contextOpen, setContextOpen] = useState(false);
  const [saveSignal, setSaveSignal] = useState(0);
  const [queued, setQueued] = useState(false);
  const counted = useRef(false);
  const { text: selectionText, truncated } = truncateSelection(request.selection);

  useEffect(() => {
    counted.current = false;
  }, [request, attempt]);

  useEffect(() => {
    if (state.phase === 'done' && !counted.current) {
      counted.current = true;
      countLookup(state.cached ? 0 : 780);
    }
  }, [state.phase, state.cached, countLookup]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (typing) return;
      if (event.key === 'Enter' && state.entry && state.phase === 'done') {
        event.preventDefault();
        setSaveSignal((s) => s + 1);
      }
      if (event.key === ' ' && state.entry) {
        event.preventDefault();
        speak(state.entry.lemma, state.entry.lemma);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, speak, state.entry, state.phase]);

  const MethodIcon = METHOD_META[request.method].icon;
  const streaming = state.phase === 'streaming' || state.phase === 'capturing';

  const queueOffline = () => {
    if (!state.entry) return;
    const word: SavedWord = {
      ...state.entry,
      translation: '（待补全）',
      contextMeaning: '离线记录，联网后自动补全解析。',
      explanation: '',
      senses: [],
      associations: [],
      examples: [],
      collocations: [],
      savedAt: new Date().toISOString(),
      context: request.context,
      sourceApp: request.sourceApp,
      sourceTitle: request.sourceTitle,
      tags: ['待补全'],
      mastery: 'new',
      lookups: 1,
      note: '离线时记录，已加入补全队列。'
    };
    saveWord(word);
    setQueued(true);
  };

  return (
    <motion.div
      role="dialog"
      aria-label={`${request.selection} 的解析`}
      initial={{ opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.985 }}
      transition={{ duration: 0.16, ease: [0.2, 0.9, 0.3, 1] }}
      onMouseDown={(event) => event.stopPropagation()}
      className="flex max-h-[560px] w-[420px] flex-col overflow-hidden rounded-xl border border-line bg-surface/95 shadow-float backdrop-blur-xl"
      style={{ backgroundColor: 'color-mix(in srgb, var(--surface) 94%, transparent)' }}>
      
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-raised px-3">
        <MethodIcon size={12} className="text-accent" />
        <span className="truncate text-[11px] text-ink-muted">{METHOD_META[request.method].label}</span>
        <span className="text-[11px] text-ink-subtle">·</span>
        <span className="truncate text-[11px] text-ink-subtle">{request.sourceApp}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-label={pinned ? '取消钉住' : '钉住卡片'}
            aria-pressed={pinned}
            onClick={onTogglePin}
            className={classNames(
              'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-sunken',
              pinned ? 'text-accent' : 'text-ink-subtle'
            )}>
            
            <PinIcon size={13} fill={pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            aria-label="关闭卡片（Esc）"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-sunken hover:text-ink">
            
            <XIcon size={14} />
          </button>
        </div>
      </header>

      <div className="shrink-0 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-ink-subtle">选中</span>
          <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-ink">“{selectionText}”</span>
          <button
            type="button"
            onClick={() => setContextOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-ink-subtle hover:text-accent">
            
            上下文
            {contextOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </button>
        </div>
        {truncated ?
        <p className="mt-1 text-[11px] text-warn">已截断为前 500 字符，并按整句模式解析</p> :
        null}
        {contextOpen ?
        <p className="mt-1.5 rounded border border-line bg-sunken p-2 font-serif text-[11px] leading-relaxed text-ink-subtle">
            {settings.captureContext ? request.context : '上下文抓取已在设置中关闭，本次仅发送选中文本。'}
          </p> :
        null}
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {state.error === 'auth' ?
        <div className="px-4 py-6 text-center">
            <AlertCircleIcon size={20} className="mx-auto text-danger" />
            <p className="mt-2 text-sm font-medium text-ink">鉴权失败（401）</p>
            <p className="mx-auto mt-1 max-w-[300px] text-xs leading-relaxed text-ink-muted">
              {settings.provider.baseUrl} 拒绝了当前 API Key。请检查 Key 是否过期，或该 Key 是否有权访问 {settings.provider.model}。
            </p>
            <div className="mt-3 flex justify-center gap-2">
              <Button size="sm" variant="primary" icon={<RefreshCwIcon size={12} />} onClick={onRetry}>
                重试
              </Button>
              <Button size="sm" icon={<SettingsIcon size={12} />} onClick={onOpenSettings}>
                打开设置
              </Button>
            </div>
          </div> :
        null}

        {state.error === 'offline' ?
        <div className="px-4 py-6 text-center">
            <WifiOffIcon size={20} className="mx-auto text-warn" />
            <p className="mt-2 text-sm font-medium text-ink">网络不可达</p>
            <p className="mx-auto mt-1 max-w-[300px] text-xs leading-relaxed text-ink-muted">
              未命中本地缓存。可以先记录单词与上下文，联网后在生词库中批量补全解析。
            </p>
            <div className="mt-3 flex justify-center gap-2">
              <Button size="sm" variant="primary" icon={<RefreshCwIcon size={12} />} onClick={onRetry}>
                重试
              </Button>
              <Button size="sm" icon={<DatabaseIcon size={12} />} onClick={queueOffline} disabled={queued}>
                {queued ? '已加入补全队列' : '仅记录单词与上下文'}
              </Button>
            </div>
          </div> :
        null}

        {state.error === 'nodata' ?
        <div className="px-4 py-6 text-center">
            <AlertCircleIcon size={20} className="mx-auto text-ink-subtle" />
            <p className="mt-2 text-sm font-medium text-ink">这段选中内容没有离线演示数据</p>
            <p className="mx-auto mt-1 max-w-[310px] text-xs leading-relaxed text-ink-muted">
              真实版本会把它发给你配置的模型。在这个原型里，下面这些词内置了完整的模型返回，选中它们试试：
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {suggestions.map((term) =>
            <Chip key={term} label={term} onClick={() => onTryTerm(term)} />
            )}
            </div>
          </div> :
        null}

        {state.entry && state.error !== 'auth' && state.error !== 'nodata' && state.error !== 'offline' ?
        <>
            {state.error === 'timeout' ?
          <div className="flex items-start gap-2 border-b border-line bg-highlight px-4 py-2">
                <AlertCircleIcon size={13} className="mt-0.5 shrink-0 text-warn" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-ink">已超过 15 秒未完成</p>
                  <p className="mt-0.5 text-[11px] text-ink-muted">已渲染的部分保留，可重试或更换更快的模型。</p>
                </div>
                <Button size="sm" variant="secondary" icon={<RefreshCwIcon size={12} />} onClick={onRetry}>
                  重试
                </Button>
              </div> :
          null}

            {state.malformed && state.phase === 'done' ?
          <div className="border-b border-line bg-highlight px-4 py-2">
                <p className="text-[12px] font-medium text-ink">模型输出不符合 JSON Schema，已降级为纯文本</p>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  多半是自定义 Prompt 破坏了输出结构。
                  <button type="button" onClick={onOpenSettings} className="ml-1 text-accent underline underline-offset-2">
                    恢复默认模板
                  </button>
                </p>
              </div> :
          null}

            {state.malformed && state.phase === 'done' ?
          <pre className="thin-scroll whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-muted">
                {toPlainText(state.entry)}
              </pre> :

          <>
                <CardPrimary entry={state.entry} revealed={state.revealed} large={settings.cardScale === 'large'} />
                <CardDetails
              entry={state.entry}
              revealed={state.revealed}
              streaming={state.phase === 'streaming' && state.revealed < 6} />
            
              </>
          }
          </> :
        null}

        {!state.entry && state.phase === 'capturing' ?
        <CardPrimary entry={null} revealed={0} large={false} /> :
        null}
      </div>

      {state.entry && state.phase === 'done' && !state.malformed ?
      <SaveBar entry={state.entry} request={request} saveSignal={saveSignal} onOpenLibrary={onOpenLibrary} /> :
      null}

      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-raised px-3 text-[10px] text-ink-subtle">
        {streaming ? <LoaderIcon size={10} className="animate-spin text-accent" /> : null}
        <span className="truncate">{settings.provider.model}</span>
        {state.cached ?
        <span className="rounded bg-accent-soft px-1 py-px text-accent">缓存命中 · 3 天前</span> :
        null}
        {state.firstTokenMs !== null && !state.cached ? <span>首 token {state.firstTokenMs}ms</span> : null}
        {state.phase === 'done' && !state.cached ? <span>用时 {(state.elapsedMs / 1000).toFixed(1)}s</span> : null}
        <span className="ml-auto flex items-center gap-1.5">
          <kbd className="rounded border border-line bg-surface px-1">Esc</kbd> 关闭
          <kbd className="rounded border border-line bg-surface px-1">Enter</kbd> 收藏
          <kbd className="rounded border border-line bg-surface px-1">Space</kbd> 朗读
        </span>
      </footer>
    </motion.div>);

}