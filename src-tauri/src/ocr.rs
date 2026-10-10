//! Local screenshot OCR: a GDI picture of one monitor, and the PP-OCR engine (`ocr_engine`)
//! reading a region of it.
//!
//! The picture is taken *before* the picker is shown. The picker displays that frozen picture and
//! the user drags a region on it, so what is read is exactly what was seen, and nothing has to be
//! hidden, waited for or photographed a second time. The picture stays in memory (`FrameStore`);
//! it is never written to disk or uploaded. The engine is part of the app: it needs no language
//! pack, no network and no setting of the system.

use crate::ocr_engine::{self, SharedEngine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// The shortest side, in pixels, of a region that is worth reading.
const MIN_REGION_SIDE: u32 = 8;

/// A picture of one monitor: BGRA, top-down, every alpha 255. That is the layout GDI produces and
/// the OCR engine takes, so a region of it goes to the engine as it is.
pub struct Frame {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

/// A region of a [`Frame`], in the same layout.
pub struct Crop {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

impl Frame {
    pub fn from_bgra(width: u32, height: u32, mut bgra: Vec<u8>) -> Result<Frame, String> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4));
        if width == 0 || height == 0 || expected != Some(bgra.len()) {
            return Err("屏幕截图的尺寸与数据不符".into());
        }
        // A screen copy leaves the alpha byte as the driver likes (zero on some); the picture is
        // opaque, and an engine that honours alpha must not see it as transparent.
        for pixel in bgra.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        Ok(Frame {
            width,
            height,
            bgra,
        })
    }

    /// Whether nothing at all was seen: every pixel is pure black.
    pub fn is_all_black(&self) -> bool {
        self.bgra
            .chunks_exact(4)
            .all(|pixel| pixel[0] == 0 && pixel[1] == 0 && pixel[2] == 0)
    }

    /// The picture as the picker's canvas wants it: its width and height (4 bytes each, little
    /// endian), then the pixels as RGBA.
    pub fn picker_payload(&self) -> Vec<u8> {
        let mut payload = vec![0u8; 8 + self.bgra.len()];
        payload[..4].copy_from_slice(&self.width.to_le_bytes());
        payload[4..8].copy_from_slice(&self.height.to_le_bytes());
        for (target, source) in payload[8..]
            .chunks_exact_mut(4)
            .zip(self.bgra.chunks_exact(4))
        {
            target[0] = source[2];
            target[1] = source[1];
            target[2] = source[0];
            target[3] = source[3];
        }
        payload
    }

    /// The pixels of a region, cut off where it leaves the picture.
    pub fn crop(&self, x: i32, y: i32, width: i32, height: i32) -> Result<Crop, String> {
        let left = i64::from(x).max(0);
        let top = i64::from(y).max(0);
        let right = (i64::from(x) + i64::from(width)).min(i64::from(self.width));
        let bottom = (i64::from(y) + i64::from(height)).min(i64::from(self.height));
        if width <= 0 || height <= 0 || right <= left || bottom <= top {
            return Err("选区不在截图范围内".into());
        }
        let (crop_width, crop_height) = ((right - left) as u32, (bottom - top) as u32);
        if crop_width < MIN_REGION_SIDE || crop_height < MIN_REGION_SIDE {
            return Err("选区太小，请重新框选".into());
        }
        let stride = self.width as usize * 4;
        let row_bytes = crop_width as usize * 4;
        let mut bgra = Vec::with_capacity(row_bytes * crop_height as usize);
        for row in top as usize..bottom as usize {
            let start = row * stride + left as usize * 4;
            bgra.extend_from_slice(&self.bgra[start..start + row_bytes]);
        }
        Ok(Crop {
            width: crop_width,
            height: crop_height,
            bgra,
        })
    }
}

impl Crop {
    /// Whether every pixel is the same colour. There is no text in such a region, and when the
    /// colour is black it usually means that the screen would not give the picture up (protected or
    /// hardware-accelerated video).
    pub fn is_uniform(&self) -> bool {
        match self.bgra.get(..4) {
            Some(first) => self.bgra.chunks_exact(4).all(|pixel| pixel == first),
            None => true,
        }
    }
}

