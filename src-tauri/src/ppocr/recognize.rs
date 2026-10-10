//! Reading a line of text: how the lines are batched and shown to the recognition network, and how
//! its answer (a probability for every character at every step) becomes text.

use super::resample::{resize_into_planes, Crop, Pixels, Planes};

/// The height every line is scaled to.
pub const HEIGHT: usize = 48;
/// The narrowest picture the network is shown: a shorter line is padded to this width.
pub const MIN_WIDTH: usize = 320;
/// The widest line; a longer one is squeezed to fit.
pub const MAX_WIDTH: usize = 3200;
/// Lines in one batch, at most.
const MAX_BATCH: usize = 16;
/// Width times lines in one batch, at most, so a batch of long lines stays small in memory.
const BATCH_BUDGET: usize = 8000;

/// The width a crop gets when its height is made [`HEIGHT`] and its proportions are kept.
pub fn scaled_width(crop_width: usize, crop_height: usize) -> usize {
    let width = (HEIGHT as f32 * crop_width as f32 / crop_height.max(1) as f32).ceil() as usize;
    width.clamp(1, MAX_WIDTH)
}

/// Some lines read together: the network takes them as one tensor, every line padded to the
/// width of the widest.
#[derive(Debug, PartialEq, Eq)]
pub struct Batch {
    pub members: Vec<usize>,
    pub width: usize,
}

/// Puts lines of similar width together. `widths` are the scaled widths of the lines; the batches
/// name them by position.
pub fn plan_batches(widths: &[usize]) -> Vec<Batch> {
    let mut order: Vec<usize> = (0..widths.len()).collect();
    order.sort_by_key(|&index| widths[index]);
    let mut batches = Vec::new();
    let mut members: Vec<usize> = Vec::new();
    for index in order {
        // The widths ascend, so the line that comes in now is the widest of its batch.
        let width = widths[index].max(MIN_WIDTH);
        if !members.is_empty()
            && (members.len() >= MAX_BATCH || width * (members.len() + 1) > BATCH_BUDGET)
        {
            let widest = widths[members[members.len() - 1]].max(MIN_WIDTH);
            batches.push(Batch {
                members: std::mem::take(&mut members),
                width: widest,
            });
        }
        members.push(index);
    }
    if let Some(&last) = members.last() {
        batches.push(Batch {
            width: widths[last].max(MIN_WIDTH),
            members,
        });
    }
    batches
}

/// Draws a line into its place (`slot`, `3 * HEIGHT * width` values) of a batch tensor: scaled to
/// the network's height, normalised to -1 to 1, and padded with zeros on the right.
pub fn fill_slot(crop: &Crop, scaled_width: usize, width: usize, slot: &mut [f32]) {
    let source = Pixels {
        width: crop.width,
        height: crop.height,
        channels: 3,
        data: &crop.bgr,
    };
    resize_into_planes(
        &source,
        scaled_width.min(width),
        HEIGHT,
        [2.0 / 255.0; 3],
        [-1.0; 3],
        slot,
        Planes {
            row: width,
            plane: HEIGHT * width,
        },
    );
}

/// What each class the network can answer with stands for: class 0 is "nothing here" (the blank
/// of CTC), the following ones are the characters of the dictionary file in order, and the
/// last one is the space.
#[derive(Debug)]
pub struct Dictionary {
    symbols: Vec<String>,
}

impl Dictionary {
    pub fn parse(text: &str) -> Dictionary {
        let mut symbols = vec![String::new()];
        symbols.extend(text.lines().map(str::to_string));
        symbols.push(" ".to_string());
        Dictionary { symbols }
    }

    /// How many classes the network has to answer with for this dictionary.
    pub fn classes(&self) -> usize {
        self.symbols.len()
    }
}

