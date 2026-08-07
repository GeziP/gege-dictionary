import React, { useState } from 'react';
import { FileUpIcon, UploadIcon } from 'lucide-react';
import { FIELD_LABELS, type ExportField } from '../../utils/export';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

const SAMPLE_COLUMNS = ['Word', 'Reading', 'Meaning', 'Sentence', 'Deck'];
const TARGETS: (ExportField | 'skip')[] = [
'lemma',
'ipaUS',
'translation',
'contextMeaning',
'examples',
'context',
'tags',
'skip'];


interface ImportDialogProps {
  onClose: () => void;
  onImported: (message: string) => void;
}

export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({
    Word: 'lemma',
    Reading: 'ipaUS',
    Meaning: 'translation',
    Sentence: 'examples',
    Deck: 'tags'
  });

  return (
    <Modal
      title="导入词表"
      description="支持 CSV / TSV，字段映射可自由调整"
      onClose={onClose}
      width={520}
      footer={
      <>
          <Button
          variant="primary"
          icon={<UploadIcon size={13} />}
          disabled={!fileName}
          onClick={() => {
            onImported(`已从 ${fileName} 导入 128 条，其中 6 条与现有生词合并`);
            onClose();
          }}>
          
            开始导入
          </Button>
          <Button onClick={onClose}>取消</Button>
        </>
      }>
      
      <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-raised px-4 py-6 text-center">
        <FileUpIcon size={18} className="text-ink-subtle" />
        <span className="text-xs text-ink">{fileName ?? '选择或拖入 CSV 文件'}</span>
        <span className="text-[11px] text-ink-subtle">首行将被识别为列名</span>
        <input
          type="file"
          accept=".csv,.tsv,.txt"
          className="hidden"
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)} />
        
      </label>

      <div className="mt-4">
        <p className="mb-1.5 text-[11px] font-medium text-ink-muted">字段映射</p>
        <ul className="space-y-1.5">
          {SAMPLE_COLUMNS.map((column) =>
          <li key={column} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-ink">{column}</span>
              <span className="text-[11px] text-ink-subtle">→</span>
              <Select
              className="flex-1"
              value={mapping[column]}
              onChange={(event) => setMapping((prev) => ({ ...prev, [column]: event.target.value }))}
              options={TARGETS.map((target) => ({
                value: target,
                label: target === 'skip' ? '不导入' : FIELD_LABELS[target]
              }))} />
            
            </li>
          )}
        </ul>
      </div>
    </Modal>);

}