/// The picture the picker is showing, until the picker is closed.
#[derive(Default)]
pub struct FrameStore {
    frame: Mutex<Option<Frame>>,
    picker_shown: AtomicBool,
    opening: AtomicBool,
    generation: AtomicU64,
}

/// The right to open a picker, held until it is dropped. See [`FrameStore::begin_opening`].
pub struct Opening<'a>(&'a AtomicBool);

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl FrameStore {
    /// Keeps a new picture (the previous one, if any, is dropped). The number that comes back
    /// names this picture, for [`FrameStore::generation`].
    pub fn put(&self, frame: Frame) -> u64 {
        self.picker_shown.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = self.frame.lock() {
            *slot = Some(frame);
        }
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The number of the latest picture. Whoever started something for an earlier picture (a
    /// timer that waits for its picker) can tell by it that the picture is not the one it is
    /// about any more.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Claims the right to open a picker. `None` when one is being opened already: a key that is
    /// held down repeats its hotkey, and a second picker opened over the first would take the
    /// picture of the first away.
    pub fn begin_opening(&self) -> Option<Opening<'_>> {
        if self.opening.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Opening(&self.opening))
        }
    }

    /// Lets the picture go. Called whenever the picker is closed, however it was closed.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.frame.lock() {
            *slot = None;
        }
    }

    pub fn picker_payload(&self) -> Result<Vec<u8>, String> {
        self.with_frame(|frame| Ok(frame.picker_payload()))
    }

    pub fn crop(&self, x: i32, y: i32, width: i32, height: i32) -> Result<Crop, String> {
        self.with_frame(|frame| frame.crop(x, y, width, height))
    }

    /// Notes that the picker page has put the picture on screen.
    pub fn mark_picker_shown(&self) {
        self.picker_shown.store(true, Ordering::SeqCst);
    }

    pub fn picker_was_shown(&self) -> bool {
        self.picker_shown.load(Ordering::SeqCst)
    }

    fn with_frame<T>(
        &self,
        use_frame: impl FnOnce(&Frame) -> Result<T, String>,
    ) -> Result<T, String> {
        let slot = self
            .frame
            .lock()
            .map_err(|_| "截图数据不可用，请重新截图取词".to_string())?;
        match slot.as_ref() {
            Some(frame) => use_frame(frame),
            None => Err("没有可用的截图，请重新截图取词".into()),
        }
    }
}

/// The sentence the check of the engine has it read, and the share of its words that has to come
/// back for the check to pass. Not all of them: the fonts of a PC differ, and a check that fails
/// over a missing letter would be a false alarm.
const CHECK_SENTENCE: &str = "The quick brown fox jumps over the lazy dog";
const CHECK_PIXEL_HEIGHT: i32 = 30;
const CHECK_PASS_SHARE: f32 = 0.7;

/// What the check of the engine found.
struct CheckReport {
    words_found: usize,
    words_asked: usize,
    milliseconds: u128,
}

