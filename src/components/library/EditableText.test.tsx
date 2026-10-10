import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditableText } from './EditableText';

const NOTE = '编辑个人笔记';

describe('text that is edited where it stands', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the text, or the placeholder while there is none', () => {
    const { rerender } = render(<EditableText value="我的笔记" onCommit={vi.fn()} label={NOTE} multiline />);
    expect(screen.getByRole('button', { name: NOTE })).toHaveTextContent('我的笔记');

    rerender(<EditableText value="" onCommit={vi.fn()} label={NOTE} multiline placeholder="写下你自己的理解…" />);
    expect(screen.getByRole('button', { name: NOTE })).toHaveTextContent('写下你自己的理解…');
  });

  it('starts editing with a click', async () => {
    render(<EditableText value="我的笔记" onCommit={vi.fn()} label={NOTE} multiline />);

    await userEvent.click(screen.getByRole('button', { name: NOTE }));

    expect(await screen.findByRole('textbox', { name: NOTE })).toHaveValue('我的笔记');
  });

  it('starts editing with Enter or with Space too, for those who do not use a mouse', async () => {
    const user = userEvent.setup();
    render(<EditableText value="我的笔记" onCommit={vi.fn()} label={NOTE} multiline />);

    await user.tab();
    expect(screen.getByRole('button', { name: NOTE })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('textbox', { name: NOTE })).toBeInTheDocument();

    cleanup();
    render(<EditableText value="我的笔记" onCommit={vi.fn()} label={NOTE} multiline />);
    await user.tab();
    await user.keyboard(' ');
    expect(await screen.findByRole('textbox', { name: NOTE })).toBeInTheDocument();
  });

  it('keeps what was typed when the field is left, once', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableText value="旧的" onCommit={onCommit} label={NOTE} multiline />);
    await user.click(screen.getByRole('button', { name: NOTE }));

    const field = await screen.findByRole('textbox', { name: NOTE });
    await user.clear(field);
    await user.type(field, '新的');
    await user.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('新的');
    expect(screen.queryByRole('textbox', { name: NOTE })).not.toBeInTheDocument();
  });

  it('says nothing when the text was left as it was', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableText value="旧的" onCommit={onCommit} label={NOTE} multiline />);
    await user.click(screen.getByRole('button', { name: NOTE }));

    await screen.findByRole('textbox', { name: NOTE });
    await user.tab();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('takes Enter in a one-line field as the end of the edit', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableText value="旧的" onCommit={onCommit} label="编辑名称" />);
    await user.click(screen.getByRole('button', { name: '编辑名称' }));

    const field = await screen.findByRole('textbox', { name: '编辑名称' });
    await user.clear(field);
    await user.type(field, '新的{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('新的');
  });

  describe.each([
    ['a field of several lines', true],
    ['a field of one line', false],
  ])('giving up the edit in %s', (_name, multiline) => {
    it('puts the old text back with Escape, and keeps nothing', async () => {
      const user = userEvent.setup();
      const onCommit = vi.fn();
      render(<EditableText value="旧的" onCommit={onCommit} label={NOTE} multiline={multiline} />);
      await user.click(screen.getByRole('button', { name: NOTE }));

      const field = await screen.findByRole('textbox', { name: NOTE });
      await user.clear(field);
      await user.type(field, '写到一半{Escape}');

      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: NOTE })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: NOTE })).toHaveTextContent('旧的');
    });

    it('does not let Escape go on to close what is around the field', async () => {
      const user = userEvent.setup();
      const seen = vi.fn();
      window.addEventListener('keydown', seen);
      try {
        render(<EditableText value="旧的" onCommit={vi.fn()} label={NOTE} multiline={multiline} />);
        await user.click(screen.getByRole('button', { name: NOTE }));

        await user.type(await screen.findByRole('textbox', { name: NOTE }), '{Escape}');

        expect(seen.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toHaveLength(0);
      } finally {
        window.removeEventListener('keydown', seen);
      }
    });
  });
});
