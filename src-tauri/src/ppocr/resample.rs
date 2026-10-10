//! Pixel work for both networks: scaling a picture straight into a normalised planar tensor, and
//! cutting a (possibly tilted) text line out of the picture.

use super::geom::Point;

/// A picture in memory: interleaved 8-bit pixels, `channels` bytes each (3 or 4), rows packed
/// one after the other. The first three bytes of a pixel are blue, green, red.
#[derive(Clone, Copy)]
pub struct Pixels<'a> {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub data: &'a [u8],
}

impl Pixels<'_> {
    fn is_consistent(&self) -> bool {
        self.channels >= 3
            && self.width > 0
            && self.height > 0
            && self.data.len() == self.width * self.height * self.channels
    }
}

/// For every output position, the source positions that feed it and by how much.
struct Taps {
    first: Vec<usize>,
    ends: Vec<usize>,
    weights: Vec<f32>,
}

impl Taps {
    fn of(&self, output: usize) -> (usize, &[f32]) {
        let start = if output == 0 {
            0
        } else {
            self.ends[output - 1]
        };
        (self.first[output], &self.weights[start..self.ends[output]])
    }
}

/// Triangle (bilinear) taps from `source` to `target` positions. When the picture shrinks the
/// triangle widens to cover every source pixel that falls under an output pixel, so nothing
/// aliases.
fn triangle_taps(source: usize, target: usize) -> Taps {
    let scale = source as f32 / target as f32;
    let stretch = scale.max(1.0);
    let mut taps = Taps {
        first: Vec::with_capacity(target),
        ends: Vec::with_capacity(target),
        weights: Vec::with_capacity(target * 2 * stretch.ceil() as usize),
    };
    for output in 0..target {
        let centre = (output as f32 + 0.5) * scale;
        let low = (((centre - stretch - 0.5).floor() as isize) + 1).clamp(0, source as isize - 1);
        let high = (((centre + stretch - 0.5).ceil() as isize) - 1).clamp(low, source as isize - 1);
        let (low, high) = (low as usize, high as usize);
        let begin = taps.weights.len();
        let mut total = 0.0;
        for index in low..=high {
            let weight = (1.0 - ((index as f32 + 0.5 - centre) / stretch).abs()).max(0.0);
            taps.weights.push(weight);
            total += weight;
        }
        if total <= f32::EPSILON {
            let nearest = ((centre - 0.5).round().max(0.0) as usize).clamp(low, high);
            for (offset, weight) in taps.weights[begin..].iter_mut().enumerate() {
                *weight = if low + offset == nearest { 1.0 } else { 0.0 };
            }
        } else {
            for weight in &mut taps.weights[begin..] {
                *weight /= total;
            }
        }
        taps.first.push(low);
        taps.ends.push(taps.weights.len());
    }
    taps
}

/// Where the planes of a tensor lie in a float buffer: plane `c` starts at `c * plane`, row `y` of
/// a plane at `y * row`.
#[derive(Clone, Copy)]
pub struct Planes {
    pub row: usize,
    pub plane: usize,
}

/// Scales the picture to `width` by `height` and writes its three colour channels as planes of
/// `value * scale[c] + bias[c]` (value 0 to 255, channel order as in the picture). Only the
/// first `width` entries of each row are written, so a wider row can be padded by the caller.
pub fn resize_into_planes(
    source: &Pixels,
    width: usize,
    height: usize,
    scale: [f32; 3],
    bias: [f32; 3],
    out: &mut [f32],
    planes: Planes,
) {
    assert!(source.is_consistent() && width > 0 && height > 0);
    assert!(
        planes.row >= width && out.len() >= 2 * planes.plane + (height - 1) * planes.row + width
    );
    let across = triangle_taps(source.width, width);
    let down = triangle_taps(source.height, height);

    // Across first, for every source row: three planes of `source.height` rows of `width`.
    let band = source.height * width;
    let mut across_done = vec![0.0f32; 3 * band];
    let stride = source.width * source.channels;
    for y in 0..source.height {
        let row = &source.data[y * stride..(y + 1) * stride];
        for x in 0..width {
            let (first, weights) = across.of(x);
            let (mut blue, mut green, mut red) = (0.0f32, 0.0f32, 0.0f32);
            for (offset, weight) in weights.iter().enumerate() {
                let pixel = &row[(first + offset) * source.channels..];
                blue += weight * f32::from(pixel[0]);
                green += weight * f32::from(pixel[1]);
                red += weight * f32::from(pixel[2]);
            }
            let at = y * width + x;
            across_done[at] = blue;
            across_done[band + at] = green;
            across_done[2 * band + at] = red;
        }
    }

    // Then down, and the normalisation.
    for channel in 0..3 {
        let plane = &across_done[channel * band..(channel + 1) * band];
        for y in 0..height {
            let (first, weights) = down.of(y);
            let start = channel * planes.plane + y * planes.row;
            let target = &mut out[start..start + width];
            target.fill(0.0);
            for (offset, weight) in weights.iter().enumerate() {
                let line = &plane[(first + offset) * width..(first + offset + 1) * width];
                for (value, add) in target.iter_mut().zip(line) {
                    *value += weight * add;
                }
            }
            for value in target.iter_mut() {
                *value = *value * scale[channel] + bias[channel];
            }
        }
    }
}

