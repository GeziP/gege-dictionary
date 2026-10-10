//! The OCR engine the app shares: the PP-OCRv6 networks, loaded when a picture is first read, kept
//! while pictures keep coming, and let go of after a while without one. An app that sits in the
//! tray all day must not hold on to a feature that is used now and then.
//!
//! The networks are part of the program (`models/pp-ocrv6`). ONNX Runtime, which runs them, is
//! `onnxruntime.dll` next to the executable (see `scripts/fetch-onnxruntime.ps1`): it is loaded
//! here, on first use, so a PC that cannot load it loses the screenshot OCR and nothing else.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError, Weak};
use std::time::{Duration, Instant};

use crate::ppocr::{self, Engine, Models, Pixels};

const DETECTOR: &[u8] = include_bytes!("../models/pp-ocrv6/det.onnx");
const RECOGNIZER: &[u8] = include_bytes!("../models/pp-ocrv6/rec.onnx");
const DICTIONARY: &str = include_str!("../models/pp-ocrv6/dict.txt");

/// The file name of ONNX Runtime, in the folder of the executable.
const RUNTIME_FILE: &str = "onnxruntime.dll";

/// How long the engine is kept after it was last used.
const IDLE_LIMIT: Duration = Duration::from_secs(120);

fn models() -> Models<'static> {
    Models {
        detector: DETECTOR,
        recognizer: RECOGNIZER,
        dictionary: DICTIONARY,
    }
}

/// How many threads the networks use: half of the PC's, but between two and four. More do not
/// make a line of text much quicker, and the foreground program needs the rest.
fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(2, std::num::NonZeroUsize::get)
        .div_ceil(2)
        .clamp(2, 4)
}

fn cannot_start(reason: &str) -> String {
    format!(
        "内置 OCR 引擎没能启动：{reason}。请重新安装鸽鸽词典；如果仍然无法使用，请把这段话反馈给开发者。"
    )
}

struct State {
    engine: Option<Engine>,
    last_used: Instant,
    /// Whether a thread is waiting to let the engine go.
    watching: bool,
}

struct Inner {
    state: Mutex<State>,
    runtime: PathBuf,
    idle_limit: Duration,
    threads: usize,
}

/// The engine of the app: one at a time reads, the others wait their turn.
#[derive(Clone)]
pub struct SharedEngine(Arc<Inner>);

impl SharedEngine {
    /// An engine that loads ONNX Runtime from `runtime` and lets go of the networks after
    /// `idle_limit` without a picture.
    pub fn new(runtime: PathBuf, idle_limit: Duration) -> SharedEngine {
        SharedEngine(Arc::new(Inner {
            state: Mutex::new(State {
                engine: None,
                last_used: Instant::now(),
                watching: false,
            }),
            runtime,
            idle_limit,
            threads: default_threads(),
        }))
    }

    /// The text of a picture of BGRA pixels, top-down, `width` by `height`.
    pub fn read_text(&self, width: u32, height: u32, bgra: &[u8]) -> Result<String, String> {
        let picture = Pixels {
            width: width as usize,
            height: height as usize,
            channels: 4,
            data: bgra,
        };
        self.with_engine(|engine| engine.read_text(&picture))
    }

    /// Loads the engine in the background, for a picture that is about to come. A failure is not
    /// reported here: the picture that follows meets it again and reports it to the person who
    /// is waiting for the text.
    pub fn warm_up(&self) {
        let engine = self.clone();
        let started = std::thread::Builder::new()
            .name("ocr-warm-up".into())
            .spawn(move || {
                let _ = engine.with_engine(|_| Ok(()));
            });
        if let Err(error) = started {
            eprintln!("[ocr] cannot start the warm-up thread: {error}");
        }
    }

