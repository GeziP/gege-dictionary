import React from 'react';
import { Link } from 'react-router-dom';
import { BookOpenIcon, UploadIcon } from 'lucide-react';
import type { AppSettings } from '../../types/lexnote';
import { Button } from '../ui/Button';

interface LibraryEmptyProps {
  settings: Pick<AppSettings, 'clipboardWatch' | 'clipboardMode'>;
  onImport: () => void;
}

/** What a library with nothing in it says: how words get here, and the other way in (a word list). */
export function LibraryEmpty({ settings, onImport }: LibraryEmptyProps) {
  const copy = settings.clipboardMode === 'double' ? '连按两次 Ctrl+C' : '按 Ctrl+C 复制';

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <span className="rounded-full bg-accent-soft p-4 text-accent">
        <BookOpenIcon size={28} aria-hidden="true" />
      </span>
      <div>
        <h2 className="text-base font-semibold text-ink">生词库还是空的</h2>
        <p className="mt-1 text-xs text-ink-muted">查过并收藏的词、句子和段落都会放在这里。</p>
      </div>

      {settings.clipboardWatch ? (
        <ol className="space-y-1.5 text-left text-xs text-ink-muted">
          <li>1. 在浏览器、PDF、Word 等任意应用里选中一段英文</li>
          <li>2. {copy}，查词窗口会自动弹出</li>
          <li>3. 点「加入生词库」，它就会出现在这里</li>
        </ol>
      ) : (
        <p className="max-w-sm text-xs text-ink-muted">
          「划词即查」现在是关闭的。可以到{' '}
          <Link to="/settings" className="text-accent underline-offset-2 hover:underline">
            设置
          </Link>{' '}
          里打开它，或点系统托盘图标手动查词。
        </p>
      )}

      <Button variant="primary" icon={<UploadIcon size={13} aria-hidden="true" />} onClick={onImport}>
        导入已有词表
      </Button>
    </div>
  );
}
