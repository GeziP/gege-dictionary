//! Local screenshot OCR: a GDI picture of one monitor, and the Windows OCR engine
//! (`Windows.Media.Ocr`) reading a region of it.
//!
//! The picture is taken *before* the picker is shown. The picker displays that frozen picture and
//! the user drags a region on it, so what is read is exactly what was seen, and nothing has to be
//! hidden, waited for or photographed a second time. The picture stays in memory (`FrameStore`);
//! it is never written to disk or uploaded.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// The OCR language that is asked for when the settings name none.
pub const DEFAULT_LANGUAGE: &str = "en-US";

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

fn primary_subtag(tag: &str) -> String {
    tag.split('-').next().unwrap_or("").to_ascii_lowercase()
}

/// The installed recognizer that serves `wanted`: that very tag, or else another variant of the
/// same language (`en-GB` reads English as well as `en-US` does). Never a different language: an
/// engine for another language reads English as garbage ("He110", "Librany'").
pub fn pick_recognizer(installed: &[String], wanted: &str) -> Option<String> {
    installed
        .iter()
        .find(|tag| tag.eq_ignore_ascii_case(wanted))
        .or_else(|| {
            installed
                .iter()
                .find(|tag| primary_subtag(tag) == primary_subtag(wanted))
        })
        .cloned()
}

/// What is wrong and how to put it right, for a language whose recognizer is not installed.
pub fn missing_pack_message(installed: &[String], wanted: &str) -> String {
    let (name, add) = if primary_subtag(wanted) == "en" {
        (
            "英文".to_string(),
            "添加 English (United States)".to_string(),
        )
    } else {
        (wanted.to_string(), "添加这种语言".to_string())
    };
    let have = if installed.is_empty() {
        "本机没有安装任何 OCR 识别包".to_string()
    } else {
        format!("本机只有：{}", installed.join("、"))
    };
    format!(
        "没有安装{name} OCR 识别包（{have}）。请到「设置 → 时间和语言 → 语言和区域」{add}，\
         在它的「语言选项」里勾选「光学字符识别」，装好后再试。"
    )
}

/// The answer to "can text be read in a picture": from the recognizers that are installed and the
/// language the settings ask for.
pub fn status_for(installed: &[String], wanted: &str) -> Value {
    match pick_recognizer(installed, wanted) {
        Some(tag) => json!({
            "available": true,
            "language": tag,
            "installed": installed,
            "message": format!("系统 OCR 可用（{tag}）"),
        }),
        None => json!({
            "available": false,
            "language": "",
            "installed": installed,
            "message": missing_pack_message(installed, wanted),
        }),
    }
}