/// A line of text cut out of the picture: blue, green, red bytes, upright.
pub struct Crop {
    pub width: usize,
    pub height: usize,
    pub bgr: Vec<u8>,
}

/// The largest side a crop may have.
const MAX_CROP_SIDE: f32 = 8192.0;

fn sample(source: &Pixels, x: f32, y: f32, out: &mut [u8]) {
    let x = x.clamp(0.0, (source.width - 1) as f32);
    let y = y.clamp(0.0, (source.height - 1) as f32);
    let (left, top) = (x.floor() as usize, y.floor() as usize);
    let (right, bottom) = (
        (left + 1).min(source.width - 1),
        (top + 1).min(source.height - 1),
    );
    let (fx, fy) = (x - left as f32, y - top as f32);
    let at = |column: usize, row: usize| (row * source.width + column) * source.channels;
    let (a, b, c, d) = (
        at(left, top),
        at(right, top),
        at(left, bottom),
        at(right, bottom),
    );
    for (channel, byte) in out.iter_mut().enumerate().take(3) {
        let upper = f32::from(source.data[a + channel]) * (1.0 - fx)
            + f32::from(source.data[b + channel]) * fx;
        let lower = f32::from(source.data[c + channel]) * (1.0 - fx)
            + f32::from(source.data[d + channel]) * fx;
        *byte = (upper * (1.0 - fy) + lower * fy).round().clamp(0.0, 255.0) as u8;
    }
}