    /// Whether the networks are in memory now.
    #[cfg(test)]
    pub fn is_loaded(&self) -> bool {
        self.lock().engine.is_some()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lets `work` use the engine, loading it first if it is not loaded. Whatever happens, the
    /// engine counts as used when `work` is over, and a panic inside `work` costs the engine
    /// (which may be in any state) but not the app.
    fn with_engine<T>(
        &self,
        work: impl FnOnce(&mut Engine) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.lock();
        if state.engine.is_none() {
            state.engine = Some(self.load()?);
        }
        let outcome = match state.engine.as_mut() {
            Some(engine) => catch_unwind(AssertUnwindSafe(|| work(engine))),
            None => return Err(cannot_start("引擎没有载入")),
        };
        state.last_used = Instant::now();
        let result = match outcome {
            Ok(result) => result,
            Err(_) => {
                state.engine = None;
                Err("内置 OCR 引擎内部出错，已经重置，请再试一次。".to_string())
            }
        };
        self.watch(&mut state);
        result
    }

    fn load(&self) -> Result<Engine, String> {
        let loaded = catch_unwind(AssertUnwindSafe(|| -> Result<Engine, String> {
            ppocr::load_runtime(&self.0.runtime)?;
            let mut engine = Engine::new(&models(), self.0.threads)?;
            engine.warm_up()?;
            Ok(engine)
        }));
        match loaded {
            Ok(Ok(engine)) => Ok(engine),
            Ok(Err(reason)) => Err(cannot_start(&reason)),
            Err(_) => Err(cannot_start("载入时发生了内部错误")),
        }
    }

    /// Makes sure a thread is waiting to let the engine go when it has been idle long enough.
    fn watch(&self, state: &mut State) {
        if state.watching || state.engine.is_none() {
            return;
        }
        let inner = Arc::downgrade(&self.0);
        let interval =
            (self.0.idle_limit / 4).clamp(Duration::from_millis(20), Duration::from_secs(5));
        let started = std::thread::Builder::new()
            .name("ocr-idle".into())
            .spawn(move || watch_until_idle(&inner, interval));
        match started {
            Ok(_) => state.watching = true,
            Err(error) => eprintln!("[ocr] cannot start the idle thread: {error}"),
        }
    }
}

/// Waits, and lets the engine go once it has not been used for the idle limit. Ends then, or
/// when the engine is gone anyway, or when the whole [`SharedEngine`] is.
fn watch_until_idle(inner: &Weak<Inner>, interval: Duration) {
    loop {
        std::thread::sleep(interval);
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let mut state = match inner.state.try_lock() {
            Ok(state) => state,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            // A picture is being read: the engine is not idle.
            Err(TryLockError::WouldBlock) => continue,
        };
        if state.engine.is_none() || state.last_used.elapsed() >= inner.idle_limit {
            state.engine = None;
            state.watching = false;
            return;
        }
    }
}

/// Where ONNX Runtime is for a program that is the file `exe`: beside it, which is where the
/// installer puts it.
fn runtime_beside(exe: &Path) -> PathBuf {
    exe.parent().unwrap_or(Path::new("")).join(RUNTIME_FILE)
}

/// The engine of the app, which loads ONNX Runtime from the folder of the executable.
pub fn shared() -> &'static SharedEngine {
    static SHARED: OnceLock<SharedEngine> = OnceLock::new();
    SHARED.get_or_init(|| {
        let exe = std::env::current_exe().unwrap_or_default();
        SharedEngine::new(runtime_beside(&exe), IDLE_LIMIT)
    })
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// The ONNX Runtime that `scripts/fetch-onnxruntime.ps1` put into the resources.
    pub fn runtime_dll() -> PathBuf {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ort")
            .join(RUNTIME_FILE);
        assert!(
            dll.is_file(),
            "{} is missing: run scripts/fetch-onnxruntime.ps1 once, then try again",
            dll.display()
        );
        dll
    }

    /// An engine for the tests that only need one: it never lets go of the networks, so the
    /// tests do not pay for loading them again and again.
    pub fn engine() -> &'static SharedEngine {
        static ENGINE: OnceLock<SharedEngine> = OnceLock::new();
        ENGINE.get_or_init(|| SharedEngine::new(runtime_dll(), Duration::from_secs(3600)))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{engine, runtime_dll};
    use super::*;
    use sha2::{Digest, Sha256};

