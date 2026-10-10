import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from './useToast';

describe('the notice at the bottom of a page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing until something is said', () => {
    const { result } = renderHook(() => useToast());
    expect(result.current.toast).toBeNull();
  });

  it('shows what is said, as information unless it is told otherwise', () => {
    const { result } = renderHook(() => useToast());

    act(() => result.current.show('已保存'));
    expect(result.current.toast).toMatchObject({ text: '已保存', tone: 'info' });

    act(() => result.current.show('删除失败', 'error'));
    expect(result.current.toast).toMatchObject({ text: '删除失败', tone: 'error' });
  });

  it('goes away after a few seconds', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.show('已保存'));

    act(() => vi.advanceTimersByTime(3_900));
    expect(result.current.toast).not.toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.toast).toBeNull();
  });

  it('stays longer when it offers something to do, since that has to be read and then decided on', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.show('已删除 alpha', 'info', { actionLabel: '撤销', onAction: () => undefined }));

    act(() => vi.advanceTimersByTime(7_900));
    expect(result.current.toast).not.toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.toast).toBeNull();
  });

  it('lets the caller decide how long it stays', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.show('请稍候', 'info', { durationMs: 1_000 }));

    act(() => vi.advanceTimersByTime(1_100));
    expect(result.current.toast).toBeNull();
  });

  it('is replaced by the next one, which gets its whole time and not what was left of the last', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.show('第一条'));
    const first = result.current.toast;
    act(() => vi.advanceTimersByTime(3_000));

    act(() => result.current.show('第二条'));
    expect(result.current.toast?.text).toBe('第二条');
    expect(result.current.toast?.id).not.toBe(first?.id);

    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current.toast?.text).toBe('第二条');
    act(() => vi.advanceTimersByTime(1_100));
    expect(result.current.toast).toBeNull();
  });

  it('is not put away while the pointer is on it, and gets its whole time again when the pointer leaves', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.show('已保存'));

    act(() => result.current.pause());
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.toast).not.toBeNull();

    act(() => result.current.resume());
    act(() => vi.advanceTimersByTime(3_900));
    expect(result.current.toast).not.toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.toast).toBeNull();
  });

  it('can be put away at once', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.show('已保存'));

    act(() => result.current.dismiss());
    expect(result.current.toast).toBeNull();
  });

  it('puts itself away before it does what the action asks, so that the action can say something of its own', () => {
    const { result } = renderHook(() => useToast());
    const seen: Array<string | undefined> = [];
    const onAction = vi.fn(() => {
      seen.push(result.current.toast?.text);
      result.current.show('已恢复 alpha', 'success');
    });
    act(() => result.current.show('已删除 alpha', 'info', { actionLabel: '撤销', onAction }));
    expect(result.current.toast?.actionLabel).toBe('撤销');

    act(() => result.current.toast?.onAction?.());

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(result.current.toast).toMatchObject({ text: '已恢复 alpha', tone: 'success' });
    expect(result.current.toast?.actionLabel).toBeUndefined();
  });

  it('does what the action asks once, however often the button is pressed while the notice fades out', () => {
    const { result } = renderHook(() => useToast());
    const onAction = vi.fn();
    act(() => result.current.show('已删除 alpha', 'info', { actionLabel: '撤销', onAction }));
    const press = result.current.toast?.onAction;

    act(() => press?.());
    act(() => press?.());

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('offers an action only when it has both a label and something to do', () => {
    const { result } = renderHook(() => useToast());

    act(() => result.current.show('已删除', 'info', { actionLabel: '撤销' }));
    expect(result.current.toast?.actionLabel).toBeUndefined();
    expect(result.current.toast?.onAction).toBeUndefined();

    act(() => result.current.show('已删除', 'info', { onAction: () => undefined }));
    expect(result.current.toast?.actionLabel).toBeUndefined();
  });

  it('stops its timer when the page is left', () => {
    const { result, unmount } = renderHook(() => useToast());
    act(() => result.current.show('已保存'));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
