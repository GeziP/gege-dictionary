//! Batch enrichment: filling in the senses and examples of the words that were imported with
//! nothing but a form and a meaning.
//!
//! What it does is easy to say and easy to get wrong, so the rules live here, away from the window
//! and the database, where they can be tested:
//!
//! - A word is *bare* when it has neither senses nor examples. What the user wrote (the meaning
//!   they imported, a note, tags, mastery, review progress) is never replaced: the answer of the
//!   model only fills what is empty.
//! - The words are asked one at a time, at the pace the user chose, and only while the day's token
//!   use stays within the limit the user set.
//! - A run can be paused, resumed and stopped. Nothing needs saving to "resume later": every word
//!   is stored as soon as it is answered, so what is still bare *is* what is left to do. That is
//!   also why a run that was cut short by a closed app, a spent budget or a failing service is
//!   continued by simply starting again.
//! - A failure that every further word would share (a wrong key, no such model, a service that
//!   keeps refusing) ends the run. A failure that belongs to one word does not, unless it happens
//!   to several in a row, which means it is not about the words after all.

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

use crate::{llm, lookup, AppState};

/// What the day's token use may grow to by the batch, when the user has not said.
pub const DEFAULT_DAILY_TOKENS: u64 = 100_000;
/// Below this a limit would stop the batch before its first word; it is read as not set.
const MIN_DAILY_TOKENS: u64 = 1_000;
/// What one word is expected to cost until the run has seen what one costs.
const FIRST_GUESS_TOKENS: u64 = 1_500;
/// Words in a row that fail, after which the run ends: something is wrong that is not the words.
const FAILURES_IN_A_ROW: usize = 5;
/// The failed words a run remembers by name. The count is kept in full.
const FAILURES_KEPT: usize = 50;
/// How the window hears of a run's progress.
pub const PROGRESS_EVENT: &str = "enrichment://progress";

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

fn has_no_items(word: &Value, key: &str) -> bool {
    word.get(key)
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
}

/// Whether a word is known by nothing but its form and its meaning: no senses and no examples.
/// Only words and phrases are: a saved sentence or paragraph has no senses to give. The database
/// asks the same question in SQL (`BARE_WORDS_SQL`), and a test holds the two to each other.
pub fn is_bare(word: &Value) -> bool {
    // A word whose kind was never said is a word, as everywhere else in the app.
    let kind = word
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .unwrap_or("word");
    matches!(kind, "word" | "phrase")
        && has_no_items(word, "senses")
        && has_no_items(word, "examples")
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(fields)) => fields.is_empty(),
        Some(_) => false,
    }
}

/// What a model answers that is added to a word where the word has nothing.
const FILLED_FIELDS: [&str; 11] = [
    "pos",
    "ipaUS",
    "ipaUK",
    "translation",
    "contextMeaning",
    "explanation",
    "senses",
    "associations",
    "examples",
    "collocations",
    "domainAnalysis",
];

/// `word` with what `answer` says added wherever the word has nothing of its own. Anything the
/// word already says stays exactly as it is: the meaning that was imported, the note, the tags,
/// the mastery, the lemma, where and when it was saved. The word keeps its own lemma even when the
/// model answers with another form of it.
///
/// When something was added, the word also says which model wrote it.
pub fn fill_gaps(word: &Value, answer: &Value) -> Value {
    let (Some(own), Some(given)) = (word.as_object(), answer.as_object()) else {
        return word.clone();
    };
    let mut filled = own.clone();
    let mut added = false;
    for key in FILLED_FIELDS {
        if is_blank(filled.get(key)) && !is_blank(given.get(key)) {
            filled.insert(key.to_string(), given[key].clone());
            added = true;
        }
    }
    // An imported word is "neutral" because nobody said otherwise; the model's reading is better.
    let register_unsaid = matches!(
        filled.get("register").and_then(Value::as_str),
        None | Some("") | Some("neutral")
    );
    if register_unsaid && !is_blank(given.get("register")) && given["register"] != "neutral" {
        filled.insert("register".to_string(), given["register"].clone());
        added = true;
    }
    if added {
        for key in ["_model", "_templateName"] {
            if !is_blank(given.get(key)) {
                filled.insert(key.to_string(), given[key].clone());
            }
        }
        if given.get("_viaBackup") == Some(&Value::Bool(true)) {
            filled.insert("_viaBackup".to_string(), Value::Bool(true));
        } else {
            filled.remove("_viaBackup");
        }
    }
    Value::Object(filled)
}

/// What became of a word that was given an answer (see `Database::fill_in_word`).
#[derive(Debug, PartialEq)]
pub enum Filled {
    /// The word as it is stored now.
    Done(Box<Value>),
    /// It was deleted in the meantime.
    Gone,
    /// It has senses or examples by now, from a lookup or an earlier run.
    NotBare,
}

/// One word waiting for its turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub lemma: String,
}

// ---------------------------------------------------------------------------
// What the user chose
// ---------------------------------------------------------------------------

/// How many tokens the day's use may grow to by the batch; `None` when the user chose no limit.
/// A value that is missing or makes no sense is the default, not no limit: a limit that quietly
/// disappears is the worse mistake.
pub fn daily_token_limit(settings: &Value) -> Option<u64> {
    match settings.get("enrichDailyTokens").and_then(Value::as_u64) {
        Some(0) => None,
        Some(tokens) if tokens >= MIN_DAILY_TOKENS => Some(tokens),
        _ => Some(DEFAULT_DAILY_TOKENS),
    }
}

/// The time between two requests: gentle, normal (the default) or fast.
pub fn pace(settings: &Value) -> Duration {
    match settings.get("enrichPace").and_then(Value::as_str) {
        Some("gentle") => Duration::from_secs(6),
        Some("fast") => Duration::from_millis(1_500),
        _ => Duration::from_secs(3),
    }
}

/// How a run goes about its words.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The least time between the starts of two requests.
    pub interval: Duration,
    /// The most the day's tokens may grow to, if there is a limit.
    pub daily_limit: Option<u64>,
    /// One second of waiting in the schedule of retries; shorter in tests.
    pub backoff: Duration,
}

impl Plan {
    pub fn from_settings(settings: &Value) -> Self {
        Self {
            interval: pace(settings),
            daily_limit: daily_token_limit(settings),
            backoff: Duration::from_secs(1),
        }
    }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/// A request that did not give an answer: its error code and the message that carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    /// The whole `[code] detail` message, so that the window can explain it as it does a lookup.
    pub message: String,
}

impl Failure {
    pub fn from_message(raw: &str) -> Self {
        let message = lookup::classify_lookup_error(raw);
        let code = llm::error_code(&message).unwrap_or("unknown").to_string();
        Self { code, message }
    }
}

/// How long to wait before asking again after the `retries_so_far`-th failure with `code`, or
/// `None` when asking again would not help. A busy service is given time; one that is failing or
/// slow is given a little; the rest is not about timing.
fn retry_wait(code: &str, retries_so_far: usize, unit: Duration) -> Option<Duration> {
    let schedule: &[u32] = match code {
        "rate_limit" => &[10, 30, 90],
        "server" | "timeout" | "network" => &[3, 10],
        _ => &[],
    };
    schedule.get(retries_so_far).map(|seconds| unit * *seconds)
}

