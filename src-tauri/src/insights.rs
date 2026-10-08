//! The numbers behind the learning-insights page. The database supplies plain facts (on which
//! days something happened); everything that takes thought lives here as pure functions, so it
//! can be tested without a clock or a database.

use crate::review::Answer;
use chrono::{DateTime, Datelike, Days, Local, NaiveDate, NaiveDateTime};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// How many of something happened on each local calendar day.
pub type PerDay = BTreeMap<NaiveDate, i64>;

/// What happened on which day, as far as the database knows.
#[derive(Default)]
pub struct Facts {
    /// Lookups that got an answer, from the model or from the cache.
    pub lookups: PerDay,
    /// Words added to the library.
    pub saved: PerDay,
    /// Review cards answered.
    pub reviews: PerDay,
}

/// How the review cards answered on one day were answered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Answers {
    pub correct: i64,
    pub hard: i64,
    pub wrong: i64,
    /// Answers whose kind was not recorded, or is not one this version knows, so that the
    /// parts still add up to everything that was answered.
    pub other: i64,
}

impl Answers {
    pub fn total(&self) -> i64 {
        self.correct + self.hard + self.wrong + self.other
    }

    pub fn add(&mut self, answer: Option<Answer>, count: i64) {
        match answer {
            Some(Answer::Correct) => self.correct += count,
            Some(Answer::Hard) => self.hard += count,
            Some(Answer::Wrong) => self.wrong += count,
            None => self.other += count,
        }
    }
}

/// The answer a `review_card_answered` event stands for, from the `extra` it was stored with.
pub fn answer_of(extra: &str) -> Option<Answer> {
    serde_json::from_str::<Value>(extra)
        .ok()?
        .get("result")?
        .as_str()
        .and_then(Answer::parse)
}

/// How many weeks the review calendar shows. Local events are kept for 90 days, and twelve
/// weeks are at most 84, so the calendar never has days that were forgotten.
pub const CALENDAR_WEEKS: u32 = 12;

/// A calendar of the review cards answered, one entry for every day from the Monday `weeks - 1`
/// weeks before this week's up to `today`, zeros included. Being weeks of seven days from a
/// Monday, the days go straight into columns of a grid.
pub fn review_calendar(
    today: NaiveDate,
    answers: &BTreeMap<NaiveDate, Answers>,
    weeks: u32,
) -> Value {
    let weeks = weeks.max(1);
    let this_monday = today
        .checked_sub_days(Days::new(u64::from(today.weekday().num_days_from_monday())))
        .unwrap_or(today);
    let first = this_monday
        .checked_sub_days(Days::new(u64::from(weeks - 1) * 7))
        .unwrap_or(this_monday);

    let mut days = Vec::new();
    let mut day = first;
    while day <= today {
        let counted = answers.get(&day).copied().unwrap_or_default();
        days.push(json!({
            "date": day_key(day),
            "total": counted.total(),
            "correct": counted.correct,
            "hard": counted.hard,
            "wrong": counted.wrong,
        }));
        match day.succ_opt() {
            Some(next) => day = next,
            None => break,
        }
    }
    json!({ "first": day_key(first), "weeks": weeks, "days": days })
}

impl Facts {
    /// The days on which the user did anything at all.
    fn active_days(&self) -> BTreeSet<NaiveDate> {
        [&self.lookups, &self.saved, &self.reviews]
            .into_iter()
            .flat_map(|per_day| per_day.iter())
            .filter(|(_, count)| **count > 0)
            .map(|(day, _)| *day)
            .collect()
    }
}

pub fn day_key(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

/// The local calendar day a stored timestamp falls on. The front end writes RFC 3339 times in
/// UTC, imports may carry a local offset, and SQLite's own `datetime('now')` is
/// `YYYY-MM-DD HH:MM:SS` in UTC. Anything else that starts with a date counts as that date.
pub fn local_day(timestamp: &str) -> Option<NaiveDate> {
    let text = timestamp.trim();
    if let Ok(time) = DateTime::parse_from_rfc3339(text) {
        return Some(time.with_timezone(&Local).date_naive());
    }
    if let Ok(time) = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S") {
        return Some(time.and_utc().with_timezone(&Local).date_naive());
    }
    text.get(..10)
        .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
}

#[derive(Debug, PartialEq, Eq)]
pub struct Streaks {
    /// Consecutive active days up to today. A day that is not over yet cannot break the run, so
    /// when today has no activity the run that ended yesterday still counts.
    pub current: u32,
    /// The longest run there ever was.
    pub longest: u32,
    pub active_days: u32,
}

