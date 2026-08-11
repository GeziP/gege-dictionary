import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImportDialog } from './ImportDialog';
import * as bridge from '../../lib/tauri-bridge';

vi.mock('../../lib/tauri-bridge', () => ({
  previewWordImport: vi.fn(),
  importWords: vi.fn(),
}));

describe('ImportDialog', () => {
  it('previews real columns and rows before importing', async () => {
    const preview = vi.mocked(bridge.previewWordImport);
    const importWords = vi.mocked(bridge.importWords);
    preview.mockResolvedValue({
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
    await waitFor(() => expect(preview).toHaveBeenCalledWith(expect.stringContaining('Apple'), 'csv'));
    expect(await screen.findByText('Apple')).toBeInTheDocument();
    expect(screen.getByText(/总行数/)).toHaveTextContent('1');

    await userEvent.click(screen.getByRole('button', { name: /开始导入/i }));
    await waitFor(() => expect(importWords).toHaveBeenCalled());
    expect(onImported).toHaveBeenCalledWith(expect.stringContaining('新增 1'));
  });
});