/// Failures that every further word would meet as well, so the run ends at the first of them.
/// (A service that keeps saying "too many requests" has been given its time already by then.)
fn ends_the_run(code: &str) -> bool {
    matches!(code, "no_key" | "auth" | "model" | "rate_limit")
}

// ---------------------------------------------------------------------------
// A run and what it reports
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    /// Nothing has been started since the app was.
    #[default]
    Idle,
    Running,
    Paused,
    /// The user stopped it, and the request that is on its way is still being waited for. The
    /// run is not over until then, so another cannot start yet.
    Stopping,
    /// Every word of the run has had its turn.
    Finished,
    /// Ended before that: by the user, or for the reason given with it.
    Stopped,
}

/// Why a run ended early, other than because the user said so.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopReason {
    /// An error code of the model service (`auth`, `rate_limit`, ...), or `budget`, or `repeated`
    /// for words that kept failing, whatever the cause.
    pub code: String,
    pub message: String,
}

impl StopReason {
    fn budget(used: u64, limit: u64) -> Self {
        Self {
            code: "budget".into(),
            message: format!("今天已用约 {used} tokens，再补全一个词会超过 {limit} 的上限"),
        }
    }

    fn repeated(last: &Failure) -> Self {
        Self {
            code: "repeated".into(),
            message: last.message.clone(),
        }
    }

    fn of(failure: &Failure) -> Self {
        Self {
            code: failure.code.clone(),
            message: failure.message.clone(),
        }
    }
}

/// A word that could not be filled in, and why.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WordFailure {
    pub lemma: String,
    pub code: String,
    pub message: String,
}

/// Where a run stands. This is what the window shows.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Which run this is since the app was started, counting from 1 (0: none yet). Lets the
    /// window tell the run it has already shown the end of from the next.
    pub run: u64,
    pub state: RunState,
    /// The words the run set out to do.
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    /// Words that did not need it by their turn: deleted, or no longer bare.
    pub skipped: usize,
    /// Estimated tokens this run has spent.
    pub tokens: u64,
    /// The word being asked about.
    pub current: Option<String>,
    pub stopped_because: Option<StopReason>,
    pub failures: Vec<WordFailure>,
}

/// One run, and the switches that steer it from outside. Each run has its own, so that one that
/// is still finishing its last request after being stopped cannot be confused with the next.
#[derive(Default)]
pub struct Run {
    progress: Mutex<Progress>,
    paused: AtomicBool,
    stopped: AtomicBool,
    wake: Notify,
}

impl Run {
    pub fn started(total: usize) -> Self {
        Self {
            progress: Mutex::new(Progress {
                state: RunState::Running,
                total,
                ..Progress::default()
            }),
            ..Self::default()
        }
    }

