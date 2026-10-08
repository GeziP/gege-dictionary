/**
 * Which rows of a long list of equally tall rows need to be on the page.
 *
 * The rows are not drawn all at once: those that are on screen (and a few more on each side, so a
 * fast scroll never shows a gap) are, and two spacers stand in for the height of the rest. That
 * keeps the page the same size and the scroll bar honest, at a cost that follows the screen and
 * not the size of the library.
 */
export interface RowWindowInput {
  /** How far the list is scrolled, in pixels. */
  scrollTop: number;
  /** How tall the visible part of the list is, in pixels. */
  viewportHeight: number;
  /** The height of one row, in pixels. */
  rowHeight: number;
  /** How many rows there are. */
  count: number;
  /** How many rows to draw beyond the visible ones, on each side. */
  overscan: number;
}

export interface RowWindow {
  /** The first row to draw. */
  start: number;
  /** One past the last row to draw. */
  end: number;
  /** The height of the rows before `start`, which are not drawn. */
  before: number;
  /** The height of the rows from `end` on, which are not drawn. */
  after: number;
}

/** The rows to draw for a list scrolled to `scrollTop`; always within `0..count`. */
export function rowWindow({
  scrollTop,
  viewportHeight,
  rowHeight,
  count,
  overscan,
}: RowWindowInput): RowWindow {
  const total = Math.max(0, Math.floor(count));
  // A height that is not a number, or not positive, would divide by zero: draw from the top.
  const height = rowHeight > 0 && Number.isFinite(rowHeight) ? rowHeight : 1;
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const visible = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const spare = Math.max(0, Math.floor(overscan));

  const first = Math.floor(top / height) - spare;
  const last = Math.ceil((top + visible) / height) + spare;
  // Never past the end, and never nothing at all while there is something to show: a list that
  // has just got shorter can still be scrolled to where its last row used to be.
  const end = Math.min(total, Math.max(last, 1));
  const start = Math.max(0, Math.min(first, end - 1));
  return { start, end, before: start * height, after: (total - end) * height };
}
