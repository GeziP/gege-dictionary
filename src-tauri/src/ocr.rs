//! Local screenshot OCR via Windows WinRT (Windows.Media.Ocr) + GDI capture.
//! Capture stays in memory only; never written to disk or uploaded.

use serde_json::{json, Value};

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        RGBQUAD, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

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
            let ok = BitBlt(mem, 0, 0, width, height, screen, x, y, SRCCOPY);
            SelectObject(mem, prev);
            let _ = ReleaseDC(HWND::default(), screen);
            if ok.is_err() {
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
                    biCompression: BI_RGB.0 as u32,
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

    fn software_bitmap_from_png(
        png: &[u8],
    ) -> Result<windows::Graphics::Imaging::SoftwareBitmap, String> {
        let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
        writer
            .WriteBytes(png)
            .map_err(|e| format!("写入流失败: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| format!("StoreAsync: {e}"))?;
        writer
            .FlushAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| format!("FlushAsync: {e}"))?;
        stream.Seek(0).map_err(|e| format!("Seek: {e}"))?;

        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| format!("BitmapDecoder: {e}"))?;
        decoder
            .GetSoftwareBitmapAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| format!("GetSoftwareBitmap: {e}"))
    }

    fn bgra_to_software_bitmap(
        bgra: &[u8],
        width: u32,
        height: u32,
    ) -> Result<windows::Graphics::Imaging::SoftwareBitmap, String> {
        let img = image::RgbaImage::from_raw(width, height, bgra.to_vec()).ok_or("位图缓冲无效")?;
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        software_bitmap_from_png(&png.into_inner())
    }

    fn try_engine(lang: Option<&str>) -> Result<String, String> {
        if let Some(tag) = lang {
            let language = Language::CreateLanguage(&HSTRING::from(tag))
                .map_err(|e| format!("语言包: {e}"))?;
            let _engine =
                OcrEngine::TryCreateFromLanguage(&language).map_err(|e| format!("引擎: {e}"))?;
            return Ok(tag.to_string());
        }
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|e| format!("用户语言引擎: {e}"))?;
        let recog = engine.RecognizerLanguage().map_err(|e| e.to_string())?;
        let tag = recog.LanguageTag().map_err(|e| e.to_string())?;
        Ok(tag.to_string())
    }

    fn create_engine(lang: Option<&str>) -> Result<OcrEngine, String> {
        if let Some(tag) = lang {
            let language = Language::CreateLanguage(&HSTRING::from(tag))
                .map_err(|e| format!("无法创建语言 {tag}: {e}"))?;
            OcrEngine::TryCreateFromLanguage(&language)
                .map_err(|e| format!("无法创建 OCR 引擎: {e}"))
        } else {
            OcrEngine::TryCreateFromUserProfileLanguages()
                .map_err(|e| format!("无法创建 OCR 引擎: {e}"))
        }
    }

    pub fn ocr_status() -> Value {
        match try_engine(Some("en-US")) {
            Ok(_) => json!({
                "available": true,
                "language": "en-US",
                "message": "系统 OCR（英文）可用"
            }),
            Err(e) => match try_engine(None) {
                Ok(lang) => json!({
                    "available": true,
                    "language": lang,
                    "message": format!("系统 OCR 可用（{lang}）")
                }),
                Err(e2) => json!({
                    "available": false,
                    "language": "",
                    "message": format!("系统 OCR 不可用: {e} / {e2}")
                }),
            },
        }
    }

    pub fn foreground_window_title() -> String {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
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

    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    pub fn recognize_region(
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        lang: Option<&str>,
    ) -> Result<String, String> {
        // WinRT async .get() requires COM/WinRT apartment on this thread.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let bgra = capture_region_bgra(x, y, width, height)?;
        let bitmap = bgra_to_software_bitmap(&bgra, width as u32, height as u32)?;
        let engine = create_engine(lang).or_else(|_| create_engine(None))?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("RecognizeAsync: {e}"))?
            .get()
            .map_err(|e| format!("OCR 异步失败: {e}"))?;
        let text = result.Text().map_err(|e| e.to_string())?;
        Ok(text.to_string())
    }
}

#[cfg(not(windows))]
mod win {
    use super::*;

    pub fn ocr_status() -> Value {
        json!({
            "available": false,
            "language": "",
            "message": "当前平台不支持系统 OCR"
        })
    }

    pub fn recognize_region(
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
        _lang: Option<&str>,
    ) -> Result<String, String> {
        Err("当前平台不支持系统 OCR".into())
    }

    pub fn foreground_window_title() -> String {
        String::new()
    }
}

pub fn get_ocr_status() -> Value {
    win::ocr_status()
}

/// Recognize English text in a screen region. Coordinates are physical pixels.
pub fn recognize_screen_region(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    language: Option<&str>,
) -> Result<String, String> {
    let text = win::recognize_region(x, y, width, height, language)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let normalized = trimmed
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(normalized)
}

pub fn max_ocr_chars() -> usize {
    2000
}

pub fn foreground_window_title() -> String {
    win::foreground_window_title()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_status_is_object() {
        let v = get_ocr_status();
        assert!(v.get("available").is_some());
        assert!(v.get("message").is_some());
    }

    #[test]
    fn max_chars_positive() {
        assert!(max_ocr_chars() > 0);
    }
}
