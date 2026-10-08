import { useRef, useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function Dialog({
  onClose,
  enabled = true,
  empty = false,
}: {
  onClose: () => void;
  enabled?: boolean;
  empty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, enabled);
  return (
    <div ref={ref} role="dialog" aria-label="对话框" tabIndex={-1}>
      {empty ? null : (
        <>
          <button type="button">第一个</button>
          <button type="button">中间的</button>
          <button type="button" onClick={onClose}>
            最后一个
          </button>
        </>
      )}
    </div>
  );
}

function Page(props: { enabled?: boolean; empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <button type="button">页面上的另一个</button>
      {open ? <Dialog onClose={() => setOpen(false)} {...props} /> : null}
    </>
  );
}

describe('keeping the keyboard in a dialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('moves the focus to the first control when the dialog opens', async () => {
    render(<Page />);

    await userEvent.click(screen.getByRole('button', { name: '打开' }));

    expect(screen.getByRole('button', { name: '第一个' })).toHaveFocus();
  });

  it('takes Tab round the controls of the dialog instead of out of it, and Shift+Tab the other way', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: '打开' }));

    await user.tab();
    expect(screen.getByRole('button', { name: '中间的' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '最后一个' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '第一个' })).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '最后一个' })).toHaveFocus();
  });

  it('brings the focus back in when Tab is pressed while it is on the page behind', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: '打开' }));
    screen.getByRole('button', { name: '页面上的另一个' }).focus();

    await user.tab();

    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });

  it('gives the focus back to the control that opened it when it closes', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: '打开' });
    await user.click(opener);
    expect(screen.getByRole('button', { name: '第一个' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: '最后一个' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('takes the focus itself when there is nothing in it to press, and keeps it', async () => {
    const user = userEvent.setup();
    render(<Page empty />);
    await user.click(screen.getByRole('button', { name: '打开' }));

    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('leaves the keyboard alone while it is switched off', async () => {
    const user = userEvent.setup();
    render(<Page enabled={false} />);
    const opener = screen.getByRole('button', { name: '打开' });
    await user.click(opener);

    expect(opener).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '页面上的另一个' })).toHaveFocus();
  });
});
