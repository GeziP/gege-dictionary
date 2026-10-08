import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mastery, SavedWord } from '../../types/lexnote';
import { FilterPanel } from './FilterPanel';

const word = (lemma: string, sourceApp: string, tags: string[]) => ({ id: lemma, lemma, sourceApp, tags }) as unknown as SavedWord;

const WORDS = [
  word('alpha', 'Chrome', ['news', 'econ']),
  word('beta', 'Chrome', ['news']),
  word('gamma', 'Word', ['news', 'law']),
];

function renderPanel(overrides: Partial<Parameters<typeof FilterPanel>[0]> = {}) {
  const props = {
    words: WORDS,
    activeTags: [] as string[],
    activeSources: [] as string[],
    activeMastery: [] as Mastery[],
    range: 'all',
    onToggleTag: vi.fn(),
    onToggleSource: vi.fn(),
    onToggleMastery: vi.fn(),
    onRangeChange: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<FilterPanel {...props} />) };
}

afterEach(() => {
  cleanup();
});

describe('the filters of the library', () => {
  describe('by how well a word is known', () => {
    it('offer every level a word can be at, in the order a word goes through them', () => {
      renderPanel();

      const levels = screen.getAllByRole('button', { pressed: false }).map((button) => button.textContent);

      expect(levels).toEqual(['新词', '巩固中', '熟悉', '已掌握']);
    });

    it.each([
      ['新词', 'new'],
      ['巩固中', 'learning'],
      ['熟悉', 'familiar'],
      ['已掌握', 'mastered'],
    ])('ask for the words that are at "%s"', async (label, level) => {
      const { props } = renderPanel();

      await userEvent.click(screen.getByRole('button', { name: label }));

      expect(props.onToggleMastery).toHaveBeenCalledWith(level);
    });

    it('show which of them are on', () => {
      renderPanel({ activeMastery: ['familiar'] });

      expect(screen.getByRole('button', { name: '熟悉' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: '新词' })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('by tag and by source', () => {
    it('list the tags with the most used first, and how many words have each', () => {
      renderPanel();
      const tags = within(screen.getByRole('heading', { name: '标签' }).closest('section') as HTMLElement);

      expect(tags.getAllByRole('button').map((button) => button.textContent)).toEqual(['news3', 'econ1', 'law1']);
    });

    it('list the source apps with how many words came from each', () => {
      renderPanel();
      const sources = within(screen.getByRole('heading', { name: '来源应用' }).closest('section') as HTMLElement);

      expect(sources.getAllByRole('button').map((button) => button.textContent)).toEqual(['Chrome2', 'Word1']);
    });

    it('ask for the tag, and the source, that were clicked', async () => {
      const { props } = renderPanel();

      await userEvent.click(screen.getByRole('button', { name: /^econ/ }));
      await userEvent.click(screen.getByRole('button', { name: /^Word/ }));

      expect(props.onToggleTag).toHaveBeenCalledWith('econ');
      expect(props.onToggleSource).toHaveBeenCalledWith('Word');
    });
  });

  describe('by time', () => {
    it('ask for the range that was clicked', async () => {
      const { props } = renderPanel();

      await userEvent.click(screen.getByRole('button', { name: '最近 7 天' }));

      expect(props.onRangeChange).toHaveBeenCalledWith('7');
    });
  });

  describe('clearing them', () => {
    it('is not offered while none is on', () => {
      renderPanel();

      expect(screen.queryByRole('button', { name: /清除/ })).not.toBeInTheDocument();
    });

    it.each([
      ['a tag', { activeTags: ['news'] }],
      ['a source', { activeSources: ['Word'] }],
      ['a level', { activeMastery: ['mastered'] as Mastery[] }],
      ['a range of time', { range: '30' }],
    ])('is offered when %s is on, and clears them all', async (_name, overrides) => {
      const { props } = renderPanel(overrides);

      await userEvent.click(screen.getByRole('button', { name: /清除/ }));

      expect(props.onReset).toHaveBeenCalledTimes(1);
    });
  });
});