/// Runs of consecutive active days. Days after `today` (a clock that was wrong once) are ignored.
pub fn streaks(active: &BTreeSet<NaiveDate>, today: NaiveDate) -> Streaks {
    let mut longest = 0;
    let mut run = 0;
    let mut previous: Option<NaiveDate> = None;
    let mut active_days = 0;
    for day in active.range(..=today) {
        active_days += 1;
        run = match previous {
            Some(before) if before.succ_opt() == Some(*day) => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        previous = Some(*day);
    }

    let mut cursor = if active.contains(&today) {
        Some(today)
    } else {
        today.pred_opt().filter(|day| active.contains(day))
    };
    let mut current = 0;
    while let Some(day) = cursor {
        current += 1;
        cursor = day.pred_opt().filter(|before| active.contains(before));
    }

    Streaks {
        current,
        longest,
        active_days,
    }
}

fn count_on(per_day: &PerDay, day: NaiveDate) -> i64 {
    per_day.get(&day).copied().unwrap_or(0)
}

/// The activity chart and the streak: one point for each of the last `days` days (oldest first,
/// days without anything included as zeros), their sums, and how many words were saved in the
/// last seven days.
pub fn activity(days: u32, today: NaiveDate, facts: &Facts) -> Value {
    let days = days.max(1);
    let first = today
        .checked_sub_days(Days::new(u64::from(days - 1)))
        .unwrap_or(today);

    let mut daily = Vec::new();
    let (mut lookups, mut saved, mut reviews) = (0, 0, 0);
    for offset in 0..days {
        let Some(day) = first.checked_add_days(Days::new(u64::from(offset))) else {
            break;
        };
        let (looked_up, kept, answered) = (
            count_on(&facts.lookups, day),
            count_on(&facts.saved, day),
            count_on(&facts.reviews, day),
        );
        lookups += looked_up;
        saved += kept;
        reviews += answered;
        daily.push(json!({
            "date": day_key(day),
            "lookups": looked_up,
            "saved": kept,
            "reviews": answered,
        }));
    }

    let week_start = today.checked_sub_days(Days::new(6)).unwrap_or(today);
    let saved_this_week: i64 = facts.saved.range(week_start..=today).map(|(_, n)| *n).sum();
    let streak = streaks(&facts.active_days(), today);

    json!({
        "daily": daily,
        "window": { "lookups": lookups, "saved": saved, "reviews": reviews },
        "savedThisWeek": saved_this_week,
        "streak": {
            "current": streak.current,
            "longest": streak.longest,
            "activeDays": streak.active_days,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{SecondsFormat, TimeZone, Utc};

    fn day(year: i32, month: u32, date: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, date).unwrap()
    }

    fn days(list: &[(i32, u32, u32)]) -> BTreeSet<NaiveDate> {
        list.iter().map(|(y, m, d)| day(*y, *m, *d)).collect()
    }

    /// Noon on the given local day: far from midnight, so every way of writing it down in
    /// UTC or with an offset still falls on the same local day, wherever the tests run.
    fn noon(date: NaiveDate) -> DateTime<Local> {
        Local
            .from_local_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
            .earliest()
            .unwrap()
    }

    #[test]
    fn a_stored_time_is_read_as_the_local_day_it_falls_on() {
        let target = day(2026, 10, 7);
        let at = noon(target);
        assert_eq!(
            local_day(&at.to_rfc3339()),
            Some(target),
            "with a local offset"
        );
        let utc = at.with_timezone(&Utc);
        assert_eq!(
            local_day(&utc.to_rfc3339_opts(SecondsFormat::Millis, true)),
            Some(target),
            "as the front end writes it"
        );
        assert_eq!(
            local_day(&utc.format("%Y-%m-%d %H:%M:%S").to_string()),
            Some(target),
            "as SQLite writes it"
        );
        assert_eq!(local_day(" 2026-10-07 "), Some(target), "a plain date");
        assert_eq!(
            local_day("2026-10-07T99:99"),
            Some(target),
            "a date with junk after it"
        );
    }

    #[test]
    fn a_time_that_cannot_be_read_is_not_guessed() {
        assert_eq!(local_day(""), None);
        assert_eq!(local_day("yesterday"), None);
        assert_eq!(local_day("not a date at all"), None);
        assert_eq!(
            local_day("去年十月七号的下午"),
            None,
            "and cutting text never splits a character"
        );
    }

    #[test]
    fn nothing_done_means_no_streak() {
        let streak = streaks(&BTreeSet::new(), day(2026, 10, 7));
        assert_eq!(
            streak,
            Streaks {
                current: 0,
                longest: 0,
                active_days: 0
            }
        );
    }

    #[test]
    fn the_current_streak_counts_back_from_today() {
        let active = days(&[(2026, 10, 3), (2026, 10, 5), (2026, 10, 6), (2026, 10, 7)]);
        let streak = streaks(&active, day(2026, 10, 7));
        assert_eq!(
            (streak.current, streak.longest, streak.active_days),
            (3, 3, 4)
        );
    }

    #[test]
    fn a_day_that_is_not_over_does_not_break_the_streak() {
        let active = days(&[(2026, 10, 4), (2026, 10, 5), (2026, 10, 6)]);
        let streak = streaks(&active, day(2026, 10, 7));
        assert_eq!(
            streak.current, 3,
            "yesterday's run is still alive this morning"
        );
    }

    #[test]
    fn a_missed_day_ends_the_streak_but_not_the_record() {
        let active = days(&[
            (2026, 9, 20),
            (2026, 9, 21),
            (2026, 9, 22),
            (2026, 9, 23),
            (2026, 10, 5),
        ]);
        let streak = streaks(&active, day(2026, 10, 7));
        assert_eq!((streak.current, streak.longest), (0, 4));
    }

    #[test]
    fn runs_cross_month_and_year_boundaries() {
        let active = days(&[(2025, 12, 30), (2025, 12, 31), (2026, 1, 1), (2026, 1, 2)]);
        assert_eq!(streaks(&active, day(2026, 1, 2)).current, 4);
    }

    #[test]
    fn days_after_today_are_ignored() {
        let active = days(&[(2026, 10, 7), (2026, 10, 8), (2026, 10, 9)]);
        let streak = streaks(&active, day(2026, 10, 7));
        assert_eq!(
            (streak.current, streak.longest, streak.active_days),
            (1, 1, 1)
        );
    }

    fn facts() -> Facts {
        let mut facts = Facts::default();
        facts.lookups.insert(day(2026, 10, 7), 5);
        facts.lookups.insert(day(2026, 10, 5), 2);
        facts.lookups.insert(day(2026, 9, 1), 40); // outside a 30-day window
        facts.saved.insert(day(2026, 10, 7), 2);
        facts.saved.insert(day(2026, 9, 30), 1); // seven days back: not "this week"
        facts.saved.insert(day(2026, 10, 2), 3);
        facts.reviews.insert(day(2026, 10, 6), 4);
        facts
    }

    #[test]
    fn the_chart_has_a_point_for_every_day_with_zeros_where_nothing_happened() {
        let result = activity(7, day(2026, 10, 7), &facts());
        let daily = result["daily"].as_array().unwrap();
        assert_eq!(daily.len(), 7);
        assert_eq!(daily[0]["date"], "2026-10-01", "oldest first");
        assert_eq!(daily[6]["date"], "2026-10-07");
        assert_eq!(daily[3]["lookups"], 0);
        assert_eq!(daily[3]["saved"], 0);
        assert_eq!(daily[6]["lookups"], 5);
        assert_eq!(daily[6]["saved"], 2);
        assert_eq!(daily[5]["reviews"], 4);
    }

    #[test]
    fn the_window_sums_only_what_is_in_the_window() {
        let week = activity(7, day(2026, 10, 7), &facts());
        assert_eq!(
            week["window"],
            json!({"lookups": 7, "saved": 5, "reviews": 4})
        );
        let month = activity(30, day(2026, 10, 7), &facts());
        assert_eq!(
            month["window"]["lookups"], 7,
            "the 1st of September is 36 days back"
        );
        assert_eq!(month["window"]["saved"], 6, "the 30th of September is in");
        let quarter = activity(90, day(2026, 10, 7), &facts());
        assert_eq!(quarter["window"]["lookups"], 47);
    }

    #[test]
    fn saved_this_week_is_the_last_seven_days_including_today() {
        let result = activity(30, day(2026, 10, 7), &facts());
        assert_eq!(
            result["savedThisWeek"], 5,
            "the 2nd and the 7th; the 30th is a day too early"
        );
    }

    #[test]
    fn the_streak_counts_any_kind_of_activity() {
        // Lookups on the 5th and 7th, a review on the 6th: three days in a row.
        let result = activity(30, day(2026, 10, 7), &facts());
        assert_eq!(result["streak"]["current"], 3);
        assert_eq!(result["streak"]["longest"], 3);
    }

    #[test]
    fn a_window_is_at_least_one_day() {
        let result = activity(0, day(2026, 10, 7), &facts());
        assert_eq!(result["daily"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_answer_is_read_from_the_extra_of_its_event() {
        assert_eq!(answer_of(r#"{"result":"correct"}"#), Some(Answer::Correct));
        assert_eq!(answer_of(r#"{"result":"hard"}"#), Some(Answer::Hard));
        assert_eq!(answer_of(r#"{"result":"wrong"}"#), Some(Answer::Wrong));
        for unknown in [
            "",
            "{}",
            "[]",
            "null",
            "not json",
            r#"{"result":"easy"}"#,
            r#"{"result":3}"#,
        ] {
            assert_eq!(answer_of(unknown), None, "{unknown:?}");
        }
    }

    #[test]
    fn the_answers_of_a_day_add_up() {
        let mut answers = Answers::default();
        answers.add(Some(Answer::Correct), 5);
        answers.add(Some(Answer::Hard), 2);
        answers.add(Some(Answer::Wrong), 1);
        answers.add(None, 4);
        assert_eq!(
            answers,
            Answers {
                correct: 5,
                hard: 2,
                wrong: 1,
                other: 4
            }
        );
        assert_eq!(answers.total(), 12);
    }

    #[test]
    fn the_calendar_starts_on_a_monday_and_ends_today() {
        // Wednesday the 7th of October: this week began on Monday the 5th.
        let calendar = review_calendar(day(2026, 10, 7), &BTreeMap::new(), 12);
        let days = calendar["days"].as_array().unwrap();
        assert_eq!(calendar["first"], "2026-07-20");
        assert_eq!(calendar["weeks"], 12);
        assert_eq!(days.len(), 11 * 7 + 3);
        assert_eq!(days[0]["date"], "2026-07-20");
        assert_eq!(
            days[77]["date"], "2026-10-05",
            "this week's Monday begins the last column"
        );
        assert_eq!(days[79]["date"], "2026-10-07");
    }

    #[test]
    fn the_calendar_is_as_long_as_the_weeks_it_covers() {
        let length = |today: NaiveDate, weeks: u32| {
            review_calendar(today, &BTreeMap::new(), weeks)["days"]
                .as_array()
                .unwrap()
                .len()
        };
        assert_eq!(
            length(day(2026, 10, 11), 12),
            12 * 7,
            "a Sunday ends its week"
        );
        assert_eq!(
            length(day(2026, 10, 5), 12),
            11 * 7 + 1,
            "a Monday begins one"
        );
        assert_eq!(length(day(2026, 10, 7), 1), 3);
        assert_eq!(
            review_calendar(day(2026, 10, 7), &BTreeMap::new(), 0)["weeks"],
            1,
            "there is always this week"
        );
        assert!(
            length(day(2026, 10, 11), CALENDAR_WEEKS) <= 90,
            "never beyond what the local events keep"
        );
    }

    #[test]
    fn the_calendar_puts_the_answers_of_each_day_on_that_day() {
        let mut answers = BTreeMap::new();
        answers.insert(
            day(2026, 10, 6),
            Answers {
                correct: 3,
                hard: 2,
                wrong: 1,
                other: 1,
            },
        );
        answers.insert(
            day(2026, 7, 20),
            Answers {
                correct: 1,
                ..Answers::default()
            },
        );
        // A day too early for the calendar, and tomorrow (a clock that was wrong once).
        for outside in [day(2026, 7, 19), day(2026, 10, 8)] {
            answers.insert(
                outside,
                Answers {
                    correct: 9,
                    ..Answers::default()
                },
            );
        }

        let calendar = review_calendar(day(2026, 10, 7), &answers, 12);
        let days = calendar["days"].as_array().unwrap();
        assert_eq!(
            days[78],
            json!({"date": "2026-10-06", "total": 7, "correct": 3, "hard": 2, "wrong": 1}),
            "answers of an unknown kind count in the total only"
        );
        assert_eq!(days[0]["total"], 1, "the first day is in");
        assert_eq!(
            days[79]["total"], 0,
            "a day without answers is a zero, not a gap"
        );
        assert!(days
            .iter()
            .all(|entry| entry["date"] != "2026-07-19" && entry["date"] != "2026-10-08"));
    }
}
