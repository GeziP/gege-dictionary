//! Reading text out of a picture with PP-OCR: a detection network finds the lines of text, a
//! recognition network reads each line. Both are ONNX models run by ONNX Runtime, which is loaded
//! from a DLL at run time so that a machine that cannot load it loses only this feature.

mod detect;
mod geom;
mod layout;
mod recognize;
mod resample;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ort::ep;
use ort::logging::LogLevel;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputs};
use ort::value::TensorRef;

use detect::DetectParams;
use geom::{order_corners, Point};
use layout::{join_lines, TextLine};
use recognize::{Dictionary, HEIGHT};
use resample::{cut_out, resize_into_planes, Crop, Planes};

pub use resample::Pixels;

/// A line the recognition network is less sure of than this is not text.
const MIN_LINE_SCORE: f32 = 0.5;
/// More lines than this on a picture are not read.
const MAX_LINES: usize = 400;

/// The model files, as they are shipped.
pub struct Models<'a> {
    pub detector: &'a [u8],
    pub recognizer: &'a [u8],
    pub dictionary: &'a str,
}

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Loads ONNX Runtime from `dll`. Done once; afterwards asking for the same file does nothing.
/// The library is loaded by this very path, never by name, so no other copy on the machine can
/// stand in for it (Windows has one of its own in the system folder), and a process holds one
/// ONNX Runtime only.
pub fn load_runtime(dll: &Path) -> Result<(), String> {
    static LOADED: Mutex<Option<PathBuf>> = Mutex::new(None);
    if !dll.is_absolute() {
        return Err(format!("OCR 运行库的路径不是绝对路径：{}", dll.display()));
    }
    if !dll.is_file() {
        return Err(format!("找不到 OCR 运行库 {}", dll.display()));
    }
    let mut loaded = LOADED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match loaded.as_deref() {
        Some(path) if path == dll => return Ok(()),
        Some(path) => {
            return Err(format!(
                "OCR 运行库已经从 {} 载入，不能再换成 {}",
                path.display(),
                dll.display()
            ))
        }
        None => {}
    }
    ort::init_from(dll)
        .map_err(|error| format!("无法加载 OCR 运行库 {}：{error}", dll.display()))?
        .with_name("gege-dic")
        .with_telemetry(false)
        .commit();
    *loaded = Some(dll.to_path_buf());
    Ok(())
}

fn build_session(model: &[u8], threads: usize) -> Result<Session, String> {
    Session::builder()
        .map_err(describe)?
        .with_log_level(LogLevel::Error)
        .map_err(describe)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(describe)?
        .with_intra_threads(threads)
        .map_err(describe)?
        .with_inter_threads(1)
        .map_err(describe)?
        // Threads that spin while they wait for work would keep a core busy after the last line.
        .with_intra_op_spinning(false)
        .map_err(describe)?
        // The memory the networks need for a picture is given back when they are done with it.
        // With the default arena the program that keeps the engine loaded would keep a few
        // hundred MB of it for as long as the engine lives.
        .with_execution_providers([ep::CPU::default().with_arena_allocator(false).build()])
        .map_err(describe)?
        .commit_from_memory(model)
        .map_err(describe)
}

/// The two networks, loaded.
pub struct Engine {
    detector: Session,
    recognizer: Session,
    detector_input: String,
    recognizer_input: String,
    dictionary: Dictionary,
    detect: DetectParams,
}

impl Engine {
    /// Loads both networks. [`load_runtime`] has to have succeeded before.
    pub fn new(models: &Models, threads: usize) -> Result<Engine, String> {
        let detector = build_session(models.detector, threads)
            .map_err(|error| format!("无法载入文字检测模型：{error}"))?;
        let recognizer = build_session(models.recognizer, threads)
            .map_err(|error| format!("无法载入文字识别模型：{error}"))?;
        let input_name = |session: &Session| {
            session
                .inputs()
                .first()
                .map(|input| input.name().to_string())
                .ok_or_else(|| "模型没有输入".to_string())
        };
        Ok(Engine {
            detector_input: input_name(&detector)?,
            recognizer_input: input_name(&recognizer)?,
            detector,
            recognizer,
            dictionary: Dictionary::parse(models.dictionary),
            detect: DetectParams::default(),
        })
    }

    /// Runs both networks once on blank pictures, so that the first real picture does not pay for
    /// what the networks do on their first run.
    pub fn warm_up(&mut self) -> Result<(), String> {
        let blank = vec![255u8; 64 * 64 * 3];
        self.read_lines(&Pixels {
            width: 64,
            height: 64,
            channels: 3,
            data: &blank,
        })?;
        let line = Crop {
            width: recognize::MIN_WIDTH,
            height: HEIGHT,
            bgr: vec![255u8; recognize::MIN_WIDTH * HEIGHT * 3],
        };
        self.read_crops(&[&line])?;
        Ok(())
    }

    /// The text of the picture, in reading order.
    pub fn read_text(&mut self, picture: &Pixels) -> Result<String, String> {
        Ok(join_lines(self.read_lines(picture)?))
    }

