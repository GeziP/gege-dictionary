//! Finding the lines of text in a picture: how large the picture is shown to the detection
//! network, and how its answer (a map of how text-like each pixel is) becomes boxes.

use super::geom::{convex_hull, min_area_rect, Point, RotatedRect};

/// Settings of the detection step.
#[derive(Clone, Copy, Debug)]
pub struct DetectParams {
    /// A picture whose shorter side is below this is enlarged until it is not: small text is not
    /// found at its own size.
    pub min_side: usize,
    /// The longest side the network is shown. Larger pictures are shrunk (the text lines are cut
    /// out of the full-size picture afterwards, so reading is not affected).
    pub max_side: usize,
    /// A pixel is text when the network is more sure of it than this.
    pub pixel_threshold: f32,
    /// A blob is a text line when the network is, on average, more sure of its pixels than this.
    pub box_threshold: f32,
    /// How far a blob is grown to make a box: this times area over perimeter. The network draws
    /// text tighter than the text really is.
    pub unclip_ratio: f32,
    /// A blob with a side shorter than this is dust.
    pub min_box_side: f32,
    /// More blobs than this are not looked at.
    pub max_blobs: usize,
}

impl Default for DetectParams {
    fn default() -> Self {
        DetectParams {
            min_side: 160,
            max_side: 1600,
            pixel_threshold: 0.3,
            box_threshold: 0.4,
            unclip_ratio: 1.5,
            min_box_side: 3.0,
            max_blobs: 1000,
        }
    }
}

/// The size the network is shown for a picture of `width` by `height`: scaled by the rule above,
/// then rounded to a multiple of 32 (the network halves the picture five times).
pub fn input_size(width: usize, height: usize, params: &DetectParams) -> (usize, usize) {
    let shorter = width.min(height).max(1);
    let ratio = if shorter < params.min_side {
        params.min_side as f32 / shorter as f32
    } else {
        1.0
    };
    let (mut scaled_width, mut scaled_height) = (
        (width as f32 * ratio) as usize,
        (height as f32 * ratio) as usize,
    );
    let longer = scaled_width.max(scaled_height);
    if longer > params.max_side {
        let shrink = params.max_side as f32 / longer as f32;
        scaled_width = (scaled_width as f32 * shrink) as usize;
        scaled_height = (scaled_height as f32 * shrink) as usize;
    }
    let round = |side: usize| ((side + 16) / 32 * 32).max(32);
    (round(scaled_width), round(scaled_height))
}

/// The colour statistics the detection network was trained with, in blue, green, red order.
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// How bytes (0 to 255) become the network's input: `value * scale + bias` per channel.
pub fn input_scale_and_bias() -> ([f32; 3], [f32; 3]) {
    (
        [0, 1, 2].map(|channel| 1.0 / (255.0 * STD[channel])),
        [0, 1, 2].map(|channel| -MEAN[channel] / STD[channel]),
    )
}

/// A horizontal stretch of text pixels: row `y`, columns `first` to `last` inclusive.
#[derive(Clone, Copy)]
struct Run {
    y: usize,
    first: usize,
    last: usize,
}

fn text_runs(map: &[f32], width: usize, height: usize, threshold: f32) -> (Vec<Run>, Vec<usize>) {
    let mut runs = Vec::new();
    let mut row_starts = Vec::with_capacity(height + 1);
    for y in 0..height {
        row_starts.push(runs.len());
        let row = &map[y * width..(y + 1) * width];
        let mut start = None;
        for (x, &value) in row.iter().enumerate() {
            match (value > threshold, start) {
                (true, None) => start = Some(x),
                (false, Some(first)) => {
                    runs.push(Run {
                        y,
                        first,
                        last: x - 1,
                    });
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(first) = start {
            runs.push(Run {
                y,
                first,
                last: width - 1,
            });
        }
    }
    row_starts.push(runs.len());
    (runs, row_starts)
}

fn find_root(parent: &mut [usize], mut node: usize) -> usize {
    while parent[node] != node {
        parent[node] = parent[parent[node]];
        node = parent[node];
    }
    node
}

/// Groups the runs into blobs: runs of neighbouring rows that touch, diagonally too, belong
/// together. Each blob comes back as the end points of its runs, which is all its outline needs.
fn blobs_of(runs: &[Run], row_starts: &[usize]) -> Vec<Vec<(i32, i32)>> {
    let mut parent: Vec<usize> = (0..runs.len()).collect();
    for rows in row_starts.windows(3) {
        let (above, below) = (rows[0]..rows[1], rows[1]..rows[2]);
        let (mut i, mut j) = (above.start, below.start);
        while i < above.end && j < below.end {
            let (a, b) = (runs[i], runs[j]);
            if a.first <= b.last + 1 && b.first <= a.last + 1 {
                let (root_a, root_b) = (find_root(&mut parent, i), find_root(&mut parent, j));
                if root_a != root_b {
                    parent[root_b] = root_a;
                }
            }
            if a.last < b.last {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    let mut blob_of_root = vec![usize::MAX; runs.len()];
    let mut blobs: Vec<Vec<(i32, i32)>> = Vec::new();
    for (index, run) in runs.iter().enumerate() {
        let root = find_root(&mut parent, index);
        if blob_of_root[root] == usize::MAX {
            blob_of_root[root] = blobs.len();
            blobs.push(Vec::new());
        }
        let blob = &mut blobs[blob_of_root[root]];
        blob.push((run.first as i32, run.y as i32));
        blob.push((run.last as i32, run.y as i32));
    }
    blobs
}

/// The mean answer of the network over the pixels inside the rectangle.
fn mean_inside(map: &[f32], width: usize, height: usize, rect: &RotatedRect) -> f32 {
    let corners = rect.corners();
    let (mut left, mut right, mut top, mut bottom) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for corner in corners {
        left = left.min(corner.x);
        right = right.max(corner.x);
        top = top.min(corner.y);
        bottom = bottom.max(corner.y);
    }
    let first_x = left.floor().max(0.0) as usize;
    let last_x = (right.ceil().max(0.0) as usize).min(width - 1);
    let first_y = top.floor().max(0.0) as usize;
    let last_y = (bottom.ceil().max(0.0) as usize).min(height - 1);
    let (mut sum, mut count) = (0.0f32, 0usize);
    for y in first_y..=last_y {
        for x in first_x..=last_x {
            if rect.contains(Point::new(x as f32, y as f32), 0.01) {
                sum += map[y * width + x];
                count += 1;
            }
        }
    }
    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
}

/// The lines of text on the network's answer: `map` is `width` by `height` values from 0 to 1.
/// Rectangles come back on the map's own pixel grid, not on the picture's.
pub fn find_boxes(
    map: &[f32],
    width: usize,
    height: usize,
    params: &DetectParams,
) -> Vec<RotatedRect> {
    if width == 0 || height == 0 || map.len() != width * height {
        return Vec::new();
    }
    let (runs, row_starts) = text_runs(map, width, height, params.pixel_threshold);
    let mut found = Vec::new();
    for outline in blobs_of(&runs, &row_starts)
        .into_iter()
        .take(params.max_blobs)
    {
        let Some(rect) = min_area_rect(&convex_hull(outline)) else {
            continue;
        };
        if rect.min_side() < params.min_box_side {
            continue;
        }
        let score = mean_inside(map, width, height, &rect);
        if score < params.box_threshold {
            continue;
        }
        let grown = rect.grown(rect.area() * params.unclip_ratio / rect.perimeter());
        if grown.min_side() < params.min_box_side + 2.0 {
            continue;
        }
        found.push(grown);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A map of `width` by `height` that is `inside` within the box (columns `x0..=x1`, rows
    /// `y0..=y1`) and `outside` elsewhere.
    fn map_with_box(
        width: usize,
        height: usize,
        (x0, y0, x1, y1): (usize, usize, usize, usize),
        inside: f32,
        outside: f32,
    ) -> Vec<f32> {
        let mut map = vec![outside; width * height];
        for y in y0..=y1 {
            for x in x0..=x1 {
                map[y * width + x] = inside;
            }
        }
        map
    }

    #[test]
    fn a_picture_is_shown_to_the_network_in_multiples_of_32() {
        let params = DetectParams::default();

        assert_eq!(input_size(1240, 1510, &params), (1248, 1504));
        assert_eq!(input_size(1220, 270, &params), (1216, 256));
        assert_eq!(input_size(1220, 300, &params), (1216, 288));
    }

    #[test]
    fn a_small_picture_is_enlarged_until_its_short_side_reaches_the_minimum() {
        let params = DetectParams::default();

        // 98 x 36: scaled by 160 / 36 = 4.44 to 435 x 160, then rounded to 448 x 160.
        assert_eq!(input_size(98, 36, &params), (448, 160));
        assert_eq!(input_size(8, 8, &params), (160, 160));
    }

    #[test]
    fn a_large_picture_is_shrunk_to_the_longest_side_allowed() {
        let params = DetectParams::default();

        let (width, height) = input_size(2560, 1600, &params);

        assert_eq!((width, height), (1600, 992));
    }

    #[test]
    fn a_very_long_line_keeps_a_readable_scale() {
        let params = DetectParams::default();

        // 3000 x 30 would be 16000 wide after enlarging; the cap brings it back to 1600 wide,
        // which is still 0.53 of the original size.
        let (width, height) = input_size(3000, 30, &params);

        assert_eq!(width, 1600);
        assert_eq!(height, 32);
    }

    #[test]
    fn the_network_input_is_scaled_and_shifted_per_channel() {
        let (scale, bias) = input_scale_and_bias();

        // A mid-grey byte of 124 (0.4863) at the blue mean comes out near zero.
        let blue = 124.0 * scale[0] + bias[0];
        assert!(blue.abs() < 0.01, "{blue}");
        assert!(scale[0] > 0.0 && bias[0] < 0.0);
    }

    #[test]
    fn a_blob_of_text_pixels_becomes_one_grown_box() {
        let map = map_with_box(200, 80, (20, 30, 119, 49), 0.9, 0.0);

        let boxes = find_boxes(&map, 200, 80, &DetectParams::default());

        assert_eq!(boxes.len(), 1);
        let rect = boxes[0];
        // 99 wide, 19 tall on the pixel grid; grown by area * 1.5 / perimeter on every side.
        let grow = 99.0 * 19.0 * 1.5 / (2.0 * (99.0 + 19.0));
        assert!((rect.width.max(rect.height) - (99.0 + 2.0 * grow)).abs() < 0.2);
        assert!((rect.min_side() - (19.0 + 2.0 * grow)).abs() < 0.2);
        assert!((rect.center.x - 69.5).abs() < 0.2 && (rect.center.y - 39.5).abs() < 0.2);
    }

    #[test]
    fn two_blobs_apart_are_two_boxes_and_touching_ones_are_one() {
        let mut map = map_with_box(200, 80, (10, 10, 60, 25), 0.9, 0.0);
        for y in 40..=55 {
            for x in 10..=90 {
                map[y * 200 + x] = 0.9;
            }
        }
        // Diagonal contact: one pixel of a third blob touches the corner of the first.
        map[26 * 200 + 61] = 0.9;
        map[27 * 200 + 62] = 0.9;
        map[28 * 200 + 63] = 0.9;

        let boxes = find_boxes(&map, 200, 80, &DetectParams::default());

        assert_eq!(boxes.len(), 2, "{boxes:?}");
    }

    #[test]
    fn dust_and_unsure_blobs_are_dropped() {
        // Two rows tall is below the minimum side.
        let thin = map_with_box(100, 60, (10, 10, 80, 11), 0.9, 0.0);
        // Big enough but the network is only 0.35 sure of it: above the pixel threshold, below
        // the box threshold.
        let unsure = map_with_box(100, 60, (10, 10, 80, 30), 0.35, 0.0);

        assert!(find_boxes(&thin, 100, 60, &DetectParams::default()).is_empty());
        assert!(find_boxes(&unsure, 100, 60, &DetectParams::default()).is_empty());
    }

    #[test]
    fn a_map_that_does_not_fit_its_size_finds_nothing() {
        assert!(find_boxes(&[0.9; 10], 4, 4, &DetectParams::default()).is_empty());
        assert!(find_boxes(&[], 0, 0, &DetectParams::default()).is_empty());
    }

    #[test]
    fn text_touching_the_edge_of_the_map_is_still_a_box() {
        let map = map_with_box(120, 60, (0, 5, 119, 30), 0.8, 0.0);

        let boxes = find_boxes(&map, 120, 60, &DetectParams::default());

        assert_eq!(boxes.len(), 1);
    }
}
