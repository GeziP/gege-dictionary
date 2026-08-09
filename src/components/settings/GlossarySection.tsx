import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DownloadIcon,
  Edit3Icon,
  FileUpIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import * as bridge from '../../lib/tauri-bridge';
import type {
  AnalysisStyle,
  DomainProfile,
  GlossaryImportReport,
  GlossaryTerm,
} from '../../types/lexnote';
import { classNames } from '../../utils/format';
import { Button } from '../ui/Button';
import { SettingsSection } from './SettingsSection';

const PAGE_SIZE = 10;

const DOMAINS: Array<{ id: DomainProfile; name: string; description: string }> = [
  { id: 'general', name: '通用', description: '自然、准确，不强行扩展专业背景' },
  { id: 'computing', name: '计算机', description: '机制、架构、算法与工程边界' },
  { id: 'medical_ivd', name: '医疗 / IVD', description: '检测原理、临床意义与标准口径' },
  { id: 'finance', name: '金融', description: '市场机制、指标口径与风险语境' },
  { id: 'legal', name: '法律', description: '法域差异、规范语义与权利义务' },
];

const STYLES: Array<{ id: AnalysisStyle; name: string; description: string }> = [
  { id: 'concise', name: '简洁', description: '翻译与语境义优先' },
  { id: 'standard', name: '标准', description: '完整的字典级解析' },
  { id: 'deep', name: '深度', description: '强化原理、边界与领域扩展' },
];

type Draft = Pick<
  GlossaryTerm,
  'id' | 'term' | 'translation' | 'domain' | 'note' | 'caseSensitive' | 'enabled'
>;

function emptyDraft(domain: DomainProfile): Draft {
  return {
    id: '',
    term: '',
    translation: '',
    domain,
    note: '',
    caseSensitive: false,
    enabled: true,
  };
}

