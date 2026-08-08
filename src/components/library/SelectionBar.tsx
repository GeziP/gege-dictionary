import React from 'react';
import { motion } from 'framer-motion';
import { DownloadIcon, TagIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';

interface SelectionBarProps {
  count: number;
  batchTag: string;
  onBatchTagChange: (value: string) => void;
  onApplyTag: () => void;
  onExport: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({
  count,
  batchTag,
  onBatchTagChange,
  onApplyTag,
  onExport,
  onDelete,
  onClear,
}: SelectionBarProps) {
  return (
    <motion.div
      initial={{ y: 48 }}
      animate={{ y: 0 }}
      exit={{ y: 48 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className="flex h-toolbar shrink-0 items-center gap-2 border-t border-line bg-raised px-3"
    >
      <p className="text-xs font-medium text-ink">已选 {count} 条</p>

      <form
        className="flex items-center"
        onSubmit={(event) => {
          event.preventDefault();
          onApplyTag();
        }}
      >
        <TextInput
          value={batchTag}
          onChange={(event) => onBatchTagChange(event.target.value)}
          placeholder="输入标签后回车"
          leading={<TagIcon size={13} aria-hidden="true" />}
          className="w-44"
        />
      </form>

      <Button size="sm" icon={<DownloadIcon size={13} aria-hidden="true" />} onClick={onExport}>
        导出所选
      </Button>
      <Button size="sm" variant="danger" icon={<Trash2Icon size={13} aria-hidden="true" />} onClick={onDelete}>
        删除
      </Button>

      <Button size="sm" variant="ghost" className="ml-auto" icon={<XIcon size={13} aria-hidden="true" />} onClick={onClear}>
        取消选择
      </Button>
    </motion.div>
  );
}
