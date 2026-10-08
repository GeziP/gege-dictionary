import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowWindow } from '../../lib/row-window';
import type { SavedWord } from '../../types/lexnote';
import { WINDOW_FROM, WordTable } from './WordTable';

// The real thing, but one that can be asked how often it was called.
vi.mock('../../lib/row-window', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/row-window')>();
  return { ...actual, rowWindow: vi.fn(actual.rowWindow) };
});

/** The height that a row is assumed to have until a drawn one has been measured. */
const ROW = 41;
/** Ten rows fit on the screen of these tests. */
const VIEWPORT = 410;
/** How many rows are drawn beyond the visible ones, on each side. */
const MARGIN = 12;

const word = (index: number): SavedWord => {
  const lemma = `word-${String(index).padStart(4, '0')}`;
  return {
    id: lemma,
    lemma,
    pos: 'n.',
    translation: `${lemma}的释义`,
    tags: [],
    sourceApp: 'Chrome',
    savedAt: '2026-10-05T08:00:00Z',
    lookups: 1,
    mastery: 'new',
  } as unknown as SavedWord;
};
const words = (count: number) => Array.from({ length: count }, (_, index) => word(index));

type TableProps = React.ComponentProps<typeof WordTable>;

const tableProps = (list: SavedWord[], overrides: Partial<TableProps> = {}) => ({
  words: list,
  density: 'table' as const,
  selectedIds: new Set<string>(),
  allSelected: false,
  activeId: null,
  onToggleSelect: vi.fn(),
  onToggleAll: vi.fn(),
  onActivate: vi.fn(),
  ...overrides,
});

function renderTable(list: SavedWord[], overrides: Partial<TableProps> = {}) {
  const props = tableProps(list, overrides);
  return { props, ...render(<WordTable {...props} />) };
}

const scroller = () => screen.getByRole('table').parentElement as HTMLElement;
const drawnRows = () => Array.from(document.querySelectorAll<HTMLElement>('tr[data-row]'));
const lemmas = () => drawnRows().map((row) => row.querySelector('span.font-serif')?.textContent);
const spacers = () => Array.from(document.querySelectorAll<HTMLElement>('tr[data-spacer]'));

// jsdom does not lay anything out. These give the list a screen and, when asked, its rows a height.
const replaced = new Map<string, PropertyDescriptor | undefined>();
function stub(name: 'clientHeight' | 'offsetTop', get: (this: HTMLElement) => number) {
  if (!replaced.has(name)) replaced.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
}
function putBackWhatJsdomHad() {
  for (const [name, original] of replaced) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  replaced.clear();
}