    pub fn snapshot(&self) -> Progress {
        self.progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn change(&self, update: impl FnOnce(&mut Progress)) -> Progress {
        let mut progress = self.progress.lock().unwrap_or_else(PoisonError::into_inner);
        update(&mut progress);
        progress.clone()
    }

    /// Whether the run still has work going on: it is asking, or waiting, or finishing its last
    /// request after being stopped.
    pub fn is_active(&self) -> bool {
        matches!(
            self.snapshot().state,
            RunState::Running | RunState::Paused | RunState::Stopping
        )
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// No new request is sent until [`Run::resume`]. The one that is on its way is let finish.
    pub fn pause(&self) -> Progress {
        self.paused.store(true, Ordering::SeqCst);
        self.wake.notify_one();
        self.change(|progress| {
            if progress.state == RunState::Running {
                progress.state = RunState::Paused;
            }
        })
    }

    pub fn resume(&self) -> Progress {
        self.paused.store(false, Ordering::SeqCst);
        self.wake.notify_one();
        self.change(|progress| {
            if progress.state == RunState::Paused {
                progress.state = RunState::Running;
            }
        })
    }

    /// Ends the run after the request that is on its way. What is done stays done.
    pub fn stop(&self) -> Progress {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
        self.change(|progress| {
            if matches!(progress.state, RunState::Running | RunState::Paused) {
                progress.state = RunState::Stopping;
            }
        })
    }

    /// Waits until the run is not paused. `false` when it was stopped instead.
    async fn hold(&self) -> bool {
        loop {
            if self.is_stopped() {
                return false;
            }
            if !self.paused.load(Ordering::SeqCst) {
                return true;
            }
            // A resume or a stop that came first has left a permit, so it is not missed.
            self.wake.notified().await;
        }
    }

    /// Lets `wait` pass, though never while paused: a pause ends the wait early and is waited out
    /// before the rest of it is. `false` when the run was stopped instead.
    async fn wait(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        loop {
            if !self.hold().await {
                return false;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            tokio::select! {
                () = tokio::time::sleep(left) => {}
                () = self.wake.notified() => {}
            }
        }
    }
}

/// The runs there are, of which the last is the one the window talks about.
#[derive(Default)]
pub struct Enrichment {
    current: Mutex<Arc<Run>>,
    started: AtomicU64,
}

impl Enrichment {
    pub fn current(&self) -> Arc<Run> {
        Arc::clone(&self.current.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// Starts a run of `total` words, unless one is in progress.
    pub fn begin(&self, total: usize) -> Result<Arc<Run>, String> {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if current.is_active() {
            return Err("已经有一轮补全在进行，请先暂停或停止它".into());
        }
        let number = self.started.fetch_add(1, Ordering::SeqCst) + 1;
        let run = Arc::new(Run::started(total));
        run.change(|progress| progress.run = number);
        *current = Arc::clone(&run);
        Ok(run)
    }
}

// ---------------------------------------------------------------------------
// Going through the words
// ---------------------------------------------------------------------------

/// What came of one word that was asked about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The model's answer was added to the word, at the cost of `tokens` (nothing, when it was
    /// answered from the cache).
    Filled { tokens: u64 },
    /// There was nothing to do: the word was gone, or no longer bare.
    Skipped,
}

enum End {
    Finished,
    /// By the user (no reason), or because of `Some(reason)`.
    Stopped(Option<StopReason>),
}

/// What the words that cost tokens have cost, to guess what the next will.
#[derive(Default)]
struct Paid {
    words: u64,
    tokens: u64,
}

impl Paid {
    fn note(&mut self, tokens: u64) {
        if tokens > 0 {
            self.words += 1;
            self.tokens += tokens;
        }
    }

    fn expected_next(&self) -> u64 {
        self.tokens
            .checked_div(self.words)
            .unwrap_or(FIRST_GUESS_TOKENS)
    }
}

/// Goes through `queue`, a word at a time, as `plan` and the switches of `control` say.
///
/// `enrich` makes one request for a word, `tokens_today` says what has been spent today, `settled`
/// hears of each word once its outcome is final, and `publish` hears of every change in progress.
pub async fn run<Fut>(
    control: &Run,
    queue: Vec<Candidate>,
    plan: &Plan,
    tokens_today: impl Fn() -> u64,
    mut enrich: impl FnMut(Candidate) -> Fut,
    mut settled: impl FnMut(&Candidate, &Result<Outcome, Failure>),
    publish: impl Fn(&Progress),
) where
    Fut: Future<Output = Result<Outcome, Failure>>,
{
    let mut paid = Paid::default();
    let mut failed_in_a_row = 0_usize;
    let mut last_request: Option<Instant> = None;

    let end = 'queue: {
        for candidate in queue {
            // The pace, then any pause, then the budget as it stands when the turn comes.
            let until_next = last_request.map_or(Duration::ZERO, |at| {
                plan.interval.saturating_sub(at.elapsed())
            });
            if !control.wait(until_next).await {
                break 'queue End::Stopped(None);
            }
            if let Some(limit) = plan.daily_limit {
                let used = tokens_today();
                if used.saturating_add(paid.expected_next()) > limit {
                    break 'queue End::Stopped(Some(StopReason::budget(used, limit)));
                }
            }
            publish(&control.change(|progress| progress.current = Some(candidate.lemma.clone())));

            last_request = Some(Instant::now());
            let mut retries = 0;
            let result = loop {
                match enrich(candidate.clone()).await {
                    Ok(outcome) => break Ok(outcome),
                    Err(failure) => {
                        let Some(wait) = retry_wait(&failure.code, retries, plan.backoff) else {
                            break Err(failure);
                        };
                        retries += 1;
                        if !control.wait(wait).await {
                            // Stopped while waiting to try again: the word is neither done nor
                            // failed, and is still to do.
                            break 'queue End::Stopped(None);
                        }
                    }
                }
            };
            settled(&candidate, &result);

            let progress = match result {
                Ok(Outcome::Filled { tokens }) => {
                    failed_in_a_row = 0;
                    paid.note(tokens);
                    control.change(|progress| {
                        progress.done += 1;
                        progress.tokens += tokens;
                        progress.current = None;
                    })
                }
                Ok(Outcome::Skipped) => control.change(|progress| {
                    progress.skipped += 1;
                    progress.current = None;
                }),
                Err(failure) if ends_the_run(&failure.code) => {
                    break 'queue End::Stopped(Some(StopReason::of(&failure)));
                }
                Err(failure) => {
                    failed_in_a_row += 1;
                    let snapshot = control.change(|progress| {
                        progress.failed += 1;
                        progress.current = None;
                        if progress.failures.len() < FAILURES_KEPT {
                            progress.failures.push(WordFailure {
                                lemma: candidate.lemma.clone(),
                                code: failure.code.clone(),
                                message: failure.message.clone(),
                            });
                        }
                    });
                    if failed_in_a_row >= FAILURES_IN_A_ROW {
                        break 'queue End::Stopped(Some(StopReason::repeated(&failure)));
                    }
                    snapshot
                }
            };
            publish(&progress);
        }
        End::Finished
    };

    publish(&control.change(|progress| {
        progress.current = None;
        match end {
            End::Finished => progress.state = RunState::Finished,
            End::Stopped(reason) => {
                progress.state = RunState::Stopped;
                progress.stopped_because = reason;
            }
        }
    }));
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// Everything the window shows about the batch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Words that are bare now: what a run would work on.
    pub pending: usize,
    pub tokens_today: u64,
    /// The limit of the day, if the user set one.
    pub daily_limit: Option<u64>,
    pub progress: Progress,
}

#[tauri::command]
pub async fn get_enrichment_status(
    state: tauri::State<'_, AppState>,
    enrichment: tauri::State<'_, Enrichment>,
) -> Result<Status, String> {
    let (pending, tokens_today, daily_limit) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        (
            db.count_bare_words()?,
            db.tokens_today()?,
            daily_token_limit(&db.get_settings()?),
        )
    };
    Ok(Status {
        pending,
        tokens_today,
        daily_limit,
        progress: enrichment.current().snapshot(),
    })
}

/// Starts going through the bare words, or through those of `ids` that are bare.
#[tauri::command]
pub async fn start_enrichment(
    app: tauri::AppHandle,
    ids: Option<Vec<String>>,
) -> Result<Progress, String> {
    let state = app.state::<AppState>();
    let enrichment = app.state::<Enrichment>();
    let (queue, plan) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        (
            db.bare_words(ids.as_deref())?,
            Plan::from_settings(&db.get_settings()?),
        )
    };
    if queue.is_empty() {
        return Err(if ids.is_some() {
            "所选的词都已经有义项或例句了".into()
        } else {
            "没有需要补全的词".into()
        });
    }
    let control = enrichment.begin(queue.len())?;
    let started = control.snapshot();
    note_event(
        &app,
        "enrichment_started",
        &serde_json::json!({ "selected": ids.is_some() }),
    );

    let worker = app.clone();
    tauri::async_runtime::spawn(async move {
        run(
            &control,
            queue,
            &plan,
            || tokens_today(&worker),
            |candidate| {
                let app = worker.clone();
                async move { enrich_one(&app, &candidate).await }
            },
            |_, result| log_word(&worker, result),
            |progress| {
                let _ = worker.emit(PROGRESS_EVENT, progress);
            },
        )
        .await;
        let ended = control.snapshot();
        let reason = ended.stopped_because.as_ref().map_or(
            if ended.state == RunState::Finished {
                "done"
            } else {
                "user"
            },
            |why| why.code.as_str(),
        );
        note_event(
            &worker,
            "enrichment_ended",
            &serde_json::json!({ "reason": reason }),
        );
    });
    Ok(started)
}

#[tauri::command]
pub async fn pause_enrichment(
    enrichment: tauri::State<'_, Enrichment>,
) -> Result<Progress, String> {
    Ok(enrichment.current().pause())
}

#[tauri::command]
pub async fn resume_enrichment(
    enrichment: tauri::State<'_, Enrichment>,
) -> Result<Progress, String> {
    Ok(enrichment.current().resume())
}

#[tauri::command]
pub async fn stop_enrichment(enrichment: tauri::State<'_, Enrichment>) -> Result<Progress, String> {
    Ok(enrichment.current().stop())
}

fn tokens_today(app: &tauri::AppHandle) -> u64 {
    let state = app.state::<AppState>();
    state
        .db
        .lock()
        .ok()
        .and_then(|db| db.tokens_today().ok())
        .unwrap_or(0)
}

/// Counts a happening of the batch in the local metrics (never anything about the words).
fn note_event(app: &tauri::AppHandle, event: &str, extra: &Value) {
    let state = app.state::<AppState>();
    if let Ok(db) = state.db.lock() {
        let _ = db.record_local_event(event, extra);
    };
}

/// What one word's outcome adds to the metrics and the log. The word itself is never named.
fn log_word(app: &tauri::AppHandle, result: &Result<Outcome, Failure>) {
    match result {
        Ok(Outcome::Filled { .. }) => note_event(app, "enrichment_word_done", &Value::Null),
        Ok(Outcome::Skipped) => {}
        Err(failure) => {
            eprintln!(
                "[enrich] a word failed ({}): {}",
                failure.code,
                llm::error_detail(&failure.message)
            );
            note_event(
                app,
                "enrichment_word_failed",
                &serde_json::json!({ "code": failure.code }),
            );
        }
    }
}

/// Asks the model for one word and adds the answer to it.
async fn enrich_one(app: &tauri::AppHandle, candidate: &Candidate) -> Result<Outcome, Failure> {
    let state = app.state::<AppState>();
    let internal = |message: String| Failure::from_message(&llm::coded("internal", message));

    let word = {
        let db = state.db.lock().map_err(|e| internal(e.to_string()))?;
        db.get_words_in_order(std::slice::from_ref(&candidate.id))
            .map_err(&internal)?
            .into_iter()
            .next()
    };
    // Looked at again now: it may be gone, or no longer bare, since the run was started.
    let Some(word) = word.filter(is_bare) else {
        return Ok(Outcome::Skipped);
    };
    let text = |key: &str| {
        word.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let (lemma, context) = (text("lemma"), text("context"));
    // A word whose kind was never said is a word (see `is_bare`).
    let kind = Some(text("kind"))
        .filter(|kind| !kind.is_empty())
        .unwrap_or_else(|| "word".to_string());

    let (answer, tokens) = lookup::lookup_for_enrichment(&state, &lemma, &context, &kind)
        .await
        .map_err(|message| Failure::from_message(&message))?;

    let filled = {
        let db = state.db.lock().map_err(|e| internal(e.to_string()))?;
        db.fill_in_word(&candidate.id, &answer)
            .map_err(|message| Failure::from_message(&message))?
    };
    Ok(match filled {
        Filled::Done(_) => Outcome::Filled {
            tokens: u64::from(tokens),
        },
        Filled::Gone | Filled::NotBare => Outcome::Skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    fn imported(lemma: &str) -> Value {
        json!({
            "id": format!("id-{lemma}"),
            "lemma": lemma,
            "selection": lemma,
            "kind": "word",
            "translation": "导入的释义",
            "pos": "",
            "contextMeaning": "",
            "explanation": "",
            "senses": [],
            "associations": [],
            "examples": [],
            "collocations": [],
            "register": "neutral",
            "note": "我的笔记",
            "tags": ["托福"],
            "mastery": "learning",
            "savedAt": "2026-08-01T10:00:00+00:00",
            "sourceApp": "",
            "lookups": 1,
        })
    }

    fn answer() -> Value {
        json!({
            "lemma": "ephemeral",
            "pos": "adj.",
            "ipaUS": "/əˈfemərəl/",
            "ipaUK": "/ɪˈfemərəl/",
            "translation": "短暂的",
            "contextMeaning": "转瞬即逝的",
            "explanation": "lasting for a very short time",
            "senses": [{ "pos": "adj.", "translation": "短暂的", "gloss": "short-lived" }],
            "associations": [{ "kind": "synonym", "title": "transient", "detail": "更书面" }],
            "examples": [{ "en": "Fame is ephemeral.", "zh": "名声转瞬即逝。" }],
            "collocations": ["ephemeral beauty"],
            "register": "formal",
            "_model": "qwen-test",
            "_templateName": "标准模板 [word]",
        })
    }

    // -- what a word is, and what is added to it --------------------------------

    #[test]
    fn a_word_is_bare_when_it_has_neither_senses_nor_examples() {
        assert!(is_bare(&imported("ephemeral")));

        let mut with_senses = imported("ephemeral");
        with_senses["senses"] = json!([{ "pos": "adj.", "translation": "短暂的", "gloss": "x" }]);
        assert!(!is_bare(&with_senses));

        let mut with_examples = imported("ephemeral");
        with_examples["examples"] = json!([{ "en": "Fame is ephemeral.", "zh": "名声转瞬即逝。" }]);
        assert!(!is_bare(&with_examples));

        // Missing lists are as empty as empty ones; a missing or empty kind is a word.
        assert!(is_bare(&json!({ "lemma": "x" })));
        assert!(is_bare(&json!({ "lemma": "x", "kind": "" })));
        assert!(is_bare(&json!({ "lemma": "x", "kind": "phrase" })));
        // Lists that are not lists have no items either.
        assert!(is_bare(
            &json!({ "lemma": "x", "senses": "oops", "examples": null })
        ));
    }

    #[test]
    fn a_sentence_or_a_paragraph_is_never_bare() {
        for kind in ["sentence", "paragraph"] {
            let mut long = imported("the quick brown fox");
            long["kind"] = json!(kind);
            assert!(!is_bare(&long), "{kind}");
        }
    }

    #[test]
    fn what_the_model_says_is_added_where_the_word_has_nothing() {
        let filled = fill_gaps(&imported("ephemeral"), &answer());

        assert_eq!(filled["pos"], "adj.");
        assert_eq!(filled["ipaUS"], "/əˈfemərəl/");
        assert_eq!(filled["ipaUK"], "/ɪˈfemərəl/");
        assert_eq!(filled["contextMeaning"], "转瞬即逝的");
        assert_eq!(filled["explanation"], "lasting for a very short time");
        assert_eq!(filled["senses"][0]["gloss"], "short-lived");
        assert_eq!(filled["associations"][0]["title"], "transient");
        assert_eq!(filled["examples"][0]["en"], "Fame is ephemeral.");
        assert_eq!(filled["collocations"][0], "ephemeral beauty");
        assert!(!is_bare(&filled));
    }

    #[test]
    fn what_the_word_already_says_is_not_replaced() {
        let mut word = imported("ephemeral");
        word["pos"] = json!("n.");
        word["explanation"] = json!("我自己写的解释");

        let filled = fill_gaps(&word, &answer());

        // Mine, not the model's: the meaning that was imported, and what was typed in.
        assert_eq!(filled["translation"], "导入的释义");
        assert_eq!(filled["pos"], "n.");
        assert_eq!(filled["explanation"], "我自己写的解释");
        // The rest was empty, and is filled.
        assert_eq!(filled["contextMeaning"], "转瞬即逝的");
    }

    #[test]
    fn what_the_user_owns_is_left_alone() {
        let word = imported("ephemeral");
        let filled = fill_gaps(&word, &answer());

        for key in [
            "id",
            "lemma",
            "selection",
            "kind",
            "note",
            "tags",
            "mastery",
            "savedAt",
            "lookups",
        ] {
            assert_eq!(filled[key], word[key], "{key}");
        }
    }

    #[test]
    fn a_word_keeps_its_own_lemma_when_the_model_answers_with_another_form() {
        let mut word = imported("running");
        word["id"] = json!("id-running");
        let mut given = answer();
        given["lemma"] = json!("run");

        assert_eq!(fill_gaps(&word, &given)["lemma"], "running");
    }

    #[test]
    fn the_register_of_an_imported_word_is_the_one_nobody_chose_so_the_models_replaces_it() {
        assert_eq!(fill_gaps(&imported("x"), &answer())["register"], "formal");

        let mut chosen = imported("x");
        chosen["register"] = json!("slang");
        assert_eq!(fill_gaps(&chosen, &answer())["register"], "slang");

        let mut neutral_too = answer();
        neutral_too["register"] = json!("neutral");
        assert_eq!(
            fill_gaps(&imported("x"), &neutral_too)["register"],
            "neutral"
        );
    }

    #[test]
    fn the_word_says_which_model_wrote_what_was_added() {
        let filled = fill_gaps(&imported("ephemeral"), &answer());
        assert_eq!(filled["_model"], "qwen-test");
        assert_eq!(filled["_templateName"], "标准模板 [word]");
        assert!(filled.get("_viaBackup").is_none());

        let mut by_backup = answer();
        by_backup["_viaBackup"] = json!(true);
        assert_eq!(
            fill_gaps(&imported("ephemeral"), &by_backup)["_viaBackup"],
            true
        );

        // An earlier answer of the backup does not outlast one of the main model.
        let mut before = imported("ephemeral");
        before["_viaBackup"] = json!(true);
        assert!(fill_gaps(&before, &answer()).get("_viaBackup").is_none());
    }

    #[test]
    fn an_answer_with_nothing_to_add_changes_nothing_and_says_nothing() {
        let word = imported("ephemeral");
        let empty =
            json!({ "lemma": "ephemeral", "senses": [], "examples": [], "_model": "qwen-test" });

        let filled = fill_gaps(&word, &empty);

        assert_eq!(filled, word);
        assert!(is_bare(&filled));
        // Not an object at all: the word comes back as it was.
        assert_eq!(fill_gaps(&word, &json!("oops")), word);
    }

    // -- what the user chose ------------------------------------------------------

    #[test]
    fn the_limit_is_the_one_chosen_and_zero_means_none() {
        assert_eq!(
            daily_token_limit(&json!({ "enrichDailyTokens": 50_000 })),
            Some(50_000)
        );
        assert_eq!(daily_token_limit(&json!({ "enrichDailyTokens": 0 })), None);
    }

    #[test]
    fn a_limit_that_is_missing_or_makes_no_sense_is_the_default_never_no_limit() {
        for settings in [
            json!({}),
            json!({ "enrichDailyTokens": null }),
            json!({ "enrichDailyTokens": "lots" }),
            json!({ "enrichDailyTokens": -5 }),
            json!({ "enrichDailyTokens": 12.5 }),
            json!({ "enrichDailyTokens": 10 }),
        ] {
            assert_eq!(
                daily_token_limit(&settings),
                Some(DEFAULT_DAILY_TOKENS),
                "{settings}"
            );
        }
    }

    #[test]
    fn the_pace_is_gentle_normal_or_fast_and_normal_when_unsaid() {
        let of = |value: Value| pace(&json!({ "enrichPace": value }));
        assert_eq!(of(json!("gentle")), Duration::from_secs(6));
        assert_eq!(of(json!("normal")), Duration::from_secs(3));
        assert_eq!(of(json!("fast")), Duration::from_millis(1_500));
        assert_eq!(of(json!("warp")), Duration::from_secs(3));
        assert_eq!(pace(&json!({})), Duration::from_secs(3));
    }

    // -- when to try again ----------------------------------------------------------

    #[test]
    fn a_busy_service_is_given_time_and_a_failing_one_a_little() {
        let unit = Duration::from_secs(1);
        let schedule = |code: &str| {
            (0..5)
                .map_while(|retries| retry_wait(code, retries, unit))
                .map(|wait| wait.as_secs())
                .collect::<Vec<_>>()
        };
        assert_eq!(schedule("rate_limit"), [10, 30, 90]);
        for code in ["server", "timeout", "network"] {
            assert_eq!(schedule(code), [3, 10], "{code}");
        }
        for code in [
            "no_key",
            "auth",
            "model",
            "http",
            "parse",
            "empty",
            "truncated",
            "api",
            "internal",
            "unknown",
        ] {
            assert!(schedule(code).is_empty(), "{code}");
        }
    }

    #[test]
    fn the_wait_is_in_the_unit_it_is_given() {
        assert_eq!(
            retry_wait("rate_limit", 0, Duration::ZERO),
            Some(Duration::ZERO)
        );
        assert_eq!(
            retry_wait("rate_limit", 1, Duration::from_millis(10)),
            Some(Duration::from_millis(300))
        );
    }

    #[test]
    fn only_what_every_further_word_would_meet_ends_the_run() {
        for code in ["no_key", "auth", "model", "rate_limit"] {
            assert!(ends_the_run(code), "{code}");
        }
        for code in [
            "server",
            "http",
            "timeout",
            "network",
            "parse",
            "empty",
            "truncated",
            "api",
            "internal",
            "unknown",
        ] {
            assert!(!ends_the_run(code), "{code}");
        }
        assert_eq!(llm::ERROR_CODES.len(), 14);
    }

    #[test]
    fn a_failure_knows_its_code_even_when_the_message_had_none() {
        let coded = Failure::from_message("[auth] 401 Unauthorized");
        assert_eq!(
            (coded.code.as_str(), coded.message.as_str()),
            ("auth", "[auth] 401 Unauthorized")
        );

        let plain = Failure::from_message("connection reset");
        assert_eq!(plain.code, "unknown");
        assert_eq!(plain.message, "[unknown] connection reset");
    }

    // -- going through the words ------------------------------------------------------

    fn words(lemmas: &[&str]) -> Vec<Candidate> {
        lemmas
            .iter()
            .map(|lemma| Candidate {
                id: format!("id-{lemma}"),
                lemma: (*lemma).to_string(),
            })
            .collect()
    }

    /// A plan that waits for nothing, with `limit` of tokens for the day.
    fn quick(limit: Option<u64>) -> Plan {
        Plan {
            interval: Duration::ZERO,
            daily_limit: limit,
            backoff: Duration::ZERO,
        }
    }

    fn failure(code: &str) -> Failure {
        Failure::from_message(&llm::coded(code, "boom"))
    }

    /// What a test run saw: the words asked about, in order, and the snapshots published.
    #[derive(Default)]
    struct Seen {
        asked: StdMutex<Vec<String>>,
        published: StdMutex<Vec<Progress>>,
        settled: StdMutex<Vec<(String, bool)>>,
    }

    impl Seen {
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }

        fn published(&self) -> Vec<Progress> {
            self.published.lock().unwrap().clone()
        }

        fn settled(&self) -> Vec<(String, bool)> {
            self.settled.lock().unwrap().clone()
        }
    }

    /// Runs `queue` with `answer` deciding what each request gives, and a day that has already
    /// used `already` tokens, each filled word adding what it says it cost.
    async fn go(
        control: &Run,
        queue: Vec<Candidate>,
        plan: &Plan,
        already: u64,
        answer: impl Fn(&str, usize) -> Result<Outcome, Failure>,
    ) -> Seen {
        let seen = Seen::default();
        let spent = AtomicU64::new(already);
        let attempts = StdMutex::new(std::collections::HashMap::<String, usize>::new());
        run(
            control,
            queue,
            plan,
            || spent.load(Ordering::SeqCst),
            |candidate| {
                seen.asked.lock().unwrap().push(candidate.lemma.clone());
                let attempt = {
                    let mut attempts = attempts.lock().unwrap();
                    let count = attempts.entry(candidate.lemma.clone()).or_insert(0);
                    *count += 1;
                    *count
                };
                let result = answer(&candidate.lemma, attempt);
                if let Ok(Outcome::Filled { tokens }) = &result {
                    spent.fetch_add(*tokens, Ordering::SeqCst);
                }
                async move { result }
            },
            |candidate, result| {
                seen.settled
                    .lock()
                    .unwrap()
                    .push((candidate.lemma.clone(), result.is_ok()));
            },
            |progress| seen.published.lock().unwrap().push(progress.clone()),
        )
        .await;
        seen
    }

    fn costing(tokens: u64) -> Result<Outcome, Failure> {
        Ok(Outcome::Filled { tokens })
    }

    #[tokio::test]
    async fn every_word_is_asked_in_turn_and_the_run_finishes() {
        let run_control = Run::started(3);

        let seen = go(
            &run_control,
            words(&["a", "b", "c"]),
            &quick(None),
            0,
            |_, _| costing(1_000),
        )
        .await;

        assert_eq!(seen.asked(), ["a", "b", "c"]);
        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Finished);
        assert_eq!((end.total, end.done, end.failed, end.skipped), (3, 3, 0, 0));
        assert_eq!(end.tokens, 3_000);
        assert_eq!(end.current, None);
        assert_eq!(end.stopped_because, None);
        assert_eq!(seen.settled().len(), 3);
    }

    #[tokio::test]
    async fn the_word_in_hand_is_named_while_it_is_asked_and_not_after() {
        let run_control = Run::started(2);

        let seen = go(&run_control, words(&["a", "b"]), &quick(None), 0, |_, _| {
            costing(10)
        })
        .await;

        let named: Vec<Option<String>> = seen.published().into_iter().map(|p| p.current).collect();
        assert_eq!(
            named,
            [
                Some("a".to_string()),
                None,
                Some("b".to_string()),
                None,
                None
            ]
        );
    }

    #[tokio::test]
    async fn a_word_that_needed_nothing_is_skipped_and_counted_so() {
        let run_control = Run::started(2);

        go(
            &run_control,
            words(&["a", "b"]),
            &quick(None),
            0,
            |lemma, _| {
                if lemma == "a" {
                    Ok(Outcome::Skipped)
                } else {
                    costing(10)
                }
            },
        )
        .await;

        let end = run_control.snapshot();
        assert_eq!((end.done, end.skipped, end.failed), (1, 1, 0));
        assert_eq!(end.state, RunState::Finished);
    }

    #[tokio::test]
    async fn the_run_stops_when_the_next_word_would_pass_the_days_limit() {
        let run_control = Run::started(5);

        // 3,000 of 10,000 used. Each word costs 2,000: three fit (5,000, 7,000, 9,000), a fourth
        // would be asked for with 9,000 spent and 2,000 more to come.
        let seen = go(
            &run_control,
            words(&["a", "b", "c", "d", "e"]),
            &quick(Some(10_000)),
            3_000,
            |_, _| costing(2_000),
        )
        .await;

        assert_eq!(seen.asked(), ["a", "b", "c"]);
        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Stopped);
        assert_eq!(end.done, 3);
        let reason = end.stopped_because.expect("a reason");
        assert_eq!(reason.code, "budget");
        assert!(
            reason.message.contains("9000") && reason.message.contains("10000"),
            "{}",
            reason.message
        );
    }

    #[tokio::test]
    async fn the_first_word_is_asked_only_if_a_word_is_likely_to_fit() {
        let run_control = Run::started(2);

        // 9,000 of 10,000 used. What a word costs is not known yet, and is guessed at more than
        // the 1,000 that is left, so nothing is asked.
        let seen = go(
            &run_control,
            words(&["a", "b"]),
            &quick(Some(10_000)),
            9_000,
            |_, _| costing(500),
        )
        .await;

        assert!(seen.asked().is_empty());
        assert_eq!(
            run_control.snapshot().stopped_because.map(|why| why.code),
            Some("budget".to_string())
        );
    }

    #[tokio::test]
    async fn words_answered_from_the_cache_do_not_make_the_next_one_look_cheaper() {
        let run_control = Run::started(3);

        // The first costs nothing (it was kept), the second 6,000. A word is now expected to cost
        // 6,000, not the 3,000 that the two make on average, so the third no longer fits in the
        // 20,000 of which 16,000 are used.
        let seen = go(
            &run_control,
            words(&["a", "b", "c"]),
            &quick(Some(20_000)),
            10_000,
            |lemma, _| {
                if lemma == "a" {
                    costing(0)
                } else {
                    costing(6_000)
                }
            },
        )
        .await;

        assert_eq!(seen.asked(), ["a", "b"]);
        assert_eq!(
            run_control.snapshot().stopped_because.map(|why| why.code),
            Some("budget".to_string())
        );
    }

    #[tokio::test]
    async fn no_limit_means_the_whole_queue() {
        let run_control = Run::started(3);

        let seen = go(
            &run_control,
            words(&["a", "b", "c"]),
            &quick(None),
            9_999_999,
            |_, _| costing(50_000),
        )
        .await;

        assert_eq!(seen.asked().len(), 3);
        assert_eq!(run_control.snapshot().state, RunState::Finished);
    }

    #[tokio::test]
    async fn a_failure_every_word_would_share_ends_the_run_and_is_not_blamed_on_the_word() {
        for code in ["no_key", "auth", "model"] {
            let run_control = Run::started(3);

            let seen = go(
                &run_control,
                words(&["a", "b", "c"]),
                &quick(None),
                0,
                |lemma, _| {
                    if lemma == "b" {
                        Err(failure(code))
                    } else {
                        costing(10)
                    }
                },
            )
            .await;

            assert_eq!(seen.asked(), ["a", "b"], "{code}");
            let end = run_control.snapshot();
            assert_eq!(end.state, RunState::Stopped, "{code}");
            assert_eq!((end.done, end.failed), (1, 0), "{code}");
            assert!(end.failures.is_empty(), "{code}");
            let reason = end.stopped_because.expect("a reason");
            assert_eq!(reason.code, code);
            assert!(
                reason.message.starts_with(&format!("[{code}]")),
                "{}",
                reason.message
            );
        }
    }

    #[tokio::test]
    async fn a_busy_service_is_asked_again_and_the_word_goes_through() {
        let run_control = Run::started(1);

        let seen = go(
            &run_control,
            words(&["a"]),
            &quick(None),
            0,
            |_, attempt| {
                if attempt < 3 {
                    Err(failure("rate_limit"))
                } else {
                    costing(10)
                }
            },
        )
        .await;

        assert_eq!(seen.asked(), ["a", "a", "a"]);
        let end = run_control.snapshot();
        assert_eq!(
            (end.state, end.done, end.failed),
            (RunState::Finished, 1, 0)
        );
    }

    #[tokio::test]
    async fn a_service_that_stays_busy_ends_the_run_after_its_retries() {
        let run_control = Run::started(3);

        let seen = go(
            &run_control,
            words(&["a", "b", "c"]),
            &quick(None),
            0,
            |_, _| Err(failure("rate_limit")),
        )
        .await;

        // The first try and three retries, and then no more words are asked.
        assert_eq!(seen.asked(), ["a", "a", "a", "a"]);
        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Stopped);
        assert_eq!(
            end.stopped_because.map(|why| why.code),
            Some("rate_limit".to_string())
        );
        assert_eq!(end.failed, 0);
    }