fn words_of(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Whether `read` is the check sentence, near enough: how many of its words came back out of how
/// many there are, or what is wrong.
fn judge_check(read: &str) -> Result<(usize, usize), String> {
    let asked = words_of(CHECK_SENTENCE);
    // A word that is in the sentence twice has to be read twice.
    let mut left: HashMap<String, usize> = HashMap::new();
    for word in words_of(read) {
        *left.entry(word).or_default() += 1;
    }
    let found = asked
        .iter()
        .filter(|word| match left.get_mut(*word) {
            Some(count) if *count > 0 => {
                *count -= 1;
                true
            }
            _ => false,
        })
        .count();
    if (found as f32) < CHECK_PASS_SHARE * asked.len() as f32 {
        return Err(format!(
            "内置 OCR 引擎自检没有通过：画的是「{CHECK_SENTENCE}」，读出来的是「{}」。",
            normalize_text(read)
        ));
    }
    Ok((found, asked.len()))
}

/// Has the engine read a sentence that was drawn on the spot, the way a screenshot would show
/// it. That uses everything a real reading needs: the runtime library, both networks, the
/// pictures' path through them. Its time includes loading the engine when it is not loaded.
fn check_engine(engine: &SharedEngine) -> Result<CheckReport, String> {
    let (width, height, bgra) = win::render_text(CHECK_SENTENCE, CHECK_PIXEL_HEIGHT, false)
        .map_err(|error| format!("没能生成 OCR 自检用的图片：{error}"))?;
    let started = Instant::now();
    let read = engine.read_text(width, height, &bgra)?;
    let milliseconds = started.elapsed().as_millis();
    let (words_found, words_asked) = judge_check(&read)?;
    Ok(CheckReport {
        words_found,
        words_asked,
        milliseconds,
    })
}

/// The answer to "can text be read in a picture": it is tried, not guessed at.
fn status_of(engine: &SharedEngine) -> Value {
    match check_engine(engine) {
        Ok(report) => json!({
            "available": true,
            "engine": "PP-OCRv6",
            "elapsedMs": report.milliseconds as u64,
            "message": format!(
                "内置 OCR 可用：自检读出了 {}/{} 个词，用时 {} 毫秒",
                report.words_found, report.words_asked, report.milliseconds
            ),
        }),
        Err(message) => json!({
            "available": false,
            "engine": "PP-OCRv6",
            "message": message,
        }),
    }
}

/// Whether the app's own engine can read text, and if not, why not.
pub fn get_ocr_status() -> Value {
    status_of(ocr_engine::shared())
}

/// Takes the picture of a rectangle of the screen (physical pixels, in virtual-screen
/// coordinates). A picture of nothing but black is an error, not a result: it is what a screen
/// that cannot be copied looks like, and showing it would be showing a black screen.
pub fn capture_screen(x: i32, y: i32, width: i32, height: i32) -> Result<Frame, String> {
    let bgra = win::capture_region_bgra(x, y, width, height)?;
    let frame = Frame::from_bgra(width as u32, height as u32, bgra)?;
    if frame.is_all_black() {
        return Err(
            "屏幕截下来是一片纯黑：可能是远程桌面已断开、屏幕已关闭，或者显卡驱动不允许截屏。"
                .into(),
        );
    }
    Ok(frame)
}

/// Starts loading the engine in the background, for a region that is about to be read.
pub fn warm_up_engine() {
    ocr_engine::shared().warm_up();
}

/// Reads the text in a region, whatever language it is in (Chinese and English together too).
pub fn recognize(crop: &Crop) -> Result<String, String> {
    recognize_with(ocr_engine::shared(), crop)
}

fn recognize_with(engine: &SharedEngine, crop: &Crop) -> Result<String, String> {
    let text = engine.read_text(crop.width, crop.height, &crop.bgra)?;
    Ok(normalize_text(&text))
}

/// The text without the blank space at the ends of the text and of each line.
pub fn normalize_text(raw: &str) -> String {
    raw.trim()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn max_ocr_chars() -> usize {
    2000
}

pub fn foreground_window_title() -> String {
    win::foreground_window_title()
}

#[cfg(windows)]
mod win {
    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HANDLE, HWND, SIZE};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW,
        DeleteDC, DeleteObject, GdiFlush, GetDC, GetDIBits, GetTextExtentPoint32W, PatBlt,
        ReleaseDC, SelectObject, SetBkMode, SetTextColor, TextOutW, ANTIALIASED_QUALITY,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLACKNESS, CAPTUREBLT, CLIP_DEFAULT_PRECIS,
        DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FF_DONTCARE, FW_NORMAL, HDC,
        OUT_DEFAULT_PRECIS, RGBQUAD, SRCCOPY, TRANSPARENT, WHITENESS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowTextW, SM_CXVIRTUALSCREEN,
        SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    /// Copies a rectangle of the screen as BGRA. `CAPTUREBLT` makes the copy include layered
    /// windows (without it they are left out, and with them a good part of what a modern desktop
    /// is made of).
    pub fn capture_region_bgra(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
        if width <= 0 || height <= 0 || width > 8192 || height > 8192 {
            return Err("选区尺寸无效".into());
        }
        unsafe {
            let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if x + width <= vx || y + height <= vy || x >= vx + vw || y >= vy + vh {
                return Err("选区不在屏幕范围内".into());
            }
            let screen = GetDC(HWND::default());
            if screen.is_invalid() {
                return Err("无法获取屏幕 DC".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, width, height);
            let prev = SelectObject(mem, bmp);
            // GetDC(NULL) uses the virtual-screen coordinate space (origin may be negative).
            let copied = BitBlt(mem, 0, 0, width, height, screen, x, y, SRCCOPY | CAPTUREBLT);
            SelectObject(mem, prev);
            let _ = ReleaseDC(HWND::default(), screen);
            if copied.is_err() {
                let _ = DeleteObject(bmp);
                let _ = DeleteDC(mem);
                return Err("屏幕截取失败".into());
            }

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                bmiColors: [RGBQUAD::default()],
            };
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                height as u32,
                Some(pixels.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(mem);
            if lines == 0 {
                return Err("读取位图失败".into());
            }
            Ok(pixels)
        }
    }

    /// Draws `text` the way a screenshot of it would look: letters `pixel_height` tall, black on
    /// white, or white on black with `light_on_dark`. Comes back as the width, the height and the
    /// BGRA pixels (the alpha byte is not set). It is drawn in memory: no screen, no window.
    pub fn render_text(
        text: &str,
        pixel_height: i32,
        light_on_dark: bool,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let wide: Vec<u16> = text.encode_utf16().collect();
        if wide.is_empty() || pixel_height < 6 {
            return Err("没有可画的文字".into());
        }
        unsafe {
            let memory = CreateCompatibleDC(HDC::default());
            if memory.is_invalid() {
                return Err("无法创建绘图设备".into());
            }
            let drawn = draw_text(memory, &wide, pixel_height, light_on_dark);
            let _ = DeleteDC(memory);
            drawn
        }
    }

    unsafe fn draw_text(
        memory: HDC,
        wide: &[u16],
        pixel_height: i32,
        light_on_dark: bool,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let font = CreateFontW(
            -pixel_height,
            0,
            0,
            0,
            FW_NORMAL.0 as i32,
            0,
            0,
            0,
            u32::from(DEFAULT_CHARSET.0),
            u32::from(OUT_DEFAULT_PRECIS.0),
            u32::from(CLIP_DEFAULT_PRECIS.0),
            u32::from(ANTIALIASED_QUALITY.0),
            u32::from(DEFAULT_PITCH.0) | u32::from(FF_DONTCARE.0),
            w!("Segoe UI"),
        );
        if font.is_invalid() {
            return Err("无法创建字体".into());
        }
        let previous_font = SelectObject(memory, font);
        let mut extent = SIZE::default();
        let drawn = if GetTextExtentPoint32W(memory, wide, &mut extent).as_bool()
            && extent.cx > 0
            && extent.cy > 0
        {
            draw_on_bitmap(memory, wide, extent, light_on_dark)
        } else {
            Err("无法测量文字".to_string())
        };
        SelectObject(memory, previous_font);
        let _ = DeleteObject(font);
        drawn
    }

    unsafe fn draw_on_bitmap(
        memory: HDC,
        wide: &[u16],
        extent: SIZE,
        light_on_dark: bool,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let margin = extent.cy / 2;
        let (width, height) = (extent.cx + 2 * margin, extent.cy + 2 * margin);
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            bmiColors: [RGBQUAD::default()],
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(
            memory,
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            HANDLE::default(),
            0,
        )
        .map_err(|e| format!("无法创建位图: {e}"))?;
        if bits.is_null() {
            let _ = DeleteObject(bitmap);
            return Err("位图没有像素内存".into());
        }
        let previous_bitmap = SelectObject(memory, bitmap);
        let (background, ink) = if light_on_dark {
            (BLACKNESS, COLORREF(0x00FF_FFFF))
        } else {
            (WHITENESS, COLORREF(0))
        };
        let _ = PatBlt(memory, 0, 0, width, height, background);
        SetBkMode(memory, TRANSPARENT);
        SetTextColor(memory, ink);
        let written = TextOutW(memory, margin, margin, wide).as_bool();
        // Drawing may be queued: the pixels are read only after it is done.
        let _ = GdiFlush();
        let pixels = if written {
            Ok(
                std::slice::from_raw_parts(bits as *const u8, width as usize * height as usize * 4)
                    .to_vec(),
            )
        } else {
            Err("文字没能画出来".to_string())
        };
        SelectObject(memory, previous_bitmap);
        let _ = DeleteObject(bitmap);
        pixels.map(|pixels| (width as u32, height as u32, pixels))
    }

    pub fn foreground_window_title() -> String {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return String::new();
            }
            let mut buf = [0u16; 256];
            let len = GetWindowTextW(hwnd, &mut buf);
            if len <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..len as usize])
        }
    }
}

