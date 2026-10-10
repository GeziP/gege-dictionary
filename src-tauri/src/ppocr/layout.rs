//! From lines of text found anywhere on the picture to the text a person would read off it.

/// A line of text and where it is on the picture (pixels): its left edge and its vertical extent.
#[derive(Clone, Debug, PartialEq)]
pub struct TextLine {
    pub text: String,
    pub left: f32,
    pub top: f32,
    pub bottom: f32,
}

impl TextLine {
    fn height(&self) -> f32 {
        self.bottom - self.top
    }

    fn centre_y(&self) -> f32 {
        (self.top + self.bottom) / 2.0
    }
}

/// Whether two lines stand on the same row of the picture: they share more than half of the
/// height of the lower one.
fn same_row(a: &TextLine, b: &TextLine) -> bool {
    let overlap = a.bottom.min(b.bottom) - a.top.max(b.top);
    overlap > 0.5 * a.height().min(b.height())
}

fn is_cjk(character: char) -> bool {
    matches!(character,
        '\u{3000}'..='\u{30FF}' | '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}'
        | '\u{AC00}'..='\u{D7AF}' | '\u{FF00}'..='\u{FFEF}')
}

/// Whether two pieces of text on one row are separated by a space: not when one of them
/// touches Chinese, Japanese or Korean text, which is written without spaces.
fn needs_space(before: &str, after: &str) -> bool {
    let (Some(last), Some(first)) = (before.chars().next_back(), after.chars().next()) else {
        return false;
    };
    !is_cjk(last) && !is_cjk(first)
}

/// The text of the lines in reading order: rows from the top down, the lines of a row from the
/// left to the right (a space apart), and a new line for every row.
pub fn join_lines(mut lines: Vec<TextLine>) -> String {
    lines.retain(|line| !line.text.trim().is_empty());
    lines.sort_by(|a, b| a.centre_y().total_cmp(&b.centre_y()));
    let mut rows: Vec<Vec<TextLine>> = Vec::new();
    for line in lines {
        match rows.last_mut() {
            Some(row) if row.last().is_some_and(|last| same_row(last, &line)) => row.push(line),
            _ => rows.push(vec![line]),
        }
    }
    let mut text = String::new();
    for (index, row) in rows.iter_mut().enumerate() {
        row.sort_by(|a, b| a.left.total_cmp(&b.left));
        if index > 0 {
            text.push('\n');
        }
        let mut row_text = String::new();
        for line in row.iter() {
            let piece = line.text.trim();
            if needs_space(&row_text, piece) {
                row_text.push(' ');
            }
            row_text.push_str(piece);
        }
        text.push_str(&row_text);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, left: f32, top: f32, bottom: f32) -> TextLine {
        TextLine {
            text: text.to_string(),
            left,
            top,
            bottom,
        }
    }

    #[test]
    fn lines_are_read_from_the_top_down_whatever_order_they_were_found_in() {
        let lines = vec![
            line("third", 10.0, 90.0, 110.0),
            line("first", 10.0, 10.0, 30.0),
            line("second", 10.0, 50.0, 70.0),
        ];

        assert_eq!(join_lines(lines), "first\nsecond\nthird");
    }

    #[test]
    fn pieces_on_one_row_are_read_left_to_right_with_a_space() {
        let lines = vec![
            line("View", 200.0, 12.0, 32.0),
            line("File", 10.0, 10.0, 30.0),
            line("Edit", 100.0, 11.0, 31.0),
        ];

        assert_eq!(join_lines(lines), "File Edit View");
    }

    #[test]
    fn chinese_pieces_on_one_row_are_joined_without_a_space() {
        let lines = vec![
            line("世界", 100.0, 10.0, 30.0),
            line("你好", 10.0, 10.0, 30.0),
        ];

        assert_eq!(join_lines(lines), "你好世界");
    }

    #[test]
    fn chinese_next_to_english_is_joined_without_a_space_too() {
        let lines = vec![
            line("鸽鸽词典", 10.0, 10.0, 30.0),
            line("dictionary", 100.0, 10.0, 30.0),
        ];

        assert_eq!(join_lines(lines), "鸽鸽词典dictionary");
    }

    #[test]
    fn lines_that_only_touch_in_height_are_different_rows() {
        let lines = vec![
            line("above", 10.0, 10.0, 30.0),
            line("below", 90.0, 28.0, 48.0),
        ];

        assert_eq!(join_lines(lines), "above\nbelow");
    }

    #[test]
    fn empty_and_blank_lines_are_left_out() {
        let lines = vec![
            line("  ", 10.0, 10.0, 30.0),
            line("kept", 10.0, 50.0, 70.0),
            line("", 10.0, 90.0, 110.0),
        ];

        assert_eq!(join_lines(lines), "kept");
        assert_eq!(join_lines(Vec::new()), "");
    }
}