describe('the table of saved words', () => {
  beforeEach(() => stub('clientHeight', () => VIEWPORT));

  afterEach(() => {
    cleanup();
    putBackWhatJsdomHad();
  });

  it('draws every row of a library that is not long, with nothing standing in for rows', () => {
    renderTable(words(50));

    expect(drawnRows()).toHaveLength(50);
    expect(spacers()).toHaveLength(0);
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-rowcount');
  });

  it('draws every row up to the length where it starts to draw only some', () => {
    renderTable(words(WINDOW_FROM));

    expect(drawnRows()).toHaveLength(WINDOW_FROM);
    expect(spacers()).toHaveLength(0);
  });

  it('draws only some rows from one word beyond that', () => {
    renderTable(words(WINDOW_FROM + 1));

    expect(drawnRows()).toHaveLength(VIEWPORT / ROW + MARGIN);
    expect(spacers()).toHaveLength(1);
  });

  it('draws only the rows on the screen, and a margin, of a library of thousands', () => {
    renderTable(words(5000));

    const drawn = VIEWPORT / ROW + MARGIN;
    expect(drawnRows()).toHaveLength(drawn);
    expect(lemmas()[0]).toBe('word-0000');
    expect(lemmas()).not.toContain('word-0100');
    // Everything that is not drawn is stood in for below, so the scroll bar is that of 5000 rows.
    expect(spacers()).toHaveLength(1);
    expect(spacers()[0].style.height).toBe(`${(5000 - drawn) * ROW}px`);
  });

  it('tells a screen reader how long the list is, and where each drawn row is in it', () => {
    renderTable(words(5000));

    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '5001');
    // The header is the first row.
    expect(drawnRows()[0]).toHaveAttribute('aria-rowindex', '2');
    expect(drawnRows()[4]).toHaveAttribute('aria-rowindex', '6');
    expect(spacers()[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the rows that scrolling brings to the screen, and no longer those it took away', () => {
    renderTable(words(5000));

    fireEvent.scroll(scroller(), { target: { scrollTop: 2000 * ROW } });

    const shown = lemmas();
    const first = 2000 - MARGIN;
    expect(shown).toContain('word-2000');
    expect(shown).not.toContain('word-0000');
    expect(shown[0]).toBe(`word-${first}`);
    expect(drawnRows()[0]).toHaveAttribute('aria-rowindex', String(first + 2));
    // The rows before and after are stood in for, so that together with the drawn ones they make
    // up the whole list.
    expect(spacers()).toHaveLength(2);
    const [above, below] = spacers();
    expect(above.style.height).toBe(`${first * ROW}px`);
    expect(below.style.height).toBe(`${(5000 - first - shown.length) * ROW}px`);
  });

  it('reaches the very last row', () => {
    renderTable(words(5000));

    fireEvent.scroll(scroller(), { target: { scrollTop: 5000 * ROW - VIEWPORT } });

    const shown = lemmas();
    expect(shown[shown.length - 1]).toBe('word-4999');
    // Nothing is left below, so only the rows above are stood in for.
    expect(spacers()).toHaveLength(1);
    expect(spacers()[0].style.height).toBe(`${(5000 - shown.length) * ROW}px`);
  });

  it('does not work out the rows again for a scroll that stays within a row', () => {
    renderTable(words(5000));
    const afterTheFirstDraw = vi.mocked(rowWindow).mock.calls.length;

    fireEvent.scroll(scroller(), { target: { scrollTop: ROW - 3 } });
    expect(vi.mocked(rowWindow)).toHaveBeenCalledTimes(afterTheFirstDraw);

    // One row further, there is something to work out.
    fireEvent.scroll(scroller(), { target: { scrollTop: ROW + 3 } });
    expect(vi.mocked(rowWindow).mock.calls.length).toBeGreaterThan(afterTheFirstDraw);
  });

  it('keeps selecting and opening words working on the rows that are drawn', async () => {
    const { props } = renderTable(words(5000));
    fireEvent.scroll(scroller(), { target: { scrollTop: 3000 * ROW } });

    await userEvent.click(screen.getByRole('checkbox', { name: '选择 word-3000' }));
    expect(props.onToggleSelect).toHaveBeenCalledWith('word-3000');

    await userEvent.click(screen.getByRole('button', { name: /word-3001/ }));
    expect(props.onActivate).toHaveBeenCalledWith('word-3001');

    await userEvent.click(screen.getByRole('checkbox', { name: '全选当前列表' }));
    expect(props.onToggleAll).toHaveBeenCalledTimes(1);
  });

  it('shows which of the drawn words are selected or open, whichever of the others are', () => {
    renderTable(words(5000), {
      selectedIds: new Set(['word-0002', 'word-4000']),
      activeId: 'word-0001',
    });

    expect(screen.getByRole('checkbox', { name: '选择 word-0002' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 word-0003' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '选择 word-4000' })).not.toBeInTheDocument();
    expect(drawnRows()[1]).toHaveClass('bg-accent-soft');
  });

  it('draws all the rows again when the list gets short, and stands in for none', () => {
    const { rerender, props } = renderTable(words(5000));
    fireEvent.scroll(scroller(), { target: { scrollTop: 4000 * ROW } });

    rerender(<WordTable {...props} words={words(30)} />);

    expect(drawnRows()).toHaveLength(30);
    expect(spacers()).toHaveLength(0);
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-rowcount');
  });

  it('still shows the end of a list that got shorter than where it was scrolled to', () => {
    const { rerender, props } = renderTable(words(5000));
    fireEvent.scroll(scroller(), { target: { scrollTop: 4000 * ROW } });

    // The browser has not moved the scroll position yet; there is something to show anyway.
    rerender(<WordTable {...props} words={words(600)} />);

    const shown = lemmas();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[shown.length - 1]).toBe('word-0599');
  });

  it('learns the height that its rows really have', () => {
    stub('offsetTop', function rowIndexTimesFifty(this: HTMLElement) {
      return Number(this.getAttribute('aria-rowindex') ?? 0) * 50;
    });

    renderTable(words(5000));

    const drawn = Math.ceil(VIEWPORT / 50) + MARGIN;
    expect(drawnRows()).toHaveLength(drawn);
    expect(spacers()[0].style.height).toBe(`${(5000 - drawn) * 50}px`);
  });

  it('leaves the cards alone: they are all drawn, and the browser skips those off screen', () => {
    renderTable(words(WINDOW_FROM + 50), { density: 'cards' });

    expect(document.querySelectorAll('button')).toHaveLength(WINDOW_FROM + 50);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says so when there is nothing to show', () => {
    renderTable([]);

    expect(screen.getByText('没有匹配的生词')).toBeInTheDocument();
  });

  it('offers to put the search and the filters away when they leave nothing, if it is given the way to', async () => {
    const onClearFilters = vi.fn();
    renderTable([], { onClearFilters });

    await userEvent.click(screen.getByRole('button', { name: '清除搜索和筛选' }));

    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to put away where there is nothing that could be', () => {
    renderTable([]);

    expect(screen.queryByRole('button', { name: '清除搜索和筛选' })).not.toBeInTheDocument();
  });

  describe('the order of the list', () => {
    const headerOf = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });

    it('is told to assistive technology on the column the list is in the order of, and on that alone', () => {
      renderTable(words(3), { sort: { field: 'savedAt', dir: 'desc' } });

      expect(headerOf('收藏时间')).toHaveAttribute('aria-sort', 'descending');
      expect(headerOf('单词')).not.toHaveAttribute('aria-sort');
      expect(headerOf('查询次数')).not.toHaveAttribute('aria-sort');
      expect(headerOf('掌握度')).not.toHaveAttribute('aria-sort');
    });

    it('says which way, and follows the list when the order is turned round', () => {
      const { rerender, props } = renderTable(words(3), { sort: { field: 'lemma', dir: 'asc' } });
      expect(headerOf('单词')).toHaveAttribute('aria-sort', 'ascending');

      rerender(<WordTable {...props} sort={{ field: 'lemma', dir: 'desc' }} />);

      expect(headerOf('单词')).toHaveAttribute('aria-sort', 'descending');
    });

    it('is chosen with the button in the header: alphabetical first for the words, newest or most first for the rest', async () => {
      const onSortChange = vi.fn();
      renderTable(words(3), { sort: { field: 'savedAt', dir: 'desc' }, onSortChange });

      await userEvent.click(screen.getByRole('button', { name: /单词/ }));
      await userEvent.click(screen.getByRole('button', { name: /查询次数/ }));
      await userEvent.click(screen.getByRole('button', { name: /收藏时间/ }));

      expect(onSortChange).toHaveBeenNthCalledWith(1, { field: 'lemma', dir: 'asc' });
      expect(onSortChange).toHaveBeenNthCalledWith(2, { field: 'lookups', dir: 'desc' });
      // The column it is in the order of already: the same order the other way round.
      expect(onSortChange).toHaveBeenNthCalledWith(3, { field: 'savedAt', dir: 'asc' });
    });
  });
});
