import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportDialog } from './ImportDialog';
import * as bridge from '../../lib/tauri-bridge';

vi.mock('../../lib/tauri-bridge', () => ({
  previewWordImport: vi.fn(),
  importWords: vi.fn(),
}));

const preview = (columns: string[], rows: string[][] = [], extra: Partial<bridge.WordImportPreview> = {}) => ({
  columns,
  rows,
  totalRows: rows.length,
  errors: [],
  format: 'csv',
  ...extra,
});

const chooseFile = (name = 'words.csv', content = 'lemma,translation\nApple,苹果\n') =>
  userEvent.upload(screen.getByLabelText(/CSV/i), new File([content], name, { type: 'text/csv' }));

const field = (label: string) => screen.getByLabelText(label);
const startButton = () => screen.getByRole('button', { name: /开始导入/i });

describe('ImportDialog', () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it('previews real columns and rows before importing', async () => {
    const previewImport = vi.mocked(bridge.previewWordImport);
    const importWords = vi.mocked(bridge.importWords);
    previewImport.mockResolvedValue({
      columns: ['lemma', 'translation'],
      rows: [['Apple', '苹果']],
      totalRows: 1,
      errors: [],
      format: 'csv',
    });
    importWords.mockResolvedValue({ inserted: 1, merged: 0, skipped: 0, errors: [] });
    const onImported = vi.fn();
    render(<ImportDialog onClose={vi.fn()} onImported={onImported} />);

    const file = new File(['lemma,translation\nApple,苹果\n'], 'words.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText(/CSV/i), file);
    await waitFor(() => expect(previewImport).toHaveBeenCalledWith(expect.stringContaining('Apple'), 'csv'));
    expect(await screen.findByText('Apple')).toBeInTheDocument();
    expect(screen.getByText(/总行数/)).toHaveTextContent('1');

    await userEvent.click(screen.getByRole('button', { name: /开始导入/i }));
    await waitFor(() => expect(importWords).toHaveBeenCalled());
    expect(onImported).toHaveBeenCalledWith(expect.stringContaining('新增 1'));
  });

  it('matches the columns with the fields by the names the file gives them', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(
      preview(['Word', 'Meaning', 'Part of Speech', 'Tags'], [['apple', '苹果', 'n.', 'fruit']]),
    );
    vi.mocked(bridge.importWords).mockResolvedValue({ inserted: 1, merged: 0, skipped: 0, errors: [] });
    render(<ImportDialog onClose={vi.fn()} onImported={vi.fn()} />);

    await chooseFile();
    await screen.findByText('apple');

    expect(field('单词（必需）')).toHaveValue('Word');
    expect(field('翻译')).toHaveValue('Meaning');
    expect(field('词性')).toHaveValue('Part of Speech');
    expect(field('标签')).toHaveValue('Tags');
    // Nothing in the file is called a note: that is left to be skipped.
    expect(field('备注')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.click(startButton());
    await waitFor(() => expect(bridge.importWords).toHaveBeenCalledTimes(1));
    expect(bridge.importWords).toHaveBeenCalledWith(expect.any(String), 'csv', {
      lemma: 'Word',
      translation: 'Meaning',
      pos: 'Part of Speech',
      tags: 'Tags',
    });
  });

  it('does not offer to import until it is known which column holds the word, and then does', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(preview(['a', 'b'], [['apple', '苹果']]));
    render(<ImportDialog onClose={vi.fn()} onImported={vi.fn()} />);

    await chooseFile();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('还没有选出哪一列是「单词」');
    expect(startButton()).toBeDisabled();

    await userEvent.selectOptions(field('单词（必需）'), 'a');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(startButton()).toBeEnabled();
  });

  it('names the number of rows that are not shown when the file is longer than the preview', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(
      preview(['word'], [['apple'], ['pear']], { totalRows: 250 }),
    );
    render(<ImportDialog onClose={vi.fn()} onImported={vi.fn()} />);

    await chooseFile();

    expect(await screen.findByText(/总行数/)).toHaveTextContent('250（下面是前 2 行）');
  });

  it('says what is wrong with the rows of a preview, one by one', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(
      preview(['word'], [['apple']], { errors: [{ row: 3, message: '列数不对' }] }),
    );
    render(<ImportDialog onClose={vi.fn()} onImported={vi.fn()} />);

    await chooseFile();

    expect(await screen.findByText('第 3 行：列数不对')).toBeInTheDocument();
  });

  it('says why a file cannot be previewed, and offers no import', async () => {
    vi.mocked(bridge.previewWordImport).mockRejectedValue('CSV 格式不正确：引号没有闭合');
    render(<ImportDialog onClose={vi.fn()} onImported={vi.fn()} />);

    await chooseFile();

    expect(await screen.findByRole('alert')).toHaveTextContent('CSV 格式不正确：引号没有闭合');
    expect(startButton()).toBeDisabled();
    expect(screen.queryByText('每一列对应什么')).not.toBeInTheDocument();
  });

  it('treats a .tsv file as tab-separated', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(preview(['word'], [['apple']], { format: 'tsv' }));
    render(<ImportDialog onClose={vi.fn()} onImported={vi.fn()} />);

    await chooseFile('words.tsv', 'word\napple\n');

    await waitFor(() => expect(bridge.previewWordImport).toHaveBeenCalledWith(expect.any(String), 'tsv'));
  });

  it('stays open and says why when the import fails, so that it can be tried again', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(preview(['word'], [['apple']]));
    vi.mocked(bridge.importWords).mockRejectedValueOnce('database is locked');
    const onImported = vi.fn();
    const onClose = vi.fn();
    render(<ImportDialog onClose={onClose} onImported={onImported} />);
    await chooseFile();
    await screen.findByText('apple');

    await userEvent.click(startButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
    expect(onImported).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(startButton()).toBeEnabled();

    vi.mocked(bridge.importWords).mockResolvedValue({ inserted: 1, merged: 0, skipped: 0, errors: [] });
    await userEvent.click(startButton());

    await waitFor(() => expect(onImported).toHaveBeenCalledWith('新增 1 条，合并 0 条，跳过 0 条'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('counts the rows that were skipped because of their format in what it reports', async () => {
    vi.mocked(bridge.previewWordImport).mockResolvedValue(preview(['word'], [['apple']]));
    vi.mocked(bridge.importWords).mockResolvedValue({
      inserted: 2,
      merged: 1,
      skipped: 0,
      errors: [{ row: 3, message: '缺少单词' }],
    });
    const onImported = vi.fn();
    render(<ImportDialog onClose={vi.fn()} onImported={onImported} />);
    await chooseFile();
    await screen.findByText('apple');

    await userEvent.click(startButton());

    await waitFor(() => expect(onImported).toHaveBeenCalledWith('新增 2 条，合并 1 条，跳过 0 条，1 行格式错误已跳过'));
  });

  it('can be reached with the keyboard, and closes without importing anything', async () => {
    const onClose = vi.fn();
    render(<ImportDialog onClose={onClose} onImported={vi.fn()} />);
    const dialog = screen.getByRole('dialog');

    // The file box is a real control that a keyboard can focus: it is clipped away, not hidden
    // with `display: none`, which nothing can reach.
    const input = within(dialog).getByLabelText(/CSV/i);
    expect(input).toHaveClass('sr-only');
    expect(input).not.toHaveClass('hidden');

    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bridge.importWords).not.toHaveBeenCalled();
  });
});
