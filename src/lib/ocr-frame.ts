/** A picture of the screen, as the screenshot picker's canvas takes it. */
export interface ScreenFrame {
  width: number;
  height: number;
  /** RGBA, top-down, `width * height * 4` bytes. A view on the buffer it was read from. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** A rectangle: `x` and `y` are the top left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The shortest side, in CSS pixels, of a drag that counts as a selection. Anything smaller is a
 * click or a slip of the hand, and there is no text to read in it.
 */
export const MIN_SELECTION = 8;

const HEADER_BYTES = 8;

/**
 * Reads what the backend sends as the picture of the screen: its width and its height (4 bytes
 * each, little endian), then the pixels as RGBA. A picture that does not add up is refused, not
 * drawn: a canvas filled from the wrong number of bytes shows a smeared screen that looks like a
 * working one.
 */
export function decodeFrame(buffer: ArrayBuffer): ScreenFrame {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('截图数据不完整');
  const header = new DataView(buffer);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const pixelBytes = width * height * 4;
  if (width === 0 || height === 0 || buffer.byteLength !== HEADER_BYTES + pixelBytes) {
    throw new Error('截图数据与它的尺寸不符');
  }
  return { width, height, pixels: new Uint8ClampedArray(buffer, HEADER_BYTES, pixelBytes) };
}

/** The rectangle between two corners, whichever way it was dragged. */
export function rectBetween(from: { x: number; y: number }, to: { x: number; y: number }): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * What a selection on the page is, in the pixels of the picture. The picture is stretched over
 * the whole page, so the page is mapped onto it by the two sizes (not by the display scale, which
 * differs from them by rounding). The edges are rounded, not the width, so that neighbouring
 * selections do not overlap or leave a gap. `null` when nothing of the picture is inside.
 */
export function toFrameRegion(selection: Rect, page: Size, frame: Size): Rect | null {
  if (page.width <= 0 || page.height <= 0) return null;
  const scaleX = frame.width / page.width;
  const scaleY = frame.height / page.height;
  const left = clamp(Math.round(selection.x * scaleX), 0, frame.width);
  const top = clamp(Math.round(selection.y * scaleY), 0, frame.height);
  const right = clamp(Math.round((selection.x + selection.w) * scaleX), 0, frame.width);
  const bottom = clamp(Math.round((selection.y + selection.h) * scaleY), 0, frame.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}