    /// Every line of text on the picture, with where it is.
    fn read_lines(&mut self, picture: &Pixels) -> Result<Vec<TextLine>, String> {
        if picture.channels < 3
            || picture.width == 0
            || picture.height == 0
            || picture.data.len() != picture.width * picture.height * picture.channels
        {
            return Err("图片的尺寸与数据不符".into());
        }
        let boxes = self.locate(picture)?;
        let mut cut = Vec::with_capacity(boxes.len().min(MAX_LINES));
        for quad in boxes.into_iter().take(MAX_LINES) {
            if let Some(crop) = cut_out(picture, &quad) {
                cut.push((quad, crop));
            }
        }
        let texts = self.read_crops(&cut.iter().map(|(_, crop)| crop).collect::<Vec<_>>())?;
        Ok(cut
            .into_iter()
            .zip(texts)
            .filter(|(_, (text, score))| !text.trim().is_empty() && *score >= MIN_LINE_SCORE)
            .map(|((quad, _), (text, _))| {
                let ys = quad.map(|corner| corner.y);
                TextLine {
                    text,
                    left: quad
                        .map(|corner| corner.x)
                        .into_iter()
                        .fold(f32::MAX, f32::min),
                    top: ys.into_iter().fold(f32::MAX, f32::min),
                    bottom: ys.into_iter().fold(f32::MIN, f32::max),
                }
            })
            .collect())
    }

    /// The boxes of the lines of text on the picture, in its pixels.
    fn locate(&mut self, picture: &Pixels) -> Result<Vec<[Point; 4]>, String> {
        let (width, height) = detect::input_size(picture.width, picture.height, &self.detect);
        let (scale, bias) = detect::input_scale_and_bias();
        let mut input = vec![0.0f32; 3 * width * height];
        resize_into_planes(
            picture,
            width,
            height,
            scale,
            bias,
            &mut input,
            Planes {
                row: width,
                plane: width * height,
            },
        );
        let tensor = TensorRef::from_array_view((
            vec![1i64, 3, height as i64, width as i64],
            input.as_slice(),
        ))
        .map_err(describe)?;
        let inputs: SessionInputs<'_, '_, 0> = SessionInputs::ValueMap(vec![(
            Cow::Borrowed(self.detector_input.as_str()),
            tensor.into(),
        )]);
        let outputs = self.detector.run(inputs).map_err(describe)?;
        let (shape, map) = outputs[0].try_extract_tensor::<f32>().map_err(describe)?;
        if shape.len() != 4 {
            return Err(format!("文字检测模型的输出形状不对：{shape:?}"));
        }
        let (map_height, map_width) = (shape[2] as usize, shape[3] as usize);
        let (across, down) = (
            picture.width as f32 / map_width as f32,
            picture.height as f32 / map_height as f32,
        );
        let (limit_x, limit_y) = (picture.width as f32, picture.height as f32);
        Ok(detect::find_boxes(map, map_width, map_height, &self.detect)
            .into_iter()
            .map(|rect| {
                order_corners(rect.corners().map(|corner| {
                    Point::new(
                        (corner.x * across).round().clamp(0.0, limit_x),
                        (corner.y * down).round().clamp(0.0, limit_y),
                    )
                }))
            })
            .collect())
    }

    /// The text and the confidence of every crop, in the order of the crops.
    fn read_crops(&mut self, crops: &[&Crop]) -> Result<Vec<(String, f32)>, String> {
        let widths: Vec<usize> = crops
            .iter()
            .map(|crop| recognize::scaled_width(crop.width, crop.height))
            .collect();
        let mut results = vec![(String::new(), 0.0f32); crops.len()];
        for batch in recognize::plan_batches(&widths) {
            let lines = batch.members.len();
            let slot = 3 * HEIGHT * batch.width;
            let mut input = vec![0.0f32; lines * slot];
            for (place, &member) in batch.members.iter().enumerate() {
                recognize::fill_slot(
                    crops[member],
                    widths[member],
                    batch.width,
                    &mut input[place * slot..(place + 1) * slot],
                );
            }
            let tensor = TensorRef::from_array_view((
                vec![lines as i64, 3, HEIGHT as i64, batch.width as i64],
                input.as_slice(),
            ))
            .map_err(describe)?;
            let inputs: SessionInputs<'_, '_, 0> = SessionInputs::ValueMap(vec![(
                Cow::Borrowed(self.recognizer_input.as_str()),
                tensor.into(),
            )]);
            let outputs = self.recognizer.run(inputs).map_err(describe)?;
            let (shape, scores) = outputs[0].try_extract_tensor::<f32>().map_err(describe)?;
            if shape.len() != 3
                || shape[0] as usize != lines
                || shape[2] as usize != self.dictionary.classes()
            {
                return Err(format!(
                    "文字识别模型的输出（{shape:?}）与字典（{} 类）不匹配",
                    self.dictionary.classes()
                ));
            }
            let decoded = recognize::decode(
                scores,
                lines,
                shape[1] as usize,
                shape[2] as usize,
                &self.dictionary,
            );
            for (&member, text) in batch.members.iter().zip(decoded) {
                results[member] = text;
            }
        }
        Ok(results)
    }
}
