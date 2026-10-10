use std::path::Path;

fn main() {
    // ONNX Runtime, which runs the OCR networks, is not kept in the repository.
    // scripts/fetch-onnxruntime.ps1 downloads the one pinned in ort-runtime.json into
    // resources/ort, and the installer carries it from there. Without it the app would build and
    // then have no screenshot OCR, so the build stops and says what to do.
    println!("cargo:rerun-if-changed=resources/ort/onnxruntime.dll");
    let runtime = Path::new("resources").join("ort").join("onnxruntime.dll");
    assert!(
        runtime.is_file(),
        "{} is missing. Run scripts/fetch-onnxruntime.ps1 once (it downloads the ONNX Runtime \
         that src-tauri/ort-runtime.json pins), then build again.",
        runtime.display()
    );
    tauri_build::build()
}
