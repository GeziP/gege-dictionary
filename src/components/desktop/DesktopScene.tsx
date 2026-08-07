import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import { BookMarkedIcon, KeyboardIcon, SearchIcon, XIcon } from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { CHAT, PAPER, WALLPAPER_DARK, WALLPAPER_LIGHT } from '../../data/scenes';
import type { CaptureMethod, LookupRequest } from '../../types/lexnote';
import { detectKind, extractContext } from '../../utils/lookup';
import { classNames } from '../../utils/format';
import { LookupCard } from '../card/LookupCard';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { ChatWindow } from './ChatWindow';
import { PaperWindow } from './PaperWindow';
import { Taskbar } from './Taskbar';
import { DemoControls } from './DemoControls';

const CARD_WIDTH = 420;
const CARD_HEIGHT = 520;
const SUGGESTIONS = ['livelock', 'degenerates', 'adversarial', 'quorum', 'circle back', 'bandwidth'];

type AppId = 'paper' | 'chat';

export function DesktopScene() {
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, captureMethod } = useLexNote();
  const sceneRef = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: 0, y: 0 });

  const [activeApp, setActiveApp] = useState<AppId>('paper');
  const [request, setRequest] = useState<LookupRequest | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ x: 40, y: 40 });
  const [scaled, setScaled] = useState(false);
  const [emptyHint, setEmptyHint] = useState<{x: number;y: number;} | null>(null);
  const [manual, setManual] = useState<{x: number;y: number;} | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [balloon, setBalloon] = useState(Boolean((location.state as {justOnboarded?: boolean;} | null)?.justOnboarded));

  const wallpaper = useMemo(() => {
    const dark =
    settings.theme === 'dark' ||
    settings.theme === 'system' &&
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    return dark ? WALLPAPER_DARK : WALLPAPER_LIGHT;
  }, [settings.theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!emptyHint) return;
    const timer = window.setTimeout(() => setEmptyHint(null), 1800);
    return () => window.clearTimeout(timer);
  }, [emptyHint]);

  useEffect(() => {
    if (!balloon) return;
    const timer = window.setTimeout(() => setBalloon(false), 7000);
    return () => window.clearTimeout(timer);
  }, [balloon]);

  const clampPosition = useCallback(
    (rect: DOMRect | null) => {
      const scene = sceneRef.current?.getBoundingClientRect();
      if (!scene) return { x: 40, y: 40 };
      const factor = scaled ? 1.5 : 1;
      const width = CARD_WIDTH * factor;
      const height = CARD_HEIGHT * factor;
      const rawX = rect ? rect.left - scene.left : scene.width / 2 - width / 2;
      const rawY = rect ? rect.bottom - scene.top + 10 : scene.height / 2 - height / 2;
      return {
        x: Math.max(8, Math.min(rawX, scene.width - width - 8)),
        y: Math.max(8, Math.min(rawY, scene.height - height - 52))
      };
    },
    [scaled]
  );

  const source = useMemo(
    () =>
    activeApp === 'paper' ?
    { app: PAPER.app, title: PAPER.title } :
    { app: CHAT.app, title: CHAT.title },
    [activeApp]
  );

  const startLookup = useCallback(
    (raw: string, contextText: string, method: CaptureMethod, rect: DOMRect | null) => {
      const text = raw.replace(/\s+/g, ' ').trim();
      const anchor = clampPosition(rect);
      setPosition(anchor);
      setPinned(false);
      setAttempt(0);
      setManual(null);
      setEmptyHint(null);
      setRequest({
        selection: text,
        context: settings.captureContext ? contextText : '',
        kind: detectKind(text),
        method,
        sourceApp: source.app,
        sourceTitle: source.title,
        anchor
      });
      if (method === 'clipboard') {
        setToast('已通过模拟复制取词，原剪贴板内容已还原');
      }
    },
    [clampPosition, settings.captureContext, source]
  );

  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text.trim()) {
      const scene = sceneRef.current?.getBoundingClientRect();
      setEmptyHint({
        x: Math.min(Math.max(mouse.current.x - (scene?.left ?? 0), 16), (scene?.width ?? 400) - 260),
        y: Math.min(Math.max(mouse.current.y - (scene?.top ?? 0) + 12, 16), (scene?.height ?? 400) - 120)
      });
      return;
    }
    const range = selection!.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const host = (range.startContainer.parentElement as HTMLElement | null)?.closest(
      'p, h1, h2, figcaption, [data-selectable]'
    );
    const full = host?.textContent ?? text;
    startLookup(text, extractContext(full, text.trim()), captureMethod, rect);
  }, [captureMethod, startLookup]);

  const selectTerm = useCallback(
    (term: string) => {
      const root = sceneRef.current;
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const value = node.textContent ?? '';
        const index = value.toLowerCase().indexOf(term.toLowerCase());
        if (index >= 0 && (node.parentElement as HTMLElement)?.closest('[data-selectable]')) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + term.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          const host = (node.parentElement as HTMLElement | null)?.closest('p, h1, h2, figcaption, [data-selectable]');
          startLookup(term, extractContext(host?.textContent ?? term, term), captureMethod, range.getBoundingClientRect());
          return;
        }
        node = walker.nextNode();
      }
    },
    [captureMethod, startLookup]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && (event.key === 'd' || event.key === 'D' || event.code === 'KeyD')) {
        event.preventDefault();
        captureSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [captureSelection]);

  const openManual = () => {
    const scene = sceneRef.current?.getBoundingClientRect();
    setEmptyHint(null);
    setManual({
      x: Math.min(Math.max(mouse.current.x - (scene?.left ?? 0), 16), (scene?.width ?? 400) - 300),
      y: Math.min(Math.max(mouse.current.y - (scene?.top ?? 0) + 12, 16), (scene?.height ?? 400) - 140)
    });
  };

  const windowClasses = (id: AppId, desktop: string) =>
  classNames(
    'absolute inset-x-3 top-14 bottom-14 lg:bottom-auto lg:inset-x-auto',
    desktop,
    activeApp === id ? 'z-20 flex' : 'z-10 hidden lg:flex'
  );

  return (
    <div
      ref={sceneRef}
      onMouseMove={(event) => {
        mouse.current = { x: event.clientX, y: event.clientY };
      }}
      onMouseDown={() => {
        if (request && !pinned) setRequest(null);
        if (emptyHint) setEmptyHint(null);
      }}
      className="relative h-full w-full overflow-hidden bg-canvas">
      
      <img src={wallpaper} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" />

      <PaperWindow
        active={activeApp === 'paper'}
        onFocus={() => setActiveApp('paper')}
        className={windowClasses('paper', 'lg:left-[2.5%] lg:top-[9%] lg:h-[72%] lg:w-[50%]')} />
      
      <ChatWindow
        active={activeApp === 'chat'}
        onFocus={() => setActiveApp('chat')}
        className={windowClasses('chat', 'lg:right-[3%] lg:top-[16%] lg:h-[54%] lg:w-[33%]')} />
      

      <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface/90 py-1 pl-3 pr-1.5 text-[11px] text-ink-muted shadow-panel backdrop-blur">
          <KeyboardIcon size={13} className="text-accent" />
          在任意窗口选中英文，按
          <kbd className="rounded border border-line bg-raised px-1">Ctrl</kbd>
          <kbd className="rounded border border-line bg-raised px-1">Alt</kbd>
          <kbd className="rounded border border-line bg-raised px-1">D</kbd>
          <Button size="sm" variant="primary" onClick={() => selectTerm('livelock')}>
            试一试
          </Button>
        </div>
      </div>

      <div className="absolute bottom-14 left-3 z-30 hidden lg:block">
        <DemoControls scaled={scaled} onScaleChange={setScaled} />
      </div>

      <AnimatePresence>
        {emptyHint ?
        <motion.div
          key="empty"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          style={{ left: emptyHint.x, top: emptyHint.y }}
          onMouseDown={(event) => event.stopPropagation()}
          className="absolute z-50 flex w-[248px] items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 shadow-float backdrop-blur">
          
            <SearchIcon size={13} className="text-ink-subtle" />
            <span className="text-[12px] text-ink-muted">未检测到选中文本</span>
            <button
            type="button"
            onClick={openManual}
            className="ml-auto text-[11px] text-accent underline-offset-2 hover:underline">
            
              手动输入
            </button>
          </motion.div> :
        null}

        {manual ?
        <motion.div
          key="manual"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          style={{ left: manual.x, top: manual.y }}
          onMouseDown={(event) => event.stopPropagation()}
          className="absolute z-50 w-[300px] rounded-lg border border-line bg-surface/95 p-3 shadow-float backdrop-blur">
          
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] text-ink-muted">手动查询</span>
              <button type="button" aria-label="关闭" onClick={() => setManual(null)} className="text-ink-subtle hover:text-ink">
                <XIcon size={13} />
              </button>
            </div>
            <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!manualValue.trim()) return;
              startLookup(manualValue, '', 'manual', null);
              setManualValue('');
            }}
            className="flex gap-2">
            
              <TextInput
              autoFocus
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              placeholder="输入英文单词或句子"
              className="flex-1" />
            
              <Button type="submit" variant="primary">
                查询
              </Button>
            </form>
          </motion.div> :
        null}

        {request ?
        <div
          key="card"
          className="absolute z-50"
          style={{
            left: position.x,
            top: position.y,
            transform: scaled ? 'scale(1.5)' : undefined,
            transformOrigin: 'top left'
          }}>
          
            <LookupCard
            request={request}
            attempt={attempt}
            pinned={pinned}
            onTogglePin={() => setPinned((value) => !value)}
            onClose={() => setRequest(null)}
            onRetry={() => setAttempt((value) => value + 1)}
            onTryTerm={selectTerm}
            onOpenLibrary={() => navigate('/library')}
            onOpenSettings={() => navigate('/settings')}
            suggestions={SUGGESTIONS} />
          
          </div> :
        null}

        {balloon ?
        <motion.div
          key="balloon"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="absolute bottom-12 right-3 z-40 w-[268px] rounded-lg border border-line bg-surface p-3 shadow-float">
          
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <BookMarkedIcon size={13} className="text-accent" /> 鸽鸽词典已就绪
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
              在任意应用中选中英文后 Ctrl+C 复制即可查询。主程序已最小化到托盘。
            </p>
          </motion.div> :
        null}

        {toast ?
        <motion.div
          key="toast"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          className="absolute bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-[11px] text-ink-muted shadow-float backdrop-blur">
          
            {toast}
          </motion.div> :
        null}
      </AnimatePresence>

      <Taskbar
        activeApp={activeApp}
        onSelectApp={setActiveApp}
        onOpenLibrary={() => navigate('/library')}
        onOpenSettings={() => navigate('/settings')}
        onRunOnboarding={() => navigate('/onboarding')} />
      
    </div>);

}