/// Turns the network's answer into text. `scores` holds, for each of `lines` lines, `steps`
/// rows of `classes` probabilities. At each step the likeliest class is taken; a class that
/// repeats the one before it, and the blank, add nothing. The confidence of a line is the mean
/// probability of the classes that were kept.
pub fn decode(
    scores: &[f32],
    lines: usize,
    steps: usize,
    classes: usize,
    dictionary: &Dictionary,
) -> Vec<(String, f32)> {
    if classes == 0 || steps == 0 || scores.len() < lines * steps * classes {
        return vec![(String::new(), 0.0); lines];
    }
    (0..lines)
        .map(|line| {
            let rows = &scores[line * steps * classes..(line + 1) * steps * classes];
            let mut text = String::new();
            let (mut confidence, mut kept, mut previous) = (0.0f32, 0usize, 0usize);
            for row in rows.chunks_exact(classes) {
                let (best, probability) = row.iter().enumerate().fold(
                    (0usize, f32::MIN),
                    |(best, high), (class, &value)| {
                        if value > high {
                            (class, value)
                        } else {
                            (best, high)
                        }
                    },
                );
                if best != 0 && best != previous {
                    if let Some(symbol) = dictionary.symbols.get(best) {
                        text.push_str(symbol);
                        confidence += probability;
                        kept += 1;
                    }
                }
                previous = best;
            }
            let mean = if kept == 0 {
                0.0
            } else {
                confidence / kept as f32
            };
            (text, mean)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dictionary() -> Dictionary {
        Dictionary::parse("a\nb\nc\n")
    }

    /// One line of answers: a probability row for every class, 1.0 at the class given.
    fn answer(classes: usize, picks: &[usize]) -> Vec<f32> {
        let mut scores = Vec::new();
        for &pick in picks {
            let mut row = vec![0.01; classes];
            row[pick] = 0.9;
            scores.extend(row);
        }
        scores
    }

    #[test]
    fn the_dictionary_has_a_blank_in_front_and_a_space_behind() {
        let dictionary = dictionary();

        assert_eq!(dictionary.classes(), 5);
        assert_eq!(dictionary.symbols, vec!["", "a", "b", "c", " "]);
    }

    #[test]
    fn a_dictionary_line_that_is_a_space_is_kept() {
        let dictionary = Dictionary::parse("x\r\n \r\ny\r\n");

        assert_eq!(dictionary.symbols, vec!["", "x", " ", "y", " "]);
    }

    #[test]
    fn repeats_and_blanks_between_steps_collapse_into_the_characters() {
        // a a _ a b b _ c  ->  "a" then "a" again (a blank came between) then "b" "c"
        let scores = answer(5, &[1, 1, 0, 1, 2, 2, 0, 3]);

        let decoded = decode(&scores, 1, 8, 5, &dictionary());

        assert_eq!(decoded[0].0, "aabc");
        assert!((decoded[0].1 - 0.9).abs() < 1e-6);
    }

    #[test]
    fn a_line_of_blanks_reads_as_nothing() {
        let scores = answer(5, &[0, 0, 0, 0]);

        let decoded = decode(&scores, 1, 4, 5, &dictionary());

        assert_eq!(decoded, vec![(String::new(), 0.0)]);
    }

    #[test]
    fn the_last_class_is_the_space() {
        let scores = answer(5, &[1, 4, 2]);

        let decoded = decode(&scores, 1, 3, 5, &dictionary());

        assert_eq!(decoded[0].0, "a b");
    }

    #[test]
    fn every_line_of_a_batch_is_read_on_its_own() {
        let mut scores = answer(5, &[1, 2]);
        scores.extend(answer(5, &[3, 0]));

        let decoded = decode(&scores, 2, 2, 5, &dictionary());

        assert_eq!(decoded[0].0, "ab");
        assert_eq!(decoded[1].0, "c");
    }

    #[test]
    fn an_answer_that_is_too_short_for_its_shape_reads_as_nothing() {
        let decoded = decode(&[0.5; 7], 2, 2, 5, &dictionary());

        assert_eq!(decoded.len(), 2);
        assert!(decoded.iter().all(|(text, _)| text.is_empty()));
    }

    #[test]
    fn a_crop_is_scaled_to_the_network_height_keeping_its_proportions() {
        assert_eq!(scaled_width(200, 24), 400);
        assert_eq!(scaled_width(100, 48), 100);
        assert_eq!(scaled_width(1, 100), 1);
        assert_eq!(scaled_width(100_000, 10), MAX_WIDTH);
    }

    #[test]
    fn lines_of_similar_width_share_a_batch_and_it_is_as_wide_as_the_widest() {
        let widths = [400, 100, 900, 380, 120];

        let batches = plan_batches(&widths);

        assert_eq!(
            batches,
            vec![Batch {
                members: vec![1, 4, 3, 0, 2],
                width: 900
            }]
        );
    }

    #[test]
    fn no_line_is_read_narrower_than_the_minimum_width() {
        let batches = plan_batches(&[40, 60]);

        assert_eq!(batches[0].width, MIN_WIDTH);
    }

    #[test]
    fn a_batch_of_wide_lines_is_kept_small() {
        // Each line is 3000 wide; 8000 / 3000 leaves room for two.
        let batches = plan_batches(&[3000; 5]);

        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].members.len(), 2);
        assert!(batches.iter().all(|batch| batch.width == 3000));
    }

    #[test]
    fn a_batch_never_holds_more_than_the_limit_of_lines() {
        let batches = plan_batches(&[100; 40]);

        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].members.len(), MAX_BATCH);
        assert_eq!(
            batches
                .iter()
                .map(|batch| batch.members.len())
                .sum::<usize>(),
            40
        );
    }

    #[test]
    fn nothing_to_read_makes_no_batch() {
        assert!(plan_batches(&[]).is_empty());
    }

    #[test]
    fn a_line_fills_its_slot_and_leaves_the_padding_alone() {
        // A white crop, 96 x 48: scaled width 96, in a slot 320 wide.
        let crop = Crop {
            width: 96,
            height: 48,
            bgr: vec![255; 96 * 48 * 3],
        };
        let mut slot = vec![0.0f32; 3 * HEIGHT * 320];

        fill_slot(&crop, 96, 320, &mut slot);

        // White is 1.0 after normalisation, in all three planes.
        for plane in 0..3 {
            let first_row = plane * HEIGHT * 320;
            assert!((slot[first_row] - 1.0).abs() < 1e-4);
            assert!((slot[first_row + 95] - 1.0).abs() < 1e-4);
            assert_eq!(slot[first_row + 96], 0.0);
            assert_eq!(slot[first_row + 319], 0.0);
        }
    }
}
