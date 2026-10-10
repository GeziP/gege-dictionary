# PP-OCRv6 tiny models

The screenshot OCR reads text with these models. They are embedded into the program
(`include_bytes!` in `src/ocr_engine.rs`) and run by ONNX Runtime; nothing is downloaded when the
app runs, and no picture leaves the PC.

| File | What it is | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `det.onnx` | PP-OCRv6 tiny text-line **detection** | 1,780,590 | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` |
| `rec.onnx` | PP-OCRv6 tiny text-line **recognition** (Chinese, English) | 4,462,639 | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` |
| `dict.txt` | The 6,904 characters the recognition model knows, one per line (a line may be a single space) | 27,156 | `c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd` |

A test in `src/ocr_engine.rs` checks these digests, so a file that was changed (or whose line
endings were changed by a checkout; `.gitattributes` keeps git from doing that) fails the build.

## Where they come from

Unmodified, from the official PaddleX inference bundles of PaddleOCR:

- `det.onnx` = `inference.onnx` in
  `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar`
- `rec.onnx` = `inference.onnx` in
  `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar`
- `dict.txt` = the `character_dict` entries of `inference.yml` in the same recognition bundle
  (YAML quotes removed, one entry per line, in order).

Model cards: [PP-OCRv6_tiny_det](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det),
[PP-OCRv6_tiny_rec](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec).

## License

Apache License 2.0, © PaddlePaddle Authors (stated on both model cards). The license text and the
notice ship with the app in `licenses/`.

## How they are used

Both networks take BGR pictures. The detection network gets the picture scaled to multiples of 32
(normalised with the ImageNet mean and deviation) and answers with a probability map of text
pixels; the recognition network gets each line cut out at a height of 48 pixels (normalised to
-1..1) and answers with a score per character class for every 8 pixels of width, which is decoded
with CTC (class 0 is the blank, then the dictionary in file order, then a space). See
`src/ppocr/`.
