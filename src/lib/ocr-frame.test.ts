import { describe, expect, it } from 'vitest';
import { decodeFrame, rectBetween, toFrameRegion } from './ocr-frame';

/** What the backend sends: width and height (little endian), then RGBA pixels. */
function payload(width: number, height: number, pixels: number[]): ArrayBuffer {
  const bytes = new Uint8Array(8 + pixels.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, width, true);
  header.setUint32(4, height, true);
  bytes.set(pixels, 8);
  return bytes.buffer;
}

describe('the picture of the screen that the backend sends', () => {
  it('is read as its size and its RGBA pixels', () => {
    const frame = decodeFrame(payload(2, 1, [1, 2, 3, 255, 4, 5, 6, 255]));

    expect(frame.width).toBe(2);
    expect(frame.height).toBe(1);
    expect(Array.from(frame.pixels)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('is refused when it is too short to have a size', () => {
    expect(() => decodeFrame(new ArrayBuffer(5))).toThrow('截图数据不完整');
  });

  it('is refused when its pixels are not as many as its size says', () => {
    expect(() => decodeFrame(payload(2, 2, [1, 2, 3, 255]))).toThrow('尺寸不符');
    expect(() => decodeFrame(payload(1, 1, [1, 2, 3, 255, 9]))).toThrow('尺寸不符');
  });

  it('is refused when it has no area', () => {
    expect(() => decodeFrame(payload(0, 3, []))).toThrow('尺寸不符');
  });
});

describe('the rectangle between two corners', () => {
  it('is the same whichever way it was dragged', () => {
    const expected = { x: 10, y: 20, w: 30, h: 40 };

    expect(rectBetween({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected);
    expect(rectBetween({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected);
    expect(rectBetween({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected);
  });
});

describe('a selection on the page, as a region of the picture', () => {
  const page = { width: 1280, height: 720 };

  it('is scaled by the sizes of the page and of the picture', () => {
    // A 1920x1080 screen at 150% is a 1280x720 page.
    const region = toFrameRegion({ x: 100, y: 50, w: 200, h: 100 }, page, { width: 1920, height: 1080 });

    expect(region).toEqual({ x: 150, y: 75, w: 300, h: 150 });
  });

  it('is the same pixels where the page is the picture', () => {
    const region = toFrameRegion({ x: 7, y: 9, w: 40, h: 12 }, page, { width: 1280, height: 720 });

    expect(region).toEqual({ x: 7, y: 9, w: 40, h: 12 });
  });

  it('follows the sizes, not a display scale that rounding has made a little different', () => {
    // 3840 wide at 175% is a page of 2194 CSS pixels (2194.28 rounded down).
    const region = toFrameRegion(
      { x: 0, y: 0, w: 2194, h: 1234 },
      { width: 2194, height: 1234 },
      { width: 3840, height: 2160 },
    );

    expect(region).toEqual({ x: 0, y: 0, w: 3840, h: 2160 });
  });

  it('is cut off where it leaves the picture', () => {
    const region = toFrameRegion({ x: 1200, y: -30, w: 200, h: 100 }, page, { width: 1280, height: 720 });

    expect(region).toEqual({ x: 1200, y: 0, w: 80, h: 70 });
  });

  it('is nothing when none of it is on the picture', () => {
    const frame = { width: 1280, height: 720 };

    expect(toFrameRegion({ x: 1300, y: 10, w: 50, h: 50 }, page, frame)).toBeNull();
    expect(toFrameRegion({ x: 10, y: 10, w: 0, h: 50 }, page, frame)).toBeNull();
  });

  it('is nothing while the page has no size', () => {
    expect(toFrameRegion({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 })).toBeNull();
  });
});
