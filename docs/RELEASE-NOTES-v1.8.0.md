# 鸽鸽词典 V1.8.0

本版本增强生词库交互，偿还核心技术债。

## 生词库

- 表头点击 **排序**：按单词字母、收藏时间、查询次数、掌握度正/逆序排列。
- 多选后可 **批量设置掌握度**（新词 / 巩固中 / 熟悉 / 已掌握），操作后即时 Toast 反馈。

## 工程

- 将 `lib.rs` 中约 750 行查词核心逻辑提取到独立 `lookup.rs` 模块（`prepare_lookup`、`lookup_word`、`lookup_word_stream`、缓存、错误分类等），`lib.rs` 由 2727 → 1985 行。
- 版本三处同步 1.8.0。
- `cargo test --lib` 109 passed；`tsc` / `lint` / vitest 通过。

## 验证

请按 `docs/QA-machine-checklist-v1.6.md` A/B/C 组在 Windows 实机验收。