#[cfg(not(windows))]
mod win {
    const UNSUPPORTED: &str = "当前平台不支持截图取词";

    pub fn capture_region_bgra(
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
    ) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn render_text(
        _text: &str,
        _pixel_height: i32,
        _light_on_dark: bool,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn foreground_window_title() -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture in which each pixel says where it is: blue is its column, green its row.
    fn frame_that_numbers_its_pixels(width: u32, height: u32) -> Frame {
        let mut bgra = Vec::new();
        for row in 0..height {
            for column in 0..width {
                bgra.extend_from_slice(&[column as u8, row as u8, 7, 0]);
            }
        }
        Frame::from_bgra(width, height, bgra).unwrap()
    }

    #[test]
    fn a_picture_whose_data_does_not_fit_its_size_is_refused() {
        assert!(Frame::from_bgra(4, 4, vec![0; 4 * 4 * 4 - 1]).is_err());
        assert!(Frame::from_bgra(0, 4, Vec::new()).is_err());
        assert!(Frame::from_bgra(u32::MAX, u32::MAX, vec![0; 16]).is_err());
    }

    #[test]
    fn every_pixel_of_a_picture_is_opaque() {
        let frame = Frame::from_bgra(2, 1, vec![10, 20, 30, 0, 40, 50, 60, 17]).unwrap();
        assert_eq!(frame.bgra, vec![10, 20, 30, 255, 40, 50, 60, 255]);
    }

    #[test]
    fn a_region_is_cut_out_of_the_picture_pixel_for_pixel() {
        let frame = frame_that_numbers_its_pixels(40, 30);

        let crop = frame.crop(5, 3, 10, 9).unwrap();

        assert_eq!((crop.width, crop.height), (10, 9));
        assert_eq!(crop.bgra.len(), 10 * 9 * 4);
        for row in 0..9usize {
            for column in 0..10usize {
                let at = (row * 10 + column) * 4;
                assert_eq!(
                    crop.bgra[at..at + 4],
                    [5 + column as u8, 3 + row as u8, 7, 255],
                    "pixel {column},{row}"
                );
            }
        }
    }

    #[test]
    fn a_region_that_leaves_the_picture_is_cut_off_at_its_edge() {
        let frame = frame_that_numbers_its_pixels(40, 30);

        let crop = frame.crop(-5, 20, 20, 30).unwrap();

        assert_eq!((crop.width, crop.height), (15, 10));
        assert_eq!(crop.bgra[..4], [0, 20, 7, 255]);
    }

    #[test]
    fn a_region_with_nothing_of_the_picture_in_it_is_an_error() {
        let frame = frame_that_numbers_its_pixels(40, 30);

        assert!(frame.crop(40, 0, 20, 20).is_err());
        assert!(frame.crop(0, 30, 20, 20).is_err());
        assert!(frame.crop(-50, 0, 20, 20).is_err());
        assert!(frame.crop(0, 0, 0, 20).is_err());
        assert!(frame.crop(0, 0, 20, -3).is_err());
        assert!(frame.crop(i32::MAX, 0, i32::MAX, 10).is_err());
    }

    #[test]
    fn a_region_too_small_to_hold_text_is_an_error_that_says_so() {
        let frame = frame_that_numbers_its_pixels(40, 30);

        let error = frame.crop(10, 10, 7, 20).err().unwrap();

        assert!(error.contains("太小"), "{error}");
    }

    #[test]
    fn the_picker_gets_the_size_and_then_rgba_pixels() {
        let frame = Frame::from_bgra(2, 1, vec![1, 2, 3, 0, 4, 5, 6, 0]).unwrap();

        let payload = frame.picker_payload();

        assert_eq!(payload[..4], 2u32.to_le_bytes());
        assert_eq!(payload[4..8], 1u32.to_le_bytes());
        assert_eq!(payload[8..], [3, 2, 1, 255, 6, 5, 4, 255]);
    }

    #[test]
    fn a_picture_of_nothing_but_black_is_noticed() {
        let black = Frame::from_bgra(3, 3, vec![0; 3 * 3 * 4]).unwrap();
        let mut one_lit = vec![0; 3 * 3 * 4];
        one_lit[4 * 8 + 1] = 1;
        let not_black = Frame::from_bgra(3, 3, one_lit).unwrap();

        assert!(black.is_all_black());
        assert!(!not_black.is_all_black());
    }

    #[test]
    fn a_region_of_one_colour_is_noticed() {
        let mut bgra = vec![9u8; 40 * 30 * 4];
        let frame_of_one_colour = Frame::from_bgra(40, 30, bgra.clone()).unwrap();
        // One different pixel inside the region the second picture is cut at.
        bgra[(5 * 40 + 5) * 4] = 200;
        let frame_with_a_mark = Frame::from_bgra(40, 30, bgra).unwrap();

        assert!(frame_of_one_colour.crop(0, 0, 20, 20).unwrap().is_uniform());
        assert!(!frame_with_a_mark.crop(0, 0, 20, 20).unwrap().is_uniform());
        assert!(frame_with_a_mark.crop(20, 10, 20, 20).unwrap().is_uniform());
    }

    #[test]
    fn the_store_holds_the_picture_only_until_it_is_cleared() {
        let store = FrameStore::default();
        assert!(store.picker_payload().is_err());
        assert!(store.crop(0, 0, 20, 20).is_err());

        store.put(frame_that_numbers_its_pixels(40, 30));
        assert_eq!(store.picker_payload().unwrap().len(), 8 + 40 * 30 * 4);
        assert!(store.crop(0, 0, 20, 20).is_ok());

        store.clear();
        assert!(store.picker_payload().is_err());
        assert!(store.crop(0, 0, 20, 20).is_err());
    }

    #[test]
    fn a_new_picture_replaces_the_old_one_and_starts_unshown() {
        let store = FrameStore::default();
        store.put(frame_that_numbers_its_pixels(40, 30));
        store.mark_picker_shown();
        assert!(store.picker_was_shown());

        store.put(frame_that_numbers_its_pixels(50, 20));

        assert!(!store.picker_was_shown());
        assert_eq!(store.picker_payload().unwrap().len(), 8 + 50 * 20 * 4);
    }

    #[test]
    fn every_picture_has_a_number_of_its_own_that_a_timer_can_compare() {
        let store = FrameStore::default();
        let first = store.put(frame_that_numbers_its_pixels(40, 30));
        assert_eq!(store.generation(), first);

        // Letting the picture go is not a new picture: a timer that waits for the picker of
        // this picture is still about it.
        store.clear();
        assert_eq!(store.generation(), first);

        let second = store.put(frame_that_numbers_its_pixels(40, 30));
        assert_ne!(second, first);
        assert_eq!(store.generation(), second);
    }

    #[test]
    fn only_one_picker_is_opened_at_a_time_however_often_the_hotkey_repeats() {
        let store = FrameStore::default();

        let opening = store.begin_opening();
        assert!(opening.is_some());
        assert!(store.begin_opening().is_none());
        assert!(store.begin_opening().is_none());

        drop(opening);
        assert!(store.begin_opening().is_some());
    }

    #[test]
    fn an_opening_that_failed_does_not_block_the_next_one() {
        let store = FrameStore::default();

        let attempt = |fail: bool| -> Result<(), String> {
            let _opening = store.begin_opening().ok_or("busy")?;
            if fail {
                return Err("the screen could not be copied".into());
            }
            Ok(())
        };

        assert!(attempt(true).is_err());
        assert!(attempt(false).is_ok());
    }

    #[test]
    fn blank_space_around_recognized_text_and_its_lines_is_dropped() {
        assert_eq!(normalize_text("  Hello  \n  world \t\n"), "Hello\n  world");
        assert_eq!(normalize_text(" \n \t "), "");
    }

    #[test]
    fn max_chars_positive() {
        assert!(max_ocr_chars() > 0);
    }

    #[test]
    fn words_are_compared_without_case_or_punctuation() {
        assert_eq!(
            words_of("Hello, World!  It's"),
            ["hello", "world", "it", "s"]
        );
        assert!(words_of(" ,. ").is_empty());
    }

    #[test]
    fn the_check_passes_when_most_of_the_sentence_comes_back() {
        // Seven of the nine words are enough: a font that loses a letter is not a broken engine.
        let (found, asked) = judge_check("the quick brown fox jumps over teh iazy dog.").unwrap();

        assert_eq!((found, asked), (7, 9));
        assert_eq!(judge_check(CHECK_SENTENCE).unwrap(), (9, 9));
    }

    #[test]
    fn the_check_fails_on_nonsense_and_says_what_was_read() {
        let error = judge_check("He110 wor1d  Librany'").unwrap_err();

        assert!(error.contains("没有通过"), "{error}");
        assert!(error.contains("He110 wor1d"), "{error}");
        assert!(judge_check("").is_err());
        assert!(judge_check("the quick brown fox").is_err());
    }

    // The tests below draw text with GDI, as a screenshot would show it, and have the real engine
    // read it. They need the ONNX Runtime that scripts/fetch-onnxruntime.ps1 puts into the
    // resources.

    #[cfg(windows)]
    mod reading_drawn_text {
        use super::*;
        use crate::ocr_engine::test_support::engine;
        use std::collections::HashSet;
        use std::time::Duration;

        fn drawn(text: &str, pixel_height: i32, light_on_dark: bool) -> Crop {
            let (width, height, mut bgra) =
                win::render_text(text, pixel_height, light_on_dark).unwrap();
            for pixel in bgra.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            Crop {
                width,
                height,
                bgra,
            }
        }

        /// Copies `part` onto `page` (BGRA, `page_width` wide) with its top left corner at (left, top).
        fn paste(page: &mut [u8], page_width: u32, part: &Crop, left: u32, top: u32) {
            let length = part.width as usize * 4;
            for row in 0..part.height as usize {
                let from = row * length;
                let to = ((top as usize + row) * page_width as usize + left as usize) * 4;
                page[to..to + length].copy_from_slice(&part.bgra[from..from + length]);
            }
        }

        /// Pictures one above the other on a white page as wide as the widest.
        fn stacked(parts: &[Crop]) -> Crop {
            let width = parts.iter().map(|part| part.width).max().unwrap();
            let height: u32 = parts.iter().map(|part| part.height).sum();
            let mut bgra = vec![255u8; (width * height * 4) as usize];
            let mut top = 0;
            for part in parts {
                paste(&mut bgra, width, part, 0, top);
                top += part.height;
            }
            Crop {
                width,
                height,
                bgra,
            }
        }

        /// The share of the words of `expected` that are in `read`.
        fn recall(expected: &str, read: &str) -> f32 {
            let wanted = words_of(expected);
            let got: HashSet<String> = words_of(read).into_iter().collect();
            wanted.iter().filter(|word| got.contains(*word)).count() as f32 / wanted.len() as f32
        }

        const SENTENCE: &str =
            "Memory is not a recording; each time we recall a moment, we rebuild it.";

        #[test]
        fn dark_text_on_a_light_page_is_read() {
            let read = recognize_with(engine(), &drawn(SENTENCE, 28, false)).unwrap();

            assert_eq!(recall(SENTENCE, &read), 1.0, "{read}");
        }

        #[test]
        fn light_text_on_a_dark_page_is_read() {
            let read = recognize_with(engine(), &drawn(SENTENCE, 28, true)).unwrap();

            assert_eq!(recall(SENTENCE, &read), 1.0, "{read}");
        }

        #[test]
        fn small_text_is_read() {
            let read = recognize_with(engine(), &drawn(SENTENCE, 14, false)).unwrap();

            assert!(recall(SENTENCE, &read) >= 0.9, "{read}");
        }

        #[test]
        fn large_text_is_read() {
            let read = recognize_with(engine(), &drawn("Dictionary", 90, false)).unwrap();

            assert_eq!(recall("Dictionary", &read), 1.0, "{read}");
        }

        #[test]
        fn lines_come_back_one_under_the_other_in_the_order_they_are_on_the_page() {
            let lines = [
                "Reading the first line",
                "and then the second one",
                "ends with the third",
            ];
            let page = stacked(&lines.map(|line| drawn(line, 26, false)));

            let read = recognize_with(engine(), &page).unwrap();

            let rows: Vec<&str> = read.lines().collect();
            assert_eq!(rows.len(), 3, "{read}");
            for (row, line) in rows.iter().zip(lines) {
                assert!(recall(line, row) >= 0.99, "{row:?} for {line:?}");
            }
        }

        #[test]
        fn a_region_cut_out_of_a_picture_of_the_screen_is_read() {
            // The way a screen copy comes: pixels as GDI leaves them (alpha byte zero), text well
            // inside the picture, and a region dragged around it with some room to spare.
            let (text_width, text_height, text_pixels) =
                win::render_text(SENTENCE, 24, false).unwrap();
            let text = Crop {
                width: text_width,
                height: text_height,
                bgra: text_pixels,
            };
            let (screen_width, screen_height) = (text_width + 500, text_height + 400);
            let mut screen = vec![255u8; (screen_width * screen_height * 4) as usize];
            for pixel in screen.chunks_exact_mut(4) {
                pixel[3] = 0;
            }
            paste(&mut screen, screen_width, &text, 230, 170);
            let frame = Frame::from_bgra(screen_width, screen_height, screen).unwrap();

            let region = frame
                .crop(
                    200,
                    140,
                    (text_width + 60) as i32,
                    (text_height + 60) as i32,
                )
                .unwrap();
            let read = recognize_with(engine(), &region).unwrap();

            assert_eq!(recall(SENTENCE, &read), 1.0, "{read}");
        }

        #[test]
        fn a_page_without_text_reads_as_nothing() {
            let blank = Crop {
                width: 300,
                height: 80,
                bgra: vec![255; 300 * 80 * 4],
            };

            assert_eq!(recognize_with(engine(), &blank).unwrap(), "");
        }

        #[test]
        fn the_check_of_the_engine_passes_and_says_how_long_it_took() {
            let status = status_of(engine());

            assert_eq!(status["available"], true, "{status}");
            assert!(status["elapsedMs"].is_u64(), "{status}");
            let message = status["message"].as_str().unwrap();
            assert!(message.contains("内置 OCR 可用"), "{message}");
        }

        #[test]
        fn the_check_of_an_engine_that_cannot_start_says_why() {
            let missing = std::env::temp_dir()
                .join("gege-dic-no-such-folder")
                .join("onnxruntime.dll");
            let broken = SharedEngine::new(missing, Duration::from_secs(60));

            let status = status_of(&broken);

            assert_eq!(status["available"], false);
            let message = status["message"].as_str().unwrap();
            assert!(message.contains("找不到 OCR 运行库"), "{message}");
            assert!(message.contains("重新安装"), "{message}");
        }
    }
}
