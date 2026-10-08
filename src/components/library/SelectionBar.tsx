import React from 'react';
import { motion } from 'framer-motion';
import { BookMarkedIcon, DownloadIcon, GraduationCapIcon, SparklesIcon, TagIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { MASTERY_META } from '../ui/MasteryBadge';
import type { Mastery } from '../../types/lexnote';

interface SelectionBarProps {
  count: number;
  batchTag: string;
  ankiEnabled?: boolean;
  ankiBusy?: boolean;
  /** How many of the selected words have nothing but a meaning and could be filled in. */
  enrichableCount?: number;
  /** Why they cannot be filled in right now (a run is going on), if that is so. */
  enrichBlocked?: string;
  onBatchTagChange: (value: string) => void;
  onApplyTag: () => void;
  onExport: () => void;
  onSendAnki?: () => void;
  onEnrich?: () => void;
  onSetMastery?: (mastery: Mastery) => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({
  count,
  batchTag,
  ankiEnabled = false,
  ankiBusy = false,
  enrichableCount = 0,
  enrichBlocked,
  onBatchTagChange,
  onApplyTag,
  onExport,
  onSendAnki,
  onEnrich,
  onSetMastery,
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
      {onSetMastery && (
        <div className="relative flex items-center">
          <GraduationCapIcon size={13} className="mr-1 text-ink-subtle" aria-hidden="true" />
          <select
            aria-label="批量设置掌握度"
            className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-ink outline-none hover:border-line-strong focus:border-accent"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                onSetMastery(e.target.value as Mastery);
                e.target.value = '';
              }
            }}
          >
            <option value="" disabled>掌握度</option>
            {(Object.keys(MASTERY_META) as Mastery[]).map((m) => (
              <option key={m} value={m}>{MASTERY_META[m].label}</option>
            ))}
          </select>
        </div>
      )}
      {onEnrich && enrichableCount > 0 ? (
        <Button
          size="sm"
          icon={<SparklesIcon size={13} aria-hidden="true" />}
          onClick={onEnrich}
          disabled={Boolean(enrichBlocked)}
          title={enrichBlocked ?? '让主模型补全所选词里只有释义的那些，只填空缺的部分'}
        >
          补全所选（{enrichableCount}）
        </Button>
      ) : null}
      {ankiEnabled && onSendAnki ? (
        <Button
          size="sm"
          icon={<BookMarkedIcon size={13} aria-hidden="true" />}
          onClick={onSendAnki}
          disabled={ankiBusy}
        >
          {ankiBusy ? '发送中…' : '发送到 Anki'}
        </Button>
      ) : null}
      <Button size="sm" variant="danger" icon={<Trash2Icon size={13} aria-hidden="true" />} onClick={onDelete}>
        删除
      </Button>

      <Button size="sm" variant="ghost" className="ml-auto" icon={<XIcon size={13} aria-hidden="true" />} onClick={onClear}>
        取消选择
      </Button>
    </motion.div>
  );
}
