import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HighlightWord } from './HighlightWord';

function highlighted(text: string, word: string): string[] {
  const { container } = render(<HighlightWord text={text} word={word} />);
  return Array.from(container.querySelectorAll('span')).map((span) => span.textContent ?? '');
}

describe('HighlightWord', () => {
  it('picks out the word wherever it stands, whatever its case', () => {
    expect(highlighted('Run fast, then run again.', 'run')).toEqual(['Run', 'run']);
  });

  it('picks out the word with what is added to it', () => {
    expect(highlighted('She was running and he runs.', 'run')).toEqual(['running', 'runs']);
  });

  it('does not take the word for the end or the middle of another one', () => {
    expect(highlighted('Prune the brush, rerun it.', 'run')).toEqual([]);
  });

  it('keeps every character of the sentence, picked out or not', () => {
    const { container } = render(<HighlightWord text="A run, a prune, a running." word="run" />);

    expect(container.textContent).toBe('A run, a prune, a running.');
  });

  it('takes characters that mean something in a pattern literally', () => {
    expect(highlighted('The c++ language, not c.', 'c++')).toEqual(['c++']);
    expect(highlighted('What (is) it? A (is) b.', '(is)')).toEqual(['(is)', '(is)']);
    expect(highlighted('Is that so? Is it.', 'is?')).toEqual([]);
  });

  it('shows the sentence as it is when there is no word to pick out', () => {
    expect(highlighted('Nothing to see.', '')).toEqual([]);
    const { container } = render(<HighlightWord text="Nothing to see." word="" />);
    expect(container.textContent).toBe('Nothing to see.');
  });

  it('shows the sentence as it is when the word is not in it', () => {
    const { container } = render(<HighlightWord text="Nothing to see." word="zebra" />);

    expect(container.querySelectorAll('span')).toHaveLength(0);
    expect(container.textContent).toBe('Nothing to see.');
  });
});
