//! How an answer moves a card between the three review boxes.
//!
//! The rules are pure functions so that they can be tested without a database; the database
//! applies what they decide, in one transaction, in `Database::submit_review`.

/// How well the user knew a card when it came up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Did not know it.
    Wrong,
    /// Knew it, but only just.
    Hard,
    /// Knew it.
    Correct,
}

impl Answer {
    /// The word stored as `review_state.last_result` and sent with the `review_card_answered`
    /// event. `correct` and `wrong` are what every earlier version wrote.
    pub fn as_str(self) -> &'static str {
        match self {
            Answer::Wrong => "wrong",
            Answer::Hard => "hard",
            Answer::Correct => "correct",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "wrong" => Some(Answer::Wrong),
            "hard" => Some(Answer::Hard),
            "correct" => Some(Answer::Correct),
            _ => None,
        }
    }
}

/// The highest box; a card that gets there counts as mastered.
pub const LAST_BOX: i64 = 3;

/// Where a card goes after an answer.
#[derive(Debug, PartialEq, Eq)]
pub struct Step {
    pub next_box: i64,
    /// Days until the card is due again.
    pub days: i64,
    /// How well the word is known in the library, which follows the box.
    pub mastery: &'static str,
}

/// A right answer moves the card up a box, and the higher the box the longer the wait. A wrong
/// one sends it back to the first box. A hard one keeps it where it is but brings it back
/// tomorrow: it was not forgotten, so it does not start over, and it was not easy, so it does
/// not get the longer wait of the next box.
pub fn schedule(current_box: i64, answer: Answer) -> Step {
    let current = current_box.clamp(1, LAST_BOX);
    let next_box = match answer {
        Answer::Correct => (current + 1).min(LAST_BOX),
        Answer::Hard => current,
        Answer::Wrong => 1,
    };
    let days = match (answer, next_box) {
        (Answer::Hard, _) | (_, 1) => 1,
        (_, 2) => 3,
        _ => 7,
    };
    let mastery = match next_box {
        1 => "new",
        2 => "learning",
        _ => "mastered",
    };
    Step {
        next_box,
        days,
        mastery,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(current_box: i64, answer: Answer) -> (i64, i64, &'static str) {
        let step = schedule(current_box, answer);
        (step.next_box, step.days, step.mastery)
    }

    #[test]
    fn a_right_answer_moves_the_card_up_and_waits_longer() {
        assert_eq!(step(1, Answer::Correct), (2, 3, "learning"));
        assert_eq!(step(2, Answer::Correct), (3, 7, "mastered"));
        assert_eq!(
            step(3, Answer::Correct),
            (3, 7, "mastered"),
            "there is no box above the last one"
        );
    }

    #[test]
    fn a_wrong_answer_starts_over_from_any_box() {
        for current in 1..=3 {
            assert_eq!(
                step(current, Answer::Wrong),
                (1, 1, "new"),
                "from box {current}"
            );
        }
    }

    #[test]
    fn a_hard_answer_keeps_the_box_and_comes_back_tomorrow() {
        assert_eq!(step(1, Answer::Hard), (1, 1, "new"));
        assert_eq!(step(2, Answer::Hard), (2, 1, "learning"));
        assert_eq!(
            step(3, Answer::Hard),
            (3, 1, "mastered"),
            "it is not forgotten, so it is still known"
        );
    }

    #[test]
    fn a_box_that_does_not_exist_is_read_as_the_nearest_one() {
        assert_eq!(step(0, Answer::Correct), (2, 3, "learning"));
        assert_eq!(step(-4, Answer::Hard), (1, 1, "new"));
        assert_eq!(step(9, Answer::Hard), (3, 1, "mastered"));
    }

    #[test]
    fn an_answer_is_written_and_read_back_as_the_same_word() {
        for answer in [Answer::Wrong, Answer::Hard, Answer::Correct] {
            assert_eq!(Answer::parse(answer.as_str()), Some(answer));
        }
        // What every earlier version wrote is still what is written.
        assert_eq!(Answer::Correct.as_str(), "correct");
        assert_eq!(Answer::Wrong.as_str(), "wrong");
    }

    #[test]
    fn anything_else_is_not_an_answer() {
        for text in ["", "Correct", " hard", "easy", "true", "1"] {
            assert_eq!(Answer::parse(text), None, "{text:?}");
        }
    }
}
