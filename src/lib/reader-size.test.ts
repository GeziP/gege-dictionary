import { describe, expect, it } from 'vitest';
import { READER_MAX, READER_MIN, clampReaderSize } from './reader-size';

describe('the size the text of a saved word is read at', () => {
  it('keeps a size that is allowed', () => {
    expect(clampReaderSize(13)).toBe(13);
    expect(clampReaderSize(READER_MIN)).toBe(READER_MIN);
    expect(clampReaderSize(READER_MAX)).toBe(READER_MAX);
  });

  it('takes the nearest allowed size for one that is not', () => {
    expect(clampReaderSize(READER_MIN - 1)).toBe(READER_MIN);
    expect(clampReaderSize(READER_MAX + 5)).toBe(READER_MAX);
    expect(clampReaderSize(-100)).toBe(READER_MIN);
  });
});
