/** The smallest and the largest size, in pixels, that the text of a saved word can be read at. */
export const READER_MIN = 10;
export const READER_MAX = 22;

/** The size asked for, or the nearest one that is allowed. */
export function clampReaderSize(size: number): number {
  return Math.min(READER_MAX, Math.max(READER_MIN, size));
}
