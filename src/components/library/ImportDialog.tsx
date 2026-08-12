import React, { useMemo, useState } from 'react';
import { FileUpIcon, UploadIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import * as bridge from '../../lib/tauri-bridge';

const TARGETS = [
  { value: 'lemma', label: 'lemma（必需）' },
  { value: 'translation', label: '翻译' },
  { value: 'pos', label: '词性' },
  { value: 'contextMeaning', label: '上下文释义' },
  { value: 'explanation', label: '用法说明' },
  { value: 'note', label: '备注' },
  { value: 'tags', label: '标签' },
];

interface ImportDialogProps {
  onClose: () => void;
  onImported: (message: string) => void;
}

export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [format, setFormat] = useState('csv');
  const [preview, setPreview] = useState<bridge.WordImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const columns = useMemo(() => preview?.columns ?? [], [preview]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const nextFormat = file.name.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv';
      const nextContent = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('无法读取文件'));
        reader.readAsText(file);
      });
      const nextPreview = await bridge.previewWordImport(nextContent, nextFormat);
      const nextMapping: Record<string, string> = {};
      for (const target of TARGETS) {
        const matching = nextPreview.columns.find((column) =>
          target.value === 'lemma'
            ? column.toLowerCase() === 'lemma'
            : column.toLowerCase() === target.value.toLowerCase()
        );
        if (matching) nextMapping[target.value] = matching;
      }
      setFileName(file.name);
      setContent(nextContent);
      setFormat(nextFormat);
      setPreview(nextPreview);
      setMapping(nextMapping);
    } catch (reason) {
      setError(String(reason));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!preview || !mapping.lemma) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.importWords(content, format, mapping);
      const errorSuffix = result.errors.length > 0 ? `，${result.errors.length} 行格式错误已跳过` : '';
      onImported(`新增 ${result.inserted} 条，合并 ${result.merged} 条，跳过 ${result.skipped} 条${errorSuffix}`);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="导入词表"
      description="支持 CSV / TSV、UTF-8 BOM、引号和换行；确认真实预览后才会写入数据库"
      onClose={onClose}
      width={720}
      footer={(
        <>
          <Button
            variant="primary"
            icon={<UploadIcon size={13} />}
            disabled={busy || !preview || !mapping.lemma}
            onClick={handleImport}
          >
            {busy ? '处理中…' : '开始导入'}
          </Button>
          <Button onClick={onClose}>取消</Button>
        </>
      )}
    >
      <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-raised px-4 py-6 text-center">
        <FileUpIcon size={18} className="text-ink-subtle" />
        <span className="text-xs text-ink">{fileName ?? '选择或拖入 CSV / TSV 文件'}</span>
        <span className="text-[11px] text-ink-subtle">文件只会先读取到本地预览，不会自动提交</span>
        <input
          aria-label="选择 CSV/TSV 文件"
          type="file"
          accept=".csv,.tsv,.txt"
          className="hidden"
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
      </label>

      {preview && (
        <>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[11px] font-medium text-ink-muted">字段映射</p>
            <span className="text-[11px] text-ink-subtle">总行数：{preview.totalRows}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {TARGETS.map((target) => (
              <label key={target.value} className="flex items-center gap-2 text-[11px] text-ink-muted">
                <span className="w-28 shrink-0">{target.label}</span>
                <Select
                  className="min-w-0 flex-1"
                  value={mapping[target.value] ?? ''}
                  onChange={(event) => setMapping((current) => ({ ...current, [target.value]: event.target.value }))}
                  options={[
                    { value: '', label: '跳过' },
                    ...columns.map((column) => ({ value: column, label: column })),
                  ]}
                />
              </label>
            ))}
          </div>
          {!mapping.lemma && <p className="mt-2 text-[11px] text-danger">必须映射 lemma 列才能提交。</p>}

          <div className="mt-4 overflow-auto rounded-md border border-line">
            <table className="min-w-full text-left text-[11px]">
              <thead className="bg-raised text-ink-muted">
                <tr>{columns.map((column) => <th key={column} className="px-2 py-1.5 font-medium">{column}</th>)}</tr>
              </thead>
              <tbody>
                {preview.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-line">
                    {columns.map((column, columnIndex) => <td key={column} className="max-w-52 whitespace-pre-wrap px-2 py-1.5 text-ink">{row[columnIndex] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.errors.length > 0 && (
            <div className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2 text-[11px] text-danger">
              <p className="font-medium">逐行错误（提交时会跳过）</p>
              <ul className="mt-1 max-h-24 list-disc overflow-auto pl-4">
                {preview.errors.map((item) => <li key={`${item.row}-${item.message}`}>第 {item.row} 行：{item.message}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
      {error && <p className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2 text-[11px] text-danger">{error}</p>}
    </Modal>
  );
}