    fn sha256(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn the_models_in_the_program_are_the_published_ones_byte_for_byte() {
        assert_eq!(
            sha256(DETECTOR),
            "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8"
        );
        assert_eq!(
            sha256(RECOGNIZER),
            "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6"
        );
        assert_eq!(
            sha256(DICTIONARY.as_bytes()),
            "c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd"
        );
    }

    #[test]
    fn the_runtime_in_the_resources_is_the_one_that_is_pinned() {
        let pin: serde_json::Value =
            serde_json::from_str(include_str!("../ort-runtime.json")).unwrap();
        let bytes = std::fs::read(runtime_dll()).unwrap();

        assert_eq!(sha256(&bytes), pin["dllSha256"].as_str().unwrap());
    }

    #[test]
    fn a_blank_picture_has_no_text() {
        let white = vec![255u8; 300 * 120 * 4];

        assert_eq!(engine().read_text(300, 120, &white).unwrap(), "");
    }

    #[test]
    fn a_picture_whose_data_does_not_fit_its_size_is_refused() {
        assert!(engine().read_text(300, 120, &[0u8; 10]).is_err());
        assert!(engine().read_text(0, 0, &[]).is_err());
    }

    #[test]
    fn the_networks_are_loaded_on_first_use_and_let_go_after_a_quiet_while() {
        let engine = SharedEngine::new(runtime_dll(), Duration::from_millis(300));
        assert!(!engine.is_loaded());

        let white = vec![255u8; 100 * 50 * 4];
        engine.read_text(100, 50, &white).unwrap();
        assert!(engine.is_loaded());

        let deadline = Instant::now() + Duration::from_secs(10);
        while engine.is_loaded() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !engine.is_loaded(),
            "the networks were still loaded after 10 s"
        );

        // The next picture loads them again.
        engine.read_text(100, 50, &white).unwrap();
        assert!(engine.is_loaded());
    }

    #[test]
    fn using_the_engine_keeps_it_loaded() {
        let engine = SharedEngine::new(runtime_dll(), Duration::from_millis(1500));
        let white = vec![255u8; 100 * 50 * 4];

        // Together these take longer than the idle limit, but no pause is as long as it.
        for _ in 0..6 {
            engine.read_text(100, 50, &white).unwrap();
            std::thread::sleep(Duration::from_millis(400));
            assert!(engine.is_loaded());
        }
    }

    #[test]
    fn warming_up_loads_the_networks_in_the_background() {
        let engine = SharedEngine::new(runtime_dll(), Duration::from_secs(3600));

        engine.warm_up();

        let deadline = Instant::now() + Duration::from_secs(20);
        while !engine.is_loaded() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(engine.is_loaded(), "the engine was not loaded after 20 s");
    }

    #[test]
    fn pictures_read_at_the_same_time_are_read_one_after_the_other() {
        let engine = SharedEngine::new(runtime_dll(), Duration::from_secs(3600));
        let white = vec![255u8; 200 * 80 * 4];

        let readers: Vec<_> = (0..4)
            .map(|_| {
                let engine = engine.clone();
                let white = white.clone();
                std::thread::spawn(move || engine.read_text(200, 80, &white))
            })
            .collect();

        for reader in readers {
            assert_eq!(reader.join().unwrap().unwrap(), "");
        }
    }

    #[test]
    fn a_runtime_that_is_not_there_is_reported_and_tried_again_next_time() {
        let missing = std::env::temp_dir()
            .join("gege-dic-no-such-folder")
            .join(RUNTIME_FILE);
        let engine = SharedEngine::new(missing, Duration::from_secs(3600));
        let white = vec![255u8; 100 * 50 * 4];

        for _ in 0..2 {
            let error = engine.read_text(100, 50, &white).unwrap_err();
            assert!(error.contains("找不到 OCR 运行库"), "{error}");
            assert!(error.contains("重新安装"), "{error}");
            assert!(!engine.is_loaded());
        }
    }

    #[test]
    fn the_runtime_is_looked_for_beside_the_program() {
        let folder = Path::new("install").join("Gege");

        assert_eq!(
            runtime_beside(&folder.join("gege-dic.exe")),
            folder.join(RUNTIME_FILE)
        );
        assert_eq!(
            runtime_beside(Path::new("gege-dic.exe")),
            Path::new(RUNTIME_FILE)
        );
    }

    #[test]
    fn the_installer_is_told_to_carry_the_runtime_beside_the_program_and_the_licenses_in_a_folder()
    {
        // Without this the program builds, and every PC that installs it has no screenshot OCR.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];

        assert_eq!(resources["resources/ort/"], "");
        assert_eq!(resources["resources/licenses/"], "licenses/");
    }

    #[test]
    fn the_number_of_threads_is_between_two_and_four() {
        assert!((2..=4).contains(&default_threads()));
    }
}