    #[tokio::test]
    async fn a_slow_or_failing_service_is_tried_twice_more_and_then_the_word_fails_alone() {
        let run_control = Run::started(2);

        let seen = go(
            &run_control,
            words(&["a", "b"]),
            &quick(None),
            0,
            |lemma, _| {
                if lemma == "a" {
                    Err(failure("timeout"))
                } else {
                    costing(10)
                }
            },
        )
        .await;

        assert_eq!(seen.asked(), ["a", "a", "a", "b"]);
        let end = run_control.snapshot();
        assert_eq!(
            (end.state, end.done, end.failed),
            (RunState::Finished, 1, 1)
        );
        assert_eq!(end.failures.len(), 1);
        assert_eq!(end.failures[0].lemma, "a");
        assert_eq!(end.failures[0].code, "timeout");
        assert_eq!(end.failures[0].message, "[timeout] boom");
    }

    #[tokio::test]
    async fn an_answer_that_cannot_be_read_is_not_asked_for_again() {
        let run_control = Run::started(2);

        let seen = go(
            &run_control,
            words(&["a", "b"]),
            &quick(None),
            0,
            |lemma, _| {
                if lemma == "a" {
                    Err(failure("parse"))
                } else {
                    costing(10)
                }
            },
        )
        .await;

        assert_eq!(seen.asked(), ["a", "b"]);
        assert_eq!(run_control.snapshot().failed, 1);
    }

