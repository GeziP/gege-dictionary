import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSaveBadge, SettingsSaveError } from './SettingsSaveStatus';

const context = vi.hoisted(() => ({
  settingsSaveStatus: 'idle' as 'idle' | 'saving' | 'error',
  settingsSaveError: null as string | null,
  dismissSettingsSaveError: vi.fn(),
}));

vi.mock('../../contexts/LexNoteContext', () => ({
  useLexNote: () => context,
}));

function setState(status: 'idle' | 'saving' | 'error', error: string | null = null) {
  context.settingsSaveStatus = status;
  context.settingsSaveError = error;
}

describe('whether a change to a setting was kept', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setState('idle');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    context.dismissSettingsSaveError.mockClear();
  });

  describe('the words beside the tabs', () => {
    it('are an empty region while nothing is going on, which is there to be read out when something is', () => {
      render(<SettingsSaveBadge />);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    });

    it('say that the change is being saved', () => {
      const view = render(<SettingsSaveBadge />);

      setState('saving');
      view.rerender(<SettingsSaveBadge />);

      expect(screen.getByRole('status')).toHaveTextContent('保存中…');
    });

    it('say that it was saved when the saving is over, and are gone again after a moment', () => {
      setState('saving');
      const view = render(<SettingsSaveBadge />);

      setState('idle');
      view.rerender(<SettingsSaveBadge />);
      expect(screen.getByRole('status')).toHaveTextContent('已保存');

      act(() => vi.advanceTimersByTime(1_900));
      expect(screen.getByRole('status')).toHaveTextContent('已保存');
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('do not say that anything was saved at the start, when nothing was changed', () => {
      const view = render(<SettingsSaveBadge />);

      view.rerender(<SettingsSaveBadge />);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('do not say that it was saved when it was not, and leave the telling to the failure', () => {
      setState('saving');
      const view = render(<SettingsSaveBadge />);

      setState('error', 'disk is read-only');
      view.rerender(<SettingsSaveBadge />);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('go back to saying that it is being saved when the next change is made before they are gone', () => {
      setState('saving');
      const view = render(<SettingsSaveBadge />);
      setState('idle');
      view.rerender(<SettingsSaveBadge />);
      expect(screen.getByRole('status')).toHaveTextContent('已保存');

      setState('saving');
      view.rerender(<SettingsSaveBadge />);

      expect(screen.getByRole('status')).toHaveTextContent('保存中…');
      expect(screen.getByRole('status')).not.toHaveTextContent('已保存');
    });
  });

  describe('the message about a change that was not kept', () => {
    it('is not there while all is well', () => {
      const { container } = render(<SettingsSaveError />);

      expect(container).toBeEmptyDOMElement();
    });

    it('is not there for a save that is going on, nor for a failure with no reason to give', () => {
      setState('saving');
      const view = render(<SettingsSaveError />);
      expect(view.container).toBeEmptyDOMElement();

      setState('error', null);
      view.rerender(<SettingsSaveError />);
      expect(view.container).toBeEmptyDOMElement();
    });

    it('says that the change was undone, and why', () => {
      setState('error', 'disk is read-only');
      render(<SettingsSaveError />);

      expect(screen.getByRole('alert')).toHaveTextContent('设置保存失败，已恢复为改动之前的样子：disk is read-only');
    });

    it('can be put away', () => {
      setState('error', 'disk is read-only');
      render(<SettingsSaveError />);

      fireEvent.click(screen.getByRole('button', { name: '关闭保存失败的提示' }));

      expect(context.dismissSettingsSaveError).toHaveBeenCalledTimes(1);
    });
  });
});