export function GlossarySection() {
  const { settings, updateSettings } = useLexNote();
  const isTauri = bridge.isTauri();
  const [items, setItems] = useState<GlossaryTerm[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<DomainProfile | ''>('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft(settings.activeDomainProfile));
  const [status, setStatus] = useState<{ type: 'ok' | 'error'; message: string } | null>(null);
  const [report, setReport] = useState<GlossaryImportReport | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<'overwrite' | 'skip'>('overwrite');
  const fileInput = useRef<HTMLInputElement>(null);

  const flash = useCallback((type: 'ok' | 'error', message: string) => {
    setStatus({ type, message });
    window.setTimeout(() => setStatus(null), 5000);
  }, []);

  const load = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    try {
      const result = await bridge.listGlossaryTerms(query, domainFilter, PAGE_SIZE, page * PAGE_SIZE);
      setItems(result.items);
      setTotal(result.total);
      if (page > 0 && result.items.length === 0 && result.total > 0) setPage(page - 1);
    } catch (error) {
      flash('error', `加载术语失败：${error}`);
    } finally {
      setLoading(false);
    }
  }, [domainFilter, flash, isTauri, page, query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const startAdd = () => {
    setDraft(emptyDraft(settings.activeDomainProfile));
    setEditing(true);
  };

  const startEdit = (term: GlossaryTerm) => {
    setDraft({
      id: term.id,
      term: term.term,
      translation: term.translation,
      domain: term.domain,
      note: term.note,
      caseSensitive: term.caseSensitive,
      enabled: term.enabled,
    });
    setEditing(true);
  };

  const save = async () => {
    if (!draft.term.trim() || !draft.translation.trim()) {
      flash('error', '请填写英文术语与固定译法');
      return;
    }
    setLoading(true);
    try {
      await bridge.saveGlossaryTerm(draft);
      setEditing(false);
      flash('ok', draft.id ? '术语已更新' : '术语已添加');
      await load();
    } catch (error) {
      flash('error', `保存失败：${error}`);
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (term: GlossaryTerm) => {
    try {
      await bridge.saveGlossaryTerm({ ...term, enabled: !term.enabled });
      await load();
    } catch (error) {
      flash('error', `更新失败：${error}`);
    }
  };

  const remove = async (term: GlossaryTerm) => {
    if (!window.confirm(`删除术语“${term.term}”？`)) return;
    try {
      await bridge.deleteGlossaryTerms([term.id]);
      flash('ok', '术语已删除');
      await load();
    } catch (error) {
      flash('error', `删除失败：${error}`);
    }
  };

  const importFile = async (file: File) => {
    const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'tsv';
    setLoading(true);
    try {
      const result = await bridge.importGlossary(await file.text(), format, conflictPolicy);
      setReport(result);
      flash('ok', `导入完成：新增 ${result.inserted}，覆盖 ${result.updated}，跳过 ${result.skipped}`);
      setPage(0);
      await load();
    } catch (error) {
      flash('error', `导入失败：${error}`);
    } finally {
      setLoading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const exportFile = async (format: 'json' | 'tsv') => {
    try {
      const content = await bridge.exportGlossary(format, domainFilter || undefined);
      const suffix = domainFilter ? `-${domainFilter}` : '';
      const path = await bridge.saveFileDialog(
        `gege-glossary${suffix}.${format}`,
        content,
        format === 'json' ? 'JSON' : 'TSV',
        [format],
      );
      if (path) flash('ok', `术语表已导出为 ${format.toUpperCase()}`);
    } catch (error) {
      flash('error', `导出失败：${error}`);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <SettingsSection
        title="领域 Profile"
        description="领域会影响知识扩展方向；通用术语与当前领域术语会共同参与匹配。"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {DOMAINS.map((domain) => (
            <button
              key={domain.id}
              type="button"
              onClick={() => updateSettings({ activeDomainProfile: domain.id })}
              className={classNames(
                'rounded-md border px-3 py-2 text-left transition-colors',
                settings.activeDomainProfile === domain.id
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-raised hover:border-line-strong',
              )}
            >
              <span className="block text-[12px] font-medium text-ink">{domain.name}</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-subtle">
                {domain.description}
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="解析风格" description="高级用户仍可在 Prompt 模板页继续编辑完整模板。">
        <div className="grid grid-cols-3 gap-2">
          {STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() => updateSettings({ analysisStyle: style.id })}
              className={classNames(
                'min-w-0 rounded-md border px-2 py-2 text-left transition-colors',
                settings.analysisStyle === style.id
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-raised hover:border-line-strong',
              )}
            >
              <span className="block text-[12px] font-medium text-ink">{style.name}</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-subtle">
                {style.description}
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="个人术语表"
        description="只在选中文本或上下文实际命中时发送给模型；内容保存在本机 SQLite。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-control min-w-[180px] flex-1 items-center gap-1.5 rounded-md border border-line bg-raised px-2.5">
            <SearchIcon size={12} className="text-ink-subtle" />
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(0); }}
              placeholder="搜索术语或译法"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none"
            />
          </label>
          <select
            value={domainFilter}
            onChange={(event) => { setDomainFilter(event.target.value as DomainProfile | ''); setPage(0); }}
            className="h-control rounded-md border border-line bg-surface px-2 text-[11px] text-ink"
          >
            <option value="">全部领域</option>
            {DOMAINS.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
          </select>
          <Button size="sm" variant="primary" icon={<PlusIcon size={12} />} onClick={startAdd}>新增</Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          <input
            ref={fileInput}
            type="file"
            accept=".json,.tsv,application/json,text/tab-separated-values"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          <Button size="sm" variant="ghost" icon={<FileUpIcon size={12} />} onClick={() => fileInput.current?.click()}>
            导入 JSON / TSV
          </Button>
          <select
            value={conflictPolicy}
            aria-label="导入冲突策略"
            onChange={(event) => setConflictPolicy(event.target.value as 'overwrite' | 'skip')}
            className="h-control rounded-md border border-line bg-surface px-2 text-[10px] text-ink"
          >
            <option value="overwrite">重复时覆盖</option>
            <option value="skip">重复时跳过</option>
          </select>
          <Button size="sm" variant="ghost" icon={<DownloadIcon size={12} />} onClick={() => exportFile('json')}>
            导出 JSON
          </Button>
          <Button size="sm" variant="ghost" icon={<DownloadIcon size={12} />} onClick={() => exportFile('tsv')}>
            导出 TSV
          </Button>
          <span className="ml-auto text-[10px] text-ink-subtle">共 {total} 条</span>
        </div>

        {editing ? (
          <div className="mt-3 rounded-md border border-accent/40 bg-accent-soft p-3">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-medium text-ink">{draft.id ? '编辑术语' : '新增术语'}</p>
              <button type="button" aria-label="关闭编辑器" onClick={() => setEditing(false)} className="text-ink-subtle hover:text-ink">
                <XIcon size={14} />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                value={draft.term}
                maxLength={200}
                onChange={(event) => setDraft((value) => ({ ...value, term: event.target.value }))}
                placeholder="英文术语，例如 deadlock"
                className="h-control rounded-md border border-line bg-surface px-2.5 text-[11px] text-ink outline-none focus:border-accent"
              />
              <input
                value={draft.translation}
                maxLength={500}
                onChange={(event) => setDraft((value) => ({ ...value, translation: event.target.value }))}
                placeholder="固定译法，例如 死锁"
                className="h-control rounded-md border border-line bg-surface px-2.5 text-[11px] text-ink outline-none focus:border-accent"
              />
              <select
                value={draft.domain}
                onChange={(event) => setDraft((value) => ({ ...value, domain: event.target.value as DomainProfile }))}
                className="h-control rounded-md border border-line bg-surface px-2 text-[11px] text-ink"
              >
                {DOMAINS.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
              </select>
              <input
                value={draft.note}
                maxLength={1000}
                onChange={(event) => setDraft((value) => ({ ...value, note: event.target.value }))}
                placeholder="备注（可选）"
                className="h-control rounded-md border border-line bg-surface px-2.5 text-[11px] text-ink outline-none focus:border-accent"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-ink-muted">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.caseSensitive} onChange={(event) => setDraft((value) => ({ ...value, caseSensitive: event.target.checked }))} />
                区分大小写
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))} />
                启用
              </label>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
                <Button size="sm" variant="primary" loading={loading} onClick={save}>保存</Button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-3 space-y-1.5">
          {items.map((term) => (
            <div key={term.id} className={classNames('flex min-w-0 items-center gap-2 rounded-md border border-line px-2.5 py-2', !term.enabled && 'opacity-55')}>
              <button
                type="button"
                role="switch"
                aria-checked={term.enabled}
                aria-label={`${term.enabled ? '停用' : '启用'} ${term.term}`}
                onClick={() => toggle(term)}
                className={classNames('h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors', term.enabled ? 'bg-accent' : 'bg-line-strong')}
              >
                <span className={classNames('block h-3 w-3 rounded-full bg-white transition-transform', term.enabled && 'translate-x-3')} />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-ink"><span className="font-medium">{term.term}</span> → {term.translation}</p>
                <p className="mt-0.5 truncate text-[10px] text-ink-subtle">
                  {DOMAINS.find((domain) => domain.id === term.domain)?.name ?? term.domain}
                  {term.caseSensitive ? ' · 区分大小写' : ''}
                  {term.note ? ` · ${term.note}` : ''}
                </p>
              </div>
              <button type="button" aria-label={`编辑 ${term.term}`} onClick={() => startEdit(term)} className="p-1 text-ink-subtle hover:text-accent"><Edit3Icon size={13} /></button>
              <button type="button" aria-label={`删除 ${term.term}`} onClick={() => remove(term)} className="p-1 text-ink-subtle hover:text-danger"><Trash2Icon size={13} /></button>
            </div>
          ))}
          {!loading && items.length === 0 ? (
            <div className="rounded-md border border-dashed border-line px-3 py-5 text-center">
              <p className="text-[11px] text-ink-muted">暂无术语。可添加示例：deadlock → 死锁（计算机）。</p>
              <button type="button" onClick={() => { setDraft({ ...emptyDraft('computing'), term: 'deadlock', translation: '死锁' }); setEditing(true); }} className="mt-1 text-[11px] text-accent hover:underline">
                使用示例填写
              </button>
            </div>
          ) : null}
        </div>

        {total > PAGE_SIZE ? (
          <div className="mt-3 flex items-center justify-center gap-2 text-[10px] text-ink-subtle">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</Button>
            <span>{page + 1} / {pages}</span>
            <Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
          </div>
        ) : null}

        {report?.errorCount ? (
          <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[10px] text-danger">
            <p>有 {report.errorCount} 条未导入：</p>
            <ul className="mt-1 list-disc pl-4">{report.errors.slice(0, 5).map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>
          </div>
        ) : null}
      </SettingsSection>

      {status ? (
        <p className={classNames(
          'rounded-md border px-3 py-2 text-[11px]',
          status.type === 'ok' ? 'border-line bg-accent-soft text-accent' : 'border-danger/30 bg-danger/5 text-danger',
        )}>
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
