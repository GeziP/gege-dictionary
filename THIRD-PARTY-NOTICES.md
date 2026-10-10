# 第三方组件

鸽鸽词典的截图 OCR 用到下面这些别人的作品。它们都按原样使用，没有改过；许可全文随安装包放在程序旁边的 `licenses/` 文件夹里（源码里是 `src-tauri/resources/licenses/`，ONNX Runtime 的两份由 `scripts/fetch-onnxruntime.ps1` 取回时一并放进去）。

| 组件 | 版本 | 许可 | 在哪里 |
| --- | --- | --- | --- |
| PP-OCRv6 tiny 文本检测与识别模型（PaddleOCR） | PP-OCRv6_tiny_det、PP-OCRv6_tiny_rec | Apache License 2.0，© PaddlePaddle Authors | 编进程序；出处与校验和见 `src-tauri/models/pp-ocrv6/README.md` |
| ONNX Runtime | 1.24.4 | MIT License，© Microsoft Corporation | `onnxruntime.dll`，装在程序旁边；版本与校验和固定在 `src-tauri/ort-runtime.json` |
| Microsoft Visual C++ 运行库 | 构建机上 Visual Studio 里最新的一份，不低于 ONNX Runtime 链接时用的 14.44；实际版本写在 `licenses\README-runtime.txt` | 按 Microsoft 对 Visual Studio 可再分发文件的条款随应用分发 | `vcruntime140.dll`、`vcruntime140_1.dll`、`msvcp140.dll`、`msvcp140_1.dll`，装在程序旁边，ONNX Runtime 需要它们 |
| `ort`（ONNX Runtime 的 Rust 绑定）与 `ort-sys` | 2.0.0-rc.13 | MIT OR Apache-2.0 | 编进程序 |
| `libloading` | 0.9.0 | ISC | 编进程序，用来按路径载入 `onnxruntime.dll` |
| `ndarray`、`matrixmultiply`、`num-complex`、`num-integer`、`rawpointer` | 见 `src-tauri/Cargo.lock` | MIT OR Apache-2.0 | 编进程序（`ort` 的依赖） |

## 模型

- 检测：<https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det>
- 识别（含字符表）：<https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec>
- 项目主页：<https://github.com/PaddlePaddle/PaddleOCR>

模型文件取自 PaddleX 官方发布的 ONNX 推理包，字节与官方一致（`src/ocr_engine.rs` 里有测试逐字节核对 SHA-256）。Apache License 2.0 的全文是 `licenses/LICENSE-Apache-2.0.txt`，署名说明是 `licenses/NOTICE-PP-OCRv6.txt`。

## ONNX Runtime

`onnxruntime.dll` 取自 PyPI 上 `onnxruntime` 1.24.4 的 Windows x64 官方 wheel（下载地址与整个 wheel 的 SHA-256 都固定在 `src-tauri/ort-runtime.json`，DLL 本身的 SHA-256 也在那里，取回后会逐项核对）。MIT 许可全文是 `licenses/LICENSE-onnxruntime.txt`；ONNX Runtime 自己带的第三方组件声明是 `licenses/ThirdPartyNotices-onnxruntime.txt`。

## Visual C++ 运行库

ONNX Runtime 是用动态链接的 Visual C++ 运行库编的。鸽鸽词典自己用静态链接，不需要它，但没装「Microsoft Visual C++ Redistributable」的电脑载入不了 ONNX Runtime，所以把这四个文件按 Microsoft 允许的「随应用部署」方式放在程序旁边。它们取自构建机上的 Visual Studio（版本记在 `licenses/README-runtime.txt` 里）。

## 其他

应用的其余依赖（Tauri、React、rusqlite 等）的许可文本在各自的包里，可以用 `cargo license`、`npm ls` 之类的工具列出；本文件只记截图 OCR 新增的、会以文件或二进制形式分发的部分。
