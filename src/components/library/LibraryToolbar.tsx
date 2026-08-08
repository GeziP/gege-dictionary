import React from 'react';
import {
  DownloadIcon,
  LayoutGridIcon,
  MinusIcon,
  PlusIcon,
  RowsIcon,
  SearchIcon,
  TypeIcon,
  UploadIcon,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextInput } from '../ui/TextInput';

export const READER_MIN = 10;
export const READER_MAX = 22;

interface LibraryToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  filteredCount: number;
  totalCount: number;
  density: 'table' | 'cards';
  onDensityChange: (density: 'table' | 'cards') => void;
  readerSize: number;
  onReaderSizeChange: (size: number) => void;
  onImport: () => void;
  onExport: () => void;
  importing?: boolean;
  exporting?: boolean;
}

export function LibraryToolbar({
  query,
  onQueryChange,
  filteredCount,
  totalCount,
  density,
  onDensityChange,
  readerSize,
  onReaderSizeChange,
  onImport,
  onExport,
  importing = false,
  exporting = false,
}: LibraryToolbarProps) {
  return (
    <div className="flex h-toolbar shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <TextInput
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索词形、释义、例句…"
        leading={<SearchIcon size={14} aria-hidden="true" />}
        type="search"
        className="w-64"
      />

      <p className="text-2xs text-ink-subtle" aria-live="polite">
        {filteredCount === totalCount ? `${totalCount} 条` : `${filteredCount} / ${totalCount} 条`}
      </p>

      <div className="ml-auto flex items-center gap-2">
        <SegmentedControl
          label="列表视图"
          iconOnly
          options={[
            { value: 'table' as const, label: '表格视图', icon: <RowsIcon size={14} aria-hidden="true" /> },
            { value: 'cards' as const, label: '卡片视图', icon: <LayoutGridIcon size={14} aria-hidden="true" /> },
          ]}
          value={density}
          onChange={onDensityChange}
        />

        <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
          <TypeIcon size={13} className="ml-1 mr-0.5 text-ink-subtle" aria-hidden="true" />
          <IconButton
            label="减小阅读字号"
            icon={<MinusIcon size={13} aria-hidden="true" />}
            disabled={readerSize <= READER_MIN}
            onClick={() => onReaderSizeChange(Math.max(READER_MIN, readerSize - 1))}
            className="disabled:opacity-40"
          />
          <output
            aria-label="当前阅读字号"
            className="min-w-[2rem] text-center text-2xs tabular-nums text-ink-muted"
          >
            {readerSize}
          </output>
          <IconButton
            label="增大阅读字号"
            icon={<PlusIcon size={13} aria-hidden="true" />}
            disabled={readerSize >= READER_MAX}
            onClick={() => onReaderSizeChange(Math.min(READER_MAX, readerSize + 1))}
            className="disabled:opacity-40"
          />
        </div>

        <Button
          size="sm"
          icon={<UploadIcon size={13} aria-hidden="true" />}
          loading={importing}
          onClick={onImport}
        >
          导入
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<DownloadIcon size={13} aria-hidden="true" />}
          loading={exporting}
          onClick={onExport}
        >
          导出
        </Button>
      </div>
    </div>
  );
}
