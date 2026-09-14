# 鸽鸽词典 V1.7.0

本版本偿还 v1.6 技术债，补全 Anki 学习闭环与查词体验：合并 lookup 双路径、批量/可映射 Anki、上下文三档与可操作空态。

## 查词管道

- 抽取 `prepare_lookup`，`lookup_word` / `lookup_word_stream` 共用 settings、模板、glossary、DPAPI、缓存键逻辑，消除双路径分叉。
- 缓存命中时流式与非流均注入 `_templateName` 与 `fromCache`。

## Anki

- 生词库多选后可 **批量「发送到 Anki」**，Toast 汇总成功/跳过/失败。
- 设置支持 **字段映射**（Front/Back/Extra/可选 Example）；Basic 模型自动回退 Front/Back。
- Schema **v5**：`words.anki_note_id`，发送成功落库，重复发送可跳过。

## 上下文与空态

- `captureContext` 三档：关闭 / 仅选中文本（默认）/ 尽力扩展（启发式默认关）。
- 查词窗 reset 清空旧结果；错误带 `[auth|timeout|network|no_key|filtered]` 前缀，空态给出对应操作。

## 工程

- 版本三处同步 1.7.0。
- `cargo test --lib` 109 passed / 1 ignored；`tsc` / `lint` / vitest / `build` 通过。

## 验证

请按 `docs/QA-machine-checklist-v1.6.md` A/B/C 组在 Windows 实机验收；Anki 需 AnkiConnect，OCR 需英文识别包。
