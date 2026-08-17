import React, { useMemo, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import type { SavedWord } from '../../types/lexnote';
import { FIELD_LABELS, download, toAnkiTSV, toCSV, toMarkdown, type ExportField } from '../../utils/export';
import { classNames } from '../../utils/format';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

const FORMATS = [
{ value: 'csv', label: 'CSV', hint: '通用表格，Excel / Numbers 可直接打开' },
{ value: 'markdown', label: 'Markdown', hint: 'Obsidian、Logseq 笔记库' },
{ value: 'anki', label: 'Anki TSV', hint: '导入为牌组，可映射正反面' }] as
const;

const ALL_FIELDS: ExportField[] = [
'lemma',
'ipaUS',
'pos',
'translation',
'contextMeaning',
'examples',
'context',
'tags',
'source',
'savedAt'];


interface ExportDialogProps {
  words: SavedWord[];
  onClose: () => void;
  onExported: (message: string) => void;
}

export function ExportDialog({ words, onClose, onExported }: ExportDialogProps) {
  const [format, setFormat] = useState<(typeof FORMATS)[number]['value']>('csv');
  const [fields, setFields] = useState<ExportField[]>([
  'lemma',
  'ipaUS',
  'translation',
  'contextMeaning',
  'examples',
  'context',
  'tags']
  );
  const [front, setFront] = useState<ExportField>('lemma');

  const content = useMemo(() => {
    if (format === 'csv') return toCSV(words, fields);
    if (format === 'markdown') return toMarkdown(words, fields);
    return toAnkiTSV(words, front, fields.filter((field) => field !== front));
  }, [format, fields, front, words]);

  const preview = content.split('\n').slice(0, 8).join('\n');

  const run = async () => {
    const meta = {
      csv: { name: 'gege-export.csv', ext: ['csv'], filter: 'CSV 文件' },
      markdown: { name: 'gege-export.md', ext: ['md'], filter: 'Markdown 文件' },
      anki: { name: 'gege-anki.tsv', ext: ['tsv'], filter: 'Anki TSV 文件' },
    }[format];
    try {
      const { saveFileDialog } = await import('../../lib/tauri-bridge');
      const path = await saveFileDialog(meta.name, content, meta.filter, meta.ext);
      if (path) {
        onExported(`已导出 ${words.length} 条到 ${path}`);
        onClose();
      }
    } catch {
      download(meta.name, content, 'text/plain');
      onExported(`已导出 ${words.length} 条为 ${meta.name}`);
      onClose();
    }
  };

  return (
    <Modal
      title="导出生词"
      description={`当前筛选结果共 ${words.length} 条`}
      onClose={onClose}
      width={600}
      footer={
      <>
          <Button variant="primary" icon={<DownloadIcon size={13} />} onClick={run} disabled={words.length === 0}>
            导出 {words.length} 条
          </Button>
          <Button onClick={onClose}>取消</Button>
          <span className="ml-auto text-[11px] text-ink-subtle">选择保存位置后导出</span>
        </>
      }>
      
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-1.5 text-[11px] font-medium text-ink-muted">格式</legend>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((option) =>
            <button
              key={option.value}
              type="button"
              onClick={() => setFormat(option.value)}
              className={classNames(
                'rounded-lg border p-2.5 text-left transition-colors',
                format === option.value ?
                'border-accent bg-accent-soft' :
                'border-line hover:border-line-strong'
              )}>
              
                <span className={classNames('block text-xs font-medium', format === option.value ? 'text-accent' : 'text-ink')}>
                  {option.label}
                </span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-subtle">{option.hint}</span>
              </button>
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-[11px] font-medium text-ink-muted">导出字段</legend>
          <div className="flex flex-wrap gap-1.5">
            {ALL_FIELDS.map((field) => {
              const active = fields.includes(field);
              return (
                <button
                  key={field}
                  type="button"
                  onClick={() =>
                  setFields((prev) => active ? prev.filter((f) => f !== field) : [...prev, field])
                  }
                  className={classNames(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:border-line-strong'
                  )}>
                  
                  {FIELD_LABELS[field]}
                </button>);

            })}
          </div>
        </fieldset>

        {format === 'anki' ?
        <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-muted">卡片正面</span>
            <Select
            className="w-40"
            value={front}
            onChange={(event) => setFront(event.target.value as ExportField)}
            options={ALL_FIELDS.map((field) => ({ value: field, label: FIELD_LABELS[field] }))} />
          
            <span className="text-[11px] text-ink-subtle">背面为其余已勾选字段，标签写入 Anki tags 列</span>
          </div> :
        null}

        <div>
          <p className="mb-1.5 text-[11px] font-medium text-ink-muted">预览</p>
          <pre className="thin-scroll max-h-40 overflow-auto rounded-md border border-line bg-raised p-2.5 font-mono text-[10px] leading-relaxed text-ink-muted">
            {preview || '（没有可导出的内容）'}
          </pre>
        </div>
      </div>
    </Modal>);

}