    #[tokio::test]
    async fn words_that_keep_failing_end_the_run_because_it_is_not_the_words() {
        let run_control = Run::started(10);

        let seen = go(
            &run_control,
            words(&["a", "b", "c", "d", "e", "f", "g"]),
            &quick(None),
            0,
            |_, _| Err(failure("parse")),
        )
        .await;

        assert_eq!(seen.asked().len(), FAILURES_IN_A_ROW);
        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Stopped);
        assert_eq!(end.failed, FAILURES_IN_A_ROW);
        let reason = end.stopped_because.expect("a reason");
        assert_eq!(reason.code, "repeated");
        assert_eq!(reason.message, "[parse] boom");
    }

    #[tokio::test]
    async fn a_word_that_goes_through_clears_the_count_of_failures_in_a_row() {
        let run_control = Run::started(10);
        let lemmas = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

        // Four fail, one goes through, four fail: never five in a row.
        go(&run_control, words(&lemmas), &quick(None), 0, |lemma, _| {
            if lemma == "e" || lemma == "j" {
                costing(10)
            } else {
                Err(failure("parse"))
            }
        })
        .await;

        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Finished);
        assert_eq!((end.done, end.failed), (2, 8));
    }

    #[tokio::test]
    async fn only_the_first_failed_words_are_named_but_all_are_counted() {
        let total = FAILURES_KEPT + 20;
        let run_control = Run::started(total);
        let lemmas: Vec<String> = (0..total).map(|n| format!("w{n}")).collect();
        let queue: Vec<Candidate> = lemmas
            .iter()
            .map(|lemma| Candidate {
                id: lemma.clone(),
                lemma: lemma.clone(),
            })
            .collect();

        // Every fifth word goes through, so that the run is never ended by its failures.
        let counter = AtomicU64::new(0);
        go(&run_control, queue, &quick(None), 0, |_, _| {
            if counter.fetch_add(1, Ordering::SeqCst) % 5 == 4 {
                costing(1)
            } else {
                Err(failure("parse"))
            }
        })
        .await;

        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Finished);
        assert_eq!(end.done + end.failed, total);
        assert_eq!(end.failures.len(), FAILURES_KEPT);
        assert!(end.failed > FAILURES_KEPT);
    }

    #[tokio::test]
    async fn a_run_that_is_stopped_ends_after_the_word_in_hand_and_says_no_reason() {
        let run_control = Run::started(4);

        let seen = go(
            &run_control,
            words(&["a", "b", "c", "d"]),
            &quick(None),
            0,
            |lemma, _| {
                if lemma == "b" {
                    run_control.stop();
                }
                costing(10)
            },
        )
        .await;

        assert_eq!(seen.asked(), ["a", "b"]);
        let end = run_control.snapshot();
        assert_eq!(end.state, RunState::Stopped);
        assert_eq!(end.stopped_because, None);
        // The word in hand was let finish: it counts.
        assert_eq!(end.done, 2);
    }

    #[tokio::test]
    async fn stopping_while_waiting_to_try_again_leaves_that_word_to_do() {
        let run_control = Run::started(2);
        let plan = Plan {
            backoff: Duration::from_secs(60),
            ..quick(None)
        };

        let seen = go(&run_control, words(&["a", "b"]), &plan, 0, |_, _| {
            run_control.stop();
            Err(failure("timeout"))
        })
        .await;

        assert_eq!(seen.asked(), ["a"]);
        let end = run_control.snapshot();
        assert_eq!((end.state, end.failed, end.done), (RunState::Stopped, 0, 0));
        assert!(end.failures.is_empty());
        assert!(seen.settled().is_empty());
    }

    #[tokio::test]
    async fn a_run_that_was_stopped_before_it_began_asks_for_nothing() {
        let run_control = Run::started(2);
        run_control.stop();

        let seen = go(&run_control, words(&["a", "b"]), &quick(None), 0, |_, _| {
            costing(10)
        })
        .await;

        assert!(seen.asked().is_empty());
        assert_eq!(run_control.snapshot().state, RunState::Stopped);
    }

    #[tokio::test]
    async fn a_paused_run_asks_nothing_until_it_is_resumed() {
        let run_control = Run::started(3);
        run_control.pause();
        assert_eq!(run_control.snapshot().state, RunState::Paused);
        let asked = AtomicU64::new(0);

        let queue = words(&["a", "b", "c"]);
        let runner = async {
            run(
                &run_control,
                queue,
                &quick(None),
                || 0,
                |_candidate| {
                    asked.fetch_add(1, Ordering::SeqCst);
                    async { costing(10) }
                },
                |_, _| {},
                |_| {},
            )
            .await;
        };
        let hand = async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            assert_eq!(asked.load(Ordering::SeqCst), 0, "asked while paused");
            assert_eq!(run_control.resume().state, RunState::Running);
        };
        tokio::join!(runner, hand);

        assert_eq!(asked.load(Ordering::SeqCst), 3);
        assert_eq!(run_control.snapshot().state, RunState::Finished);
    }

    #[tokio::test]
    async fn pausing_in_the_middle_lets_the_word_in_hand_finish_and_holds_the_next() {
        let run_control = Run::started(3);
        let asked = AtomicU64::new(0);

        let queue = words(&["a", "b", "c"]);
        let runner = async {
            run(
                &run_control,
                queue,
                &quick(None),
                || 0,
                |candidate| {
                    asked.fetch_add(1, Ordering::SeqCst);
                    if candidate.lemma == "a" {
                        run_control.pause();
                    }
                    async { costing(10) }
                },
                |_, _| {},
                |_| {},
            )
            .await;
        };
        let hand = async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            // The first was finished, and nothing was asked after it.
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            let held = run_control.snapshot();
            assert_eq!((held.state, held.done), (RunState::Paused, 1));
            run_control.resume();
        };
        tokio::join!(runner, hand);

        assert_eq!(asked.load(Ordering::SeqCst), 3);
        assert_eq!(run_control.snapshot().done, 3);
    }

    #[tokio::test]
    async fn a_paused_run_can_be_stopped() {
        let run_control = Run::started(2);
        run_control.pause();

        let queue = words(&["a", "b"]);
        let plan = quick(None);
        let runner = run(
            &run_control,
            queue,
            &plan,
            || 0,
            |_| async { costing(10) },
            |_, _| {},
            |_| {},
        );
        let hand = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            run_control.stop();
        };
        tokio::join!(runner, hand);

        let end = run_control.snapshot();
        assert_eq!((end.state, end.done), (RunState::Stopped, 0));
    }

    #[tokio::test]
    async fn the_requests_keep_the_pace_but_the_first_does_not_wait() {
        let run_control = Run::started(3);
        let interval = Duration::from_millis(60);
        let plan = Plan {
            interval,
            ..quick(None)
        };
        let starts = StdMutex::new(Vec::<Instant>::new());

        let began = Instant::now();
        run(
            &run_control,
            words(&["a", "b", "c"]),
            &plan,
            || 0,
            |_| {
                starts.lock().unwrap().push(Instant::now());
                async { costing(10) }
            },
            |_, _| {},
            |_| {},
        )
        .await;

        let starts = starts.into_inner().unwrap();
        assert!(
            starts[0].duration_since(began) < interval,
            "the first request waited"
        );
        // The pace is kept from the moment a request is made, which is a hair before the moment
        // it is noted here, hence the little allowance.
        let allowance = Duration::from_millis(15);
        for pair in starts.windows(2) {
            assert!(
                pair[1].duration_since(pair[0]) + allowance >= interval,
                "two requests came closer than the pace"
            );
        }
    }

    #[tokio::test]
    async fn the_time_spent_paused_counts_towards_the_pace() {
        let run_control = Run::started(2);
        let plan = Plan {
            interval: Duration::from_millis(250),
            ..quick(None)
        };

        let runner = run(
            &run_control,
            words(&["a", "b"]),
            &plan,
            || 0,
            |candidate| {
                if candidate.lemma == "a" {
                    run_control.pause();
                }
                async { costing(10) }
            },
            |_, _| {},
            |_| {},
        );
        let hand = async {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let resumed = Instant::now();
            run_control.resume();
            resumed
        };
        let (_, resumed) = tokio::join!(runner, hand);

        // Resumed after more than the interval had passed, the next word was not made to wait it
        // out all over again.
        assert!(
            resumed.elapsed() < Duration::from_millis(150),
            "{:?}",
            resumed.elapsed()
        );
        assert_eq!(run_control.snapshot().done, 2);
    }

    // -- one run at a time ------------------------------------------------------------

    #[test]
    fn a_new_run_cannot_start_while_one_is_in_progress() {
        let enrichment = Enrichment::default();
        let first = enrichment.begin(5).unwrap();

        assert!(enrichment.begin(3).is_err());
        first.pause();
        assert!(enrichment.begin(3).is_err(), "a paused run is still a run");
        first.stop();
        assert!(
            enrichment.begin(3).is_err(),
            "a run that is finishing its last request is still a run"
        );

        // Its worker has ended now.
        first.change(|progress| progress.state = RunState::Stopped);
        let second = enrichment.begin(3).expect("the stopped one is over");
        assert_eq!(second.snapshot().total, 3);
        assert_eq!(enrichment.current().snapshot().total, 3);
        // The starts that were refused took no number.
        assert_eq!(second.snapshot().run, 2);
    }

    #[test]
    fn a_finished_run_is_replaced_by_the_next() {
        let enrichment = Enrichment::default();
        let first = enrichment.begin(1).unwrap();
        first.change(|progress| progress.state = RunState::Finished);

        let second = enrichment.begin(2).expect("a finished run is over");
        // The window tells one run from the next by its number.
        assert_eq!(first.snapshot().run, 1);
        assert_eq!(second.snapshot().run, 2);
    }

    #[test]
    fn what_the_window_is_told_has_the_names_it_reads() {
        let mut progress = Run::started(4).snapshot();
        progress.stopped_because = Some(StopReason::budget(900, 1000));
        progress.failures.push(WordFailure {
            lemma: "ephemeral".into(),
            code: "parse".into(),
            message: "[parse] boom".into(),
        });

        let sent = serde_json::to_value(&progress).unwrap();

        assert_eq!(sent["state"], "running");
        assert_eq!(sent["total"], 4);
        assert_eq!(sent["stoppedBecause"]["code"], "budget");
        assert_eq!(sent["failures"][0]["lemma"], "ephemeral");
        assert_eq!(sent["current"], Value::Null);
        let idle = serde_json::to_value(Progress::default()).unwrap();
        assert_eq!(idle["state"], "idle");
        for (state, name) in [
            (RunState::Paused, "paused"),
            (RunState::Stopping, "stopping"),
            (RunState::Finished, "finished"),
            (RunState::Stopped, "stopped"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), name);
        }
    }

    #[test]
    fn pausing_or_resuming_a_run_that_is_over_changes_nothing() {
        let run_control = Run::started(1);
        run_control.change(|progress| progress.state = RunState::Stopped);

        assert_eq!(run_control.pause().state, RunState::Stopped);
        assert_eq!(run_control.resume().state, RunState::Stopped);
        assert_eq!(run_control.stop().state, RunState::Stopped);
        assert!(!run_control.is_active());
    }

    #[test]
    fn a_stopped_run_is_stopping_until_the_word_in_hand_is_done() {
        let run_control = Run::started(2);
        run_control.change(|progress| progress.current = Some("a".into()));

        let stopping = run_control.stop();

        assert_eq!(stopping.state, RunState::Stopping);
        assert_eq!(
            stopping.current.as_deref(),
            Some("a"),
            "the word in hand is named until it is done"
        );
        assert!(run_control.is_active());
        // Neither pausing nor resuming brings it back.
        assert_eq!(run_control.pause().state, RunState::Stopping);
        assert_eq!(run_control.resume().state, RunState::Stopping);
        assert_eq!(run_control.stop().state, RunState::Stopping);
    }
}
