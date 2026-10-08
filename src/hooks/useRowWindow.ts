import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { rowWindow, type RowWindow } from '../lib/row-window';

interface Options {
  /** How many rows the list has. */
  count: number;
  /** Whether to window the list at all. When it is not, every row is in the window. */
  enabled: boolean;
  /** How many rows to draw beyond the visible ones, on each side. */
  overscan?: number;
  /** The height of a row to assume until drawn rows have been measured. */
  rowHeight?: number;
}

/**
 * Follows a scrolling list and says which of its rows to draw (see `rowWindow`).
 *
 * `scrollerRef` goes on the element that scrolls. `measure` takes the rows that are drawn, in
 * order, and learns their real height from them, so the list stays right whatever the font size,
 * the theme or the card scale makes of a row.
 */
export function useRowWindow({
  count,
  enabled,
  overscan = 12,
  rowHeight: assumedRowHeight = 41,
}: Options): {
  scrollerRef: (element: HTMLElement | null) => void;
  /** Which rows to draw, and how tall the rows before and after them are. */
  rows: RowWindow;
  measure: (drawn: ArrayLike<HTMLElement>) => void;
} {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [rowHeight, setRowHeight] = useState(assumedRowHeight);
  const [view, setView] = useState({ scrollTop: 0, viewportHeight: 0 });

  useLayoutEffect(() => {
    if (!enabled || !scroller) return undefined;
    const read = () => {
      const { scrollTop, clientHeight: viewportHeight } = scroller;
      // Scrolling within a row changes nothing that is drawn, so it is not worth a render.
      setView((previous) =>
        previous.viewportHeight === viewportHeight &&
        Math.floor(previous.scrollTop / rowHeight) === Math.floor(scrollTop / rowHeight)
          ? previous
          : { scrollTop, viewportHeight },
      );
    };
    read();
    scroller.addEventListener('scroll', read, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', read);
      observer?.disconnect();
    };
  }, [enabled, scroller, rowHeight]);

  const measure = useCallback((drawn: ArrayLike<HTMLElement>) => {
    if (drawn.length < 2) return;
    // The distance between two rows is their height with whatever separates them.
    const pitch = drawn[1].offsetTop - drawn[0].offsetTop;
    if (pitch > 0) setRowHeight((current) => (Math.abs(current - pitch) < 0.5 ? current : pitch));
  }, []);

  const rows = useMemo<RowWindow>(
    () =>
      enabled
        ? rowWindow({ ...view, rowHeight, count, overscan })
        : { start: 0, end: count, before: 0, after: 0 },
    [enabled, view, rowHeight, count, overscan],
  );

  return { scrollerRef: setScroller, rows, measure };
}
