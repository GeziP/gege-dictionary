import React from 'react';
import { DownloadIcon, LayoutGridIcon, RowsIcon, SearchIcon, UploadIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextInput } from '../ui/TextInput';

interface LibraryToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  filteredCount: number;
  totalCount: number;
  density: 'table' | 'cards';
  onDensityChange: (density: 'table' | 'cards') => void;
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
  onImport,
  onExport,
  importing = false,
  exporting = false,
}: LibraryToolbarProps) {
  return (
    <div className="flex h-toolbar shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      {/* The box takes the room that is left, so that the buttons keep their shape in a narrow window. */}
      <TextInput
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索词形、释义、例句…"
        aria-label="搜索生词"
        leading={<SearchIcon size={14} aria-hidden="true" />}
        type="search"
        wrapperClassName="min-w-[8rem] max-w-[18rem] flex-1"
      />

      <p className="shrink-0 whitespace-nowrap text-2xs text-ink-subtle" aria-live="polite">
        {filteredCount === totalCount ? `${totalCount} 条` : `${filteredCount} / ${totalCount} 条`}
      </p>

      <div className="ml-auto flex shrink-0 items-center gap-2">
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
