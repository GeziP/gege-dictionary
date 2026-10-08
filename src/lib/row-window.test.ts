import { describe, expect, it } from 'vitest';
import { rowWindow } from './row-window';

const base = { rowHeight: 40, viewportHeight: 400, overscan: 5 };

describe('which rows of a long list are drawn', () => {
  it('draws the visible rows and a few more, and stands in for all the others', () => {
    expect(rowWindow({ ...base, scrollTop: 0, count: 1000 })).toEqual({
      start: 0,
      end: 15,
      before: 0,
      after: (1000 - 15) * 40,
    });
  });

  it('follows the scroll position, with a margin on both sides', () => {
    // Row 100 is at the top of the screen, and ten rows fit on it.
    expect(rowWindow({ ...base, scrollTop: 4000, count: 1000 })).toEqual({
      start: 95,
      end: 115,
      before: 95 * 40,
      after: (1000 - 115) * 40,
    });
  });

  it('stops at the last row', () => {
    const atTheBottom = rowWindow({ ...base, scrollTop: 1000 * 40 - 400, count: 1000 });
    expect(atTheBottom).toMatchObject({ start: 985, end: 1000, after: 0 });
  });

  it('always adds up to the height of the whole list, wherever it is scrolled to', () => {
    for (const count of [1, 7, 15, 16, 399, 5000]) {
      for (const scrollTop of [0, 1, 39, 40, 41, 777, 15999, 16000, 200_000, 10_000_000]) {
        const rows = rowWindow({ ...base, scrollTop, count });
        expect(rows.start, `${count} rows at ${scrollTop}`).toBeGreaterThanOrEqual(0);
        expect(rows.end, `${count} rows at ${scrollTop}`).toBeLessThanOrEqual(count);
        expect(rows.end, `${count} rows at ${scrollTop}`).toBeGreaterThan(rows.start);
        expect(rows.before + (rows.end - rows.start) * 40 + rows.after, `${count} rows at ${scrollTop}`).toBe(
          count * 40,
        );
      }
    }
  });

  it('shows the last rows of a list that has got shorter than where it was scrolled to', () => {
    // 20 rows, but the scroll position of a list of thousands: the browser has not caught up yet.
    expect(rowWindow({ ...base, scrollTop: 100_000, count: 20 })).toEqual({
      start: 19,
      end: 20,
      before: 19 * 40,
      after: 0,
    });
  });

  it('draws nothing for an empty list, and nothing stands in for it', () => {
    expect(rowWindow({ ...base, scrollTop: 0, count: 0 })).toEqual({ start: 0, end: 0, before: 0, after: 0 });
    expect(rowWindow({ ...base, scrollTop: 5000, count: 0 })).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });

  it('still draws a margin of rows when the height of the list is not known yet', () => {
    expect(rowWindow({ ...base, viewportHeight: 0, scrollTop: 0, count: 1000 })).toMatchObject({ start: 0, end: 5 });
  });

  it('draws exactly the visible rows without a margin', () => {
    expect(rowWindow({ ...base, overscan: 0, scrollTop: 800, count: 1000 })).toMatchObject({ start: 20, end: 30 });
  });

  it('survives numbers that are not usable, by drawing from the top', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rows = rowWindow({ ...base, rowHeight: bad, scrollTop: 0, count: 100 });
      expect(rows.start).toBe(0);
      expect(rows.end).toBeGreaterThan(0);
      expect(Number.isFinite(rows.before + rows.after)).toBe(true);
    }
    expect(rowWindow({ ...base, scrollTop: Number.NaN, count: 100 })).toMatchObject({ start: 0, end: 15 });
    expect(rowWindow({ ...base, scrollTop: -300, count: 100 })).toMatchObject({ start: 0, end: 15 });
  });
});