pub fn get_ocr_status(wanted: &str) -> Value {
    match win::installed_languages() {
        Ok(installed) => status_for(&installed, wanted),
        Err(error) => json!({
            "available": false,
            "language": "",
            "installed": Vec::<String>::new(),
            "message": format!("系统 OCR 不可用：{error}"),
        }),
    }
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

/// Reads the text in a region. `wanted` is the language of the text (`en-US`).
pub fn recognize(crop: &Crop, wanted: &str) -> Result<String, String> {
    let text = win::recognize(crop.width, crop.height, &crop.bgra, wanted)?;
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
    use super::*;
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, RGBQUAD, SRCCOPY,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
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

    /// The tags of the languages that have an OCR recognizer installed.
    pub fn installed_languages() -> Result<Vec<String>, String> {
        let languages = OcrEngine::AvailableRecognizerLanguages()
            .map_err(|e| format!("无法读取已安装的 OCR 识别包: {e}"))?;
        let count = languages.Size().map_err(|e| e.to_string())?;
        let mut tags = Vec::with_capacity(count as usize);
        for index in 0..count {
            let language = languages.GetAt(index).map_err(|e| e.to_string())?;
            let tag = language.LanguageTag().map_err(|e| e.to_string())?;
            tags.push(tag.to_string());
        }
        Ok(tags)
    }

    fn create_engine(tag: &str) -> Result<OcrEngine, String> {
        let language = Language::CreateLanguage(&HSTRING::from(tag))
            .map_err(|e| format!("无法创建语言 {tag}: {e}"))?;
        OcrEngine::TryCreateFromLanguage(&language)
            .map_err(|e| format!("无法创建 {tag} 的 OCR 引擎: {e}"))
    }

    /// Hands BGRA pixels to the engine as they are, without an image format in between.
    pub fn software_bitmap_from_bgra(
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> Result<SoftwareBitmap, String> {
        let writer = DataWriter::new().map_err(|e| format!("无法创建缓冲: {e}"))?;
        writer
            .WriteBytes(bgra)
            .map_err(|e| format!("写入像素失败: {e}"))?;
        let buffer = writer
            .DetachBuffer()
            .map_err(|e| format!("读取缓冲失败: {e}"))?;
        SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            width as i32,
            height as i32,
        )
        .map_err(|e| format!("无法创建位图: {e}"))
    }

    pub fn recognize(width: u32, height: u32, bgra: &[u8], wanted: &str) -> Result<String, String> {
        // The blocking `.get()` of a WinRT call needs a COM/WinRT apartment on this thread.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let installed = installed_languages()?;
        let tag = pick_recognizer(&installed, wanted)
            .ok_or_else(|| missing_pack_message(&installed, wanted))?;
        let engine = create_engine(&tag)?;
        let largest = OcrEngine::MaxImageDimension().unwrap_or(10_000);
        if width > largest || height > largest {
            return Err(format!("选区太大：OCR 引擎一边最多读 {largest} 像素"));
        }
        let bitmap = software_bitmap_from_bgra(width, height, bgra)?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("RecognizeAsync: {e}"))?
            .get()
            .map_err(|e| format!("OCR 异步失败: {e}"))?;
        let text = result.Text().map_err(|e| e.to_string())?;
        Ok(text.to_string())
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
    const UNSUPPORTED: &str = "当前平台不支持系统 OCR";

    pub fn capture_region_bgra(
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
    ) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn installed_languages() -> Result<Vec<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn recognize(
        _width: u32,
        _height: u32,
        _bgra: &[u8],
        _wanted: &str,
    ) -> Result<String, String> {
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

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|tag| tag.to_string()).collect()
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
    fn the_recognizer_of_the_language_asked_for_is_used() {
        let installed = tags(&["zh-Hans-CN", "en-US"]);

        assert_eq!(
            pick_recognizer(&installed, "en-US").as_deref(),
            Some("en-US")
        );
        assert_eq!(
            pick_recognizer(&installed, "EN-us").as_deref(),
            Some("en-US")
        );
    }

    #[test]
    fn another_variant_of_the_same_language_will_do() {
        let installed = tags(&["zh-Hans-CN", "en-GB"]);

        assert_eq!(
            pick_recognizer(&installed, "en-US").as_deref(),
            Some("en-GB")
        );
    }

    #[test]
    fn a_recognizer_of_another_language_is_never_picked() {
        // Only the Chinese pack is installed, as on a Chinese Windows that was never given the
        // English one: its engine reads English text as "He110 ... Librany'".
        let installed = tags(&["zh-Hans-CN"]);

        assert_eq!(pick_recognizer(&installed, "en-US"), None);
        assert_eq!(pick_recognizer(&[], "en-US"), None);
    }

    #[test]
    fn the_status_names_the_recognizer_that_will_be_used() {
        let status = status_for(&tags(&["zh-Hans-CN", "en-US"]), "en-US");

        assert_eq!(status["available"], true);
        assert_eq!(status["language"], "en-US");
        assert!(status["message"].as_str().unwrap().contains("en-US"));
    }

    #[test]
    fn without_the_english_pack_the_status_says_so_and_how_to_get_it() {
        let status = status_for(&tags(&["zh-Hans-CN"]), "en-US");

        assert_eq!(status["available"], false);
        assert_eq!(status["installed"], json!(["zh-Hans-CN"]));
        let message = status["message"].as_str().unwrap();
        assert!(message.contains("英文"), "{message}");
        assert!(message.contains("zh-Hans-CN"), "{message}");
        assert!(message.contains("光学字符识别"), "{message}");
    }

    #[test]
    fn with_no_pack_at_all_the_status_says_that_too() {
        let status = status_for(&[], "en-US");

        assert_eq!(status["available"], false);
        assert!(status["message"].as_str().unwrap().contains("没有安装任何"));
    }

    #[test]
    fn a_language_other_than_english_is_named_by_its_tag() {
        let message = missing_pack_message(&tags(&["en-US"]), "ja-JP");

        assert!(message.contains("ja-JP"), "{message}");
        assert!(!message.contains("English (United States)"), "{message}");
    }

    #[test]
    fn blank_space_around_recognized_text_and_its_lines_is_dropped() {
        assert_eq!(normalize_text("  Hello  \n  world \t\n"), "Hello\n  world");
        assert_eq!(normalize_text(" \n \t "), "");
    }

    #[test]
    fn the_status_always_says_whether_and_why() {
        let status = get_ocr_status(DEFAULT_LANGUAGE);

        assert!(status.get("available").is_some());
        assert!(status.get("message").is_some());
    }

    #[test]
    fn max_chars_positive() {
        assert!(max_ocr_chars() > 0);
    }

    #[cfg(windows)]
    #[test]
    fn bgra_pixels_become_a_bitmap_of_the_same_size_for_the_engine() {
        let width = 64u32;
        let height = 32u32;
        let bgra = vec![255u8; (width * height * 4) as usize];

        let bitmap = win::software_bitmap_from_bgra(width, height, &bgra).unwrap();

        assert_eq!(bitmap.PixelWidth().unwrap(), width as i32);
        assert_eq!(bitmap.PixelHeight().unwrap(), height as i32);
    }
}