/// Cuts the quadrilateral (top-left, top-right, bottom-right, bottom-left, as positions on the
/// picture's pixel grid) out of the picture and straightens it. The crop is as large as the
/// longer of each pair of opposite sides, so a box that lies along the pixel grid is copied
/// pixel for pixel. `None` when the box is too small or too large to be text.
pub fn cut_out(source: &Pixels, quad: &[Point; 4]) -> Option<Crop> {
    if !source.is_consistent() {
        return None;
    }
    let [top_left, top_right, bottom_right, bottom_left] = *quad;
    let width = top_left
        .distance(top_right)
        .max(bottom_left.distance(bottom_right));
    let height = top_left
        .distance(bottom_left)
        .max(top_right.distance(bottom_right));
    if !(1.0..=MAX_CROP_SIDE).contains(&width.round())
        || !(1.0..=MAX_CROP_SIDE).contains(&height.round())
    {
        return None;
    }
    let (crop_width, crop_height) = (width.round() as usize, height.round() as usize);
    let mut bgr = vec![0u8; crop_width * crop_height * 3];
    for row in 0..crop_height {
        let along_height = (row as f32 + 0.5) / crop_height as f32;
        for column in 0..crop_width {
            let along_width = (column as f32 + 0.5) / crop_width as f32;
            let x = top_left.x
                + along_width * (top_right.x - top_left.x)
                + along_height * (bottom_left.x - top_left.x)
                - 0.5;
            let y = top_left.y
                + along_width * (top_right.y - top_left.y)
                + along_height * (bottom_left.y - top_left.y)
                - 0.5;
            let at = (row * crop_width + column) * 3;
            sample(source, x, y, &mut bgr[at..at + 3]);
        }
    }
    Some(Crop {
        width: crop_width,
        height: crop_height,
        bgr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture whose pixel at (x, y) is (x, y, x + y) in blue, green, red.
    fn gradient(width: usize, height: usize) -> Vec<u8> {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[x as u8, y as u8, (x + y) as u8, 255]);
            }
        }
        data
    }

    fn picture(width: usize, height: usize, data: &[u8]) -> Pixels<'_> {
        Pixels {
            width,
            height,
            channels: 4,
            data,
        }
    }

    #[test]
    fn a_picture_scaled_to_its_own_size_is_unchanged() {
        let data = gradient(12, 7);
        let mut out = vec![0.0f32; 3 * 12 * 7];

        resize_into_planes(
            &picture(12, 7, &data),
            12,
            7,
            [1.0; 3],
            [0.0; 3],
            &mut out,
            Planes { row: 12, plane: 84 },
        );

        for y in 0..7 {
            for x in 0..12 {
                assert!((out[y * 12 + x] - x as f32).abs() < 1e-3, "blue {x},{y}");
                assert!(
                    (out[84 + y * 12 + x] - y as f32).abs() < 1e-3,
                    "green {x},{y}"
                );
                assert!(
                    (out[168 + y * 12 + x] - (x + y) as f32).abs() < 1e-3,
                    "red {x},{y}"
                );
            }
        }
    }

    #[test]
    fn the_scale_and_bias_turn_bytes_into_tensor_values() {
        let data = vec![255u8; 4 * 4 * 4];
        let mut out = vec![9.0f32; 3 * 4 * 4];

        resize_into_planes(
            &picture(4, 4, &data),
            4,
            4,
            [2.0 / 255.0; 3],
            [-1.0; 3],
            &mut out,
            Planes { row: 4, plane: 16 },
        );

        assert!(out.iter().all(|value| (value - 1.0).abs() < 1e-5));
    }

    #[test]
    fn shrinking_averages_what_falls_under_each_output_pixel() {
        // Columns alternate 0 and 200: a 4:1 shrink must come out at their mean, not at one of them.
        let mut data = Vec::new();
        for _y in 0..8 {
            for x in 0..8 {
                let value = if x % 2 == 0 { 0 } else { 200 };
                data.extend_from_slice(&[value, value, value, 255]);
            }
        }
        let mut out = vec![0.0f32; 3 * 2 * 2];

        resize_into_planes(
            &picture(8, 8, &data),
            2,
            2,
            [1.0; 3],
            [0.0; 3],
            &mut out,
            Planes { row: 2, plane: 4 },
        );

        for value in &out[..4] {
            assert!((value - 100.0).abs() < 15.0, "{out:?}");
        }
    }

    #[test]
    fn a_row_wider_than_the_picture_keeps_its_padding_untouched() {
        let data = vec![255u8; 4 * 2 * 4];
        let mut out = vec![7.0f32; 3 * 2 * 6];

        resize_into_planes(
            &picture(4, 2, &data),
            4,
            2,
            [1.0; 3],
            [0.0; 3],
            &mut out,
            Planes { row: 6, plane: 12 },
        );

        assert_eq!(out[0], 255.0);
        assert_eq!(out[4], 7.0);
        assert_eq!(out[5], 7.0);
        assert_eq!(out[6 + 4], 7.0);
    }

    #[test]
    fn a_box_on_the_pixel_grid_is_copied_pixel_for_pixel() {
        let data = gradient(40, 30);
        let quad = [
            Point::new(10.0, 5.0),
            Point::new(30.0, 5.0),
            Point::new(30.0, 20.0),
            Point::new(10.0, 20.0),
        ];

        let crop = cut_out(&picture(40, 30, &data), &quad).unwrap();

        assert_eq!((crop.width, crop.height), (20, 15));
        for row in 0..15usize {
            for column in 0..20usize {
                let at = (row * 20 + column) * 3;
                assert_eq!(
                    crop.bgr[at..at + 3],
                    [
                        (10 + column) as u8,
                        (5 + row) as u8,
                        (15 + column + row) as u8
                    ],
                    "pixel {column},{row}"
                );
            }
        }
    }

    #[test]
    fn a_box_past_the_edge_of_the_picture_repeats_the_edge() {
        let data = gradient(10, 10);
        let quad = [
            Point::new(8.0, 0.0),
            Point::new(14.0, 0.0),
            Point::new(14.0, 4.0),
            Point::new(8.0, 4.0),
        ];

        let crop = cut_out(&picture(10, 10, &data), &quad).unwrap();

        assert_eq!((crop.width, crop.height), (6, 4));
        // Columns 8 and 9 exist; the rest repeat column 9.
        assert_eq!(crop.bgr[0], 8);
        assert_eq!(crop.bgr[3], 9);
        assert_eq!(crop.bgr[5 * 3], 9);
    }

    #[test]
    fn a_box_that_is_too_small_or_not_a_box_is_refused() {
        let data = gradient(10, 10);
        let flat = [
            Point::new(1.0, 1.0),
            Point::new(5.0, 1.0),
            Point::new(5.0, 1.2),
            Point::new(1.0, 1.2),
        ];

        assert!(cut_out(&picture(10, 10, &data), &flat).is_none());
        assert!(cut_out(&picture(10, 10, &data[..8]), &flat).is_none());
    }
}
