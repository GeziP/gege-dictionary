import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryToolbar } from './LibraryToolbar';

function renderToolbar(overrides: Partial<Parameters<typeof LibraryToolbar>[0]> = {}) {
  const props = {
    query: '',
    onQueryChange: vi.fn(),
    filteredCount: 12,
    totalCount: 12,
    density: 'table' as const,
    onDensityChange: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<LibraryToolbar {...props} />) };
}

afterEach(() => {
  cleanup();
});

describe('the toolbar of the library', () => {
  describe('the search box', () => {
    it('has a name that says what it searches, not only a hint that goes away when typing', () => {
      renderToolbar();

      expect(screen.getByRole('searchbox', { name: '搜索生词' })).toHaveAttribute('placeholder', '搜索词形、释义、例句…');
    });

    it('shows what is searched for, and reports every change of it', async () => {
      const { props } = renderToolbar({ query: 'ub' });
      const box = screen.getByRole('searchbox', { name: '搜索生词' });
      expect(box).toHaveValue('ub');

      await userEvent.type(box, 'i');

      expect(props.onQueryChange).toHaveBeenLastCalledWith('ubi');
    });
  });

  describe('the count', () => {
    it('is the number of words when all are shown', () => {
      renderToolbar({ filteredCount: 12, totalCount: 12 });

      expect(screen.getByText('12 条')).toBeInTheDocument();
    });

    it('is how many of all are shown when a filter is on', () => {
      renderToolbar({ filteredCount: 3, totalCount: 12 });

      expect(screen.getByText('3 / 12 条')).toBeInTheDocument();
    });

    it('is read out when it changes, without taking the focus', () => {
      renderToolbar();

      expect(screen.getByText('12 条')).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('the way the words are listed', () => {
    it('offers the table and the cards, by name, and shows which is in use', () => {
      renderToolbar({ density: 'cards' });

      expect(screen.getByRole('radiogroup', { name: '列表视图' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: '卡片视图' })).toBeChecked();
      expect(screen.getByRole('radio', { name: '表格视图' })).not.toBeChecked();
    });

    it('changes to the one that is chosen', async () => {
      const { props } = renderToolbar({ density: 'table' });

      await userEvent.click(screen.getByRole('radio', { name: '卡片视图' }));

      expect(props.onDensityChange).toHaveBeenCalledWith('cards');
    });
  });

  describe('importing and exporting', () => {
    it('start when their buttons are pressed', async () => {
      const { props } = renderToolbar();

      await userEvent.click(screen.getByRole('button', { name: '导入' }));
      await userEvent.click(screen.getByRole('button', { name: '导出' }));

      expect(props.onImport).toHaveBeenCalledTimes(1);
      expect(props.onExport).toHaveBeenCalledTimes(1);
    });

    it('cannot be started again while they are going on, which the button says', () => {
      renderToolbar({ importing: true, exporting: true });

      for (const name of ['导入', '导出']) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-busy', 'true');
      }
    });

    it('are available when nothing is going on', () => {
      renderToolbar();

      expect(screen.getByRole('button', { name: '导入' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '导出' })).toBeEnabled();
    });
  });
});
