import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast, type ToastMessage } from './Toast';

const message = (overrides: Partial<ToastMessage> = {}): ToastMessage => ({
  id: 1,
  text: '已保存',
  tone: 'info',
  ...overrides,
});

describe('the notice at the bottom of a page', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows nothing while there is nothing to say', () => {
    const { container } = render(<Toast message={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['is only to be known', 'info', '已保存'],
    ['went well', 'success', '已恢复'],
  ] as const)('is read out politely for what %s', (_what, tone, text) => {
    render(<Toast message={message({ tone, text })} />);

    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('is read out at once for a failure', () => {
    render(<Toast message={message({ tone: 'error', text: '删除失败：database is locked' })} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('删除失败：database is locked');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('offers the action it is given, which is done by pressing it', async () => {
    const onAction = vi.fn();
    render(<Toast message={message({ text: '已删除「alpha」', actionLabel: '撤销', onAction })} />);

    await userEvent.click(screen.getByRole('button', { name: '撤销' }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('has no button where it has no action to offer, or a label for it only', () => {
    const { rerender } = render(<Toast message={message()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<Toast message={message({ actionLabel: '撤销' })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('asks to be kept while the pointer or the keyboard is on it, and to go on when they leave', async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    render(
      <Toast
        message={message({ actionLabel: '撤销', onAction: vi.fn() })}
        onPause={onPause}
        onResume={onResume}
      />,
    );
    const notice = screen.getByRole('status');

    fireEvent.mouseEnter(notice);
    expect(onPause).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(notice);
    expect(onResume).toHaveBeenCalledTimes(1);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus();
    expect(onPause).toHaveBeenCalledTimes(2);
    await userEvent.tab();
    expect(onResume).toHaveBeenCalledTimes(2);
  });
});
