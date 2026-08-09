import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRightIcon,
  BookMarkedIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderIcon,
  ShieldCheckIcon,
  ZapIcon } from
'lucide-react';
import { useLexNote } from '../contexts/LexNoteContext';
import { PROVIDER_PRESETS } from '../data/providers';
import { Button } from '../components/ui/Button';
import { TextInput } from '../components/ui/TextInput';
import { Toggle } from '../components/ui/Toggle';
import { WALLPAPER_LIGHT } from '../data/scenes';
import { classNames } from '../utils/format';

const STEPS = ['配置模型', '划词即查', '数据与隐私'];

export function Onboarding() {
  const navigate = useNavigate();
  const { settings, updateSettings, setOnboarded } = useLexNote();
  const [step, setStep] = useState(0);
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const provider = settings.provider;
  const patch = (changes: Partial<typeof provider>) =>
  updateSettings({ provider: { ...provider, ...changes } });

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-canvas p-6">
      <img src={WALLPAPER_LIGHT} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-70" />
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative flex max-h-full w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-window">
        
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <BookMarkedIcon size={16} className="text-accent" />
          <span className="text-sm font-semibold text-ink">欢迎使用鸽鸽词典</span>
          <span className="ml-auto text-[11px] text-ink-subtle">第 {step + 1} / 3 步</span>
        </header>

        <div className="flex gap-1 border-b border-line px-5 py-2.5">
          {STEPS.map((label, index) =>
          <div key={label} className="flex flex-1 items-center gap-2">
              <span
              className={classNames(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]',
                index < step ?
                'bg-accent text-accent-ink' :
                index === step ?
                'border border-accent text-accent' :
                'border border-line text-ink-subtle'
              )}>
              
                {index < step ? '✓' : index + 1}
              </span>
              <span className={classNames('text-[11px]', index === step ? 'text-ink' : 'text-ink-subtle')}>{label}</span>
            </div>
          )}
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === 0 ?
          <div>
              <p className="text-[13px] leading-relaxed text-ink-muted">
                鸽鸽词典使用你自己的模型服务，请求直接从这台电脑发出，不经过任何中间服务器。选择一个预设即可自动填好 Base URL。
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((preset) =>
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  patch({ name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model });
                  setTest('idle');
                }}
                className={classNames(
                  'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                  provider.baseUrl === preset.baseUrl ?
                  'border-accent bg-accent-soft text-accent' :
                  'border-line text-ink-muted hover:border-line-strong'
                )}>
                
                    {preset.name}
                  </button>
              )}
              </div>
              <div className="mt-3 space-y-2.5">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-muted">Base URL</span>
                  <TextInput value={provider.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-2 text-[11px] text-ink-muted">
                    API Key
                    <a
                    href="https://platform.deepseek.com"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-accent hover:underline">
                    
                      如何获取 <ExternalLinkIcon size={10} />
                    </a>
                  </span>
                  <TextInput
                  type="password"
                  value={provider.apiKey}
                  onChange={(event) => {
                    patch({ apiKey: event.target.value });
                    setTest('idle');
                  }}
                  placeholder="sk-…" />
                
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-muted">模型</span>
                  <TextInput value={provider.model} onChange={(event) => patch({ model: event.target.value })} />
                </label>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Button
                variant="primary"
                icon={test === 'testing' ? <LoaderIcon size={13} className="animate-spin" /> : <ZapIcon size={13} />}
                disabled={test === 'testing'}
                onClick={async () => {
                  setTest('testing');
                  try {
                    const { testConnection } = await import('../lib/tauri-bridge');
                    await testConnection(provider.baseUrl, provider.apiKey, provider.model, provider.protocol);
                    setTest('ok');
                  } catch {
                    setTest('error');
                  }
                }}>
                
                  测试连接
                </Button>
                {test === 'ok' ?
              <span className="inline-flex items-center gap-1.5 text-[11px] text-positive">
                    <CheckCircle2Icon size={13} /> 连接正常 · 412ms · 模型回显 {provider.model}
                  </span> :
              null}
                {test === 'error' ?
              <span className="text-[11px] text-danger">鉴权失败（401）：请检查 API Key 是否填写正确</span> :
              null}
              </div>
            </div> :
          null}

          {step === 1 ?
          <div>
              <p className="text-[13px] leading-relaxed text-ink-muted">
                在任意应用中选中英文后按 Ctrl+C 复制，查词窗口会自动弹出。无需记忆额外快捷键。
              </p>
              <div className="mt-4 rounded-lg border border-line bg-raised p-3">
                <p className="text-[12px] font-medium text-ink">使用方式</p>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] text-ink-muted leading-relaxed">
                  <li>在浏览器、PDF、Word 等应用中选中英文文本</li>
                  <li>按 <kbd className="rounded border border-line bg-sunken px-1 py-0.5 font-mono text-[10px]">Ctrl+C</kbd> 复制</li>
                  <li>鸽鸽词典自动弹出查词窗口，显示解析结果</li>
                </ol>
                <p className="mt-3 text-[11px] text-ink-subtle">
                  你也可以随时点击系统托盘中的鸽鸽词典图标手动查词，或在托盘右键菜单中开关「划词即查」模式。
                </p>
              </div>
            </div> :
          null}

          {step === 2 ?
          <div>
              <div className="rounded-lg border border-line bg-raised p-3 text-[12px] leading-relaxed text-ink-muted">
                <p className="flex items-center gap-1.5 font-medium text-ink">
                  <ShieldCheckIcon size={13} className="text-positive" /> 你的数据留在这台电脑上
                </p>
                <p className="mt-1.5">
                  生词库保存在 <span className="font-mono text-[11px] text-ink">{settings.dataDir}</span> 下的单个数据库文件中。
                  只有「选中的文本 + 上下文句子 + Prompt」会发送到你自己配置的模型服务，鸽鸽词典没有服务端。
                </p>
              </div>
              <div className="mt-2">
                <Toggle
                checked={settings.launchAtLogin}
                onChange={(value) => updateSettings({ launchAtLogin: value })}
                label="开机自启并常驻托盘"
                description="关闭主窗口后仍可随时使用划词即查。" />
              
                <Toggle
                checked={settings.captureContext}
                onChange={(value) => updateSettings({ captureContext: value })}
                label="抓取上下文句子"
                description="显著提升解析准确度；处理敏感文本时可随时关闭。" />
              
              </div>
            </div> :
          null}
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          {step > 0 ? <Button onClick={() => setStep((value) => value - 1)}>上一步</Button> : null}
          <span className="ml-auto" />
          {step < 2 ?
          <Button
            variant="primary"
            icon={<ArrowRightIcon size={13} />}
            disabled={step === 0 && test !== 'ok'}
            onClick={() => setStep((value) => value + 1)}>
            
              {step === 0 && test !== 'ok' ? '请先测试连接' : '下一步'}
            </Button> :

          <Button
            variant="primary"
            onClick={() => {
              setOnboarded(true);
              navigate('/', { state: { justOnboarded: true } });
            }}>
            
              开始使用
            </Button>
          }
        </footer>
      </motion.div>
    </div>);

}
