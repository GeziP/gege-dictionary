# 鸽鸽词典 V1.6 开发规格

文档状态：执行版（规划定稿，可开工）

目标版本：1.6.0

版本定位：补上 Ctrl+C 的能力天花板与学习闭环转化——截图 OCR 取词、Anki Connect 可选同步，并顺手把查词窗上下文与首屏体验做实。

基线：v1.5.0（`21a9d67`）。主场景可用、隐私运行时、本地统计已交付。

关联 Issue：[#13 截图 OCR](https://github.com/GeziP/gege-dictionary/issues/13)、[#14 代码签名](https://github.com/GeziP/gege-dictionary/issues/14)（本版仅评估，不阻塞）。

## 1. 范围与原则

### 1.1 产品原则

- 继续 **零服务端**：OCR 必须用本机引擎；Anki 仅连本机 `127.0.0.1` AnkiConnect。
- 新取词入口不得破坏「复制即查」主路径；OCR 是补充，不是替代。
- 识别结果进入与剪贴板查词 **同一条** Lookup 管道（过滤、缓存、领域解析、生词库、本地统计）。
- 识别原文可包含敏感信息时，沿用 v1.5 过滤与日志脱敏规则。
- 默认不新增网络权限；Anki 未开启时不发起任何 localhost 请求。

### 1.2 非目标

- 不做云 OCR / 在线翻译 OCR（破坏隐私卖点）。
- 不做常驻全局框选鼠标钩子（复杂度与兼容性过高）；只做热键 + 托盘主动触发。
- 不做完整 SM-2 SRS；复习仍以三档 Leitner 为主，Anki 只负责「用户自己的牌组」。
- 不实现 Authenticode 采购与签名（#14 独立推进）。
- 不做 macOS/Linux、多语种 OCR、整页 PDF 解析器。
- 不合并 lookup 双路径（可列为 v1.7 技术债）。

## 2. O0：截图 OCR 取词（P0）

### 2.1 问题

扫描版 PDF、视频字幕、远程桌面、图片中的英文无法 Ctrl+C，当前产品完全覆盖不到。Issue #13 已标为候选。

### 2.2 技术选型（定稿）

| 方案 | 结论 | 理由 |
|---|---|---|
| **Windows.Media.Ocr（WinRT）** | **采用** | 系统自带、免模型下载、中英识别可用、隐私 100% 本机 |
| Tesseract 二进制 | 否决 | 需打包语言包与 exe，体积/许可/更新成本高 |
| 云端 OCR API | 否决 | 违反零服务端与隐私原则 |
| 本地小模型（如 RapidOCR） | 延后 | 可作 v1.7 可选增强，不作为 1.6 阻塞 |

实现形态：Rust 通过 `windows` crate 调 WinRT OCR（`Windows.Media.Ocr.OcrEngine` + `Windows.Globalization.Language`），或在极端兼容问题时用受控 PowerShell 桥接 WinRT（与现有 TTS 模式一致）作为 fallback。

系统要求：Windows 10 1809+（与现网 WebView2 要求基本重叠）；英文识别包未安装时给出可操作提示。

### 2.3 交互

**入口 A — 托盘 / 全局热键（主路径）**

1. 默认热键：`Ctrl+Shift+O`（可改；与全局快捷键插件共存设置）。
2. 屏幕变暗，进入框选；拖拽矩形（或按 Esc 取消）。
3. 松开后本地 OCR → 弹出查词窗，内容类型按现有 `detect_kind` 判定。
4. 选区为空或无英文 → Toast「未识别到英文」，不写缓存。

**入口 B — 托盘菜单「截图取词」**，与热键同一实现。

**入口 C — 设置页「测试 OCR」**：读剪贴板图片或示例区域，验证引擎可用性。

框选 UI：无边框置顶窗，半透明遮罩，矩形角标；不抢焦点策略与查词窗一致（参考 `clipboard_watcher::position_lookup_window`）。

### 2.4 管道接入

```text
截图 → CroppedBitmap → OcrEngine.RecognizeAsync
     → lines[].Text 拼接（保留换行）
     → content_filter::reject_reason（与剪贴板相同）
     → last_capture + trigger lookup（复用现有命令）
     → local_events: ocr_triggered / ocr_filtered
```

- `sourceApp` 固定为 `screenshot`（或前台窗口进程名 + 标注）。
- `sourceTitle` 使用前台窗口标题，便于阅读会话聚合。
- 识别文本超过 2000 字符时截断到段落边界并提示「已截取前 N 字」。
- **不** 把截图位图写入磁盘或数据库；仅内存处理。

### 2.5 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `ocrEnabled` | `true` | 总开关；关闭则不注册热键、不显示托盘项 |
| `ocrHotkey` | `Ctrl+Shift+O` | 与现有 shortcut 插件统一配置 |
| `ocrLanguage` | `en-US` | 可选 `en-US` / `en-GB` / 跟随系统 |

### 2.6 验收

- [ ] 热键可框选并弹出查词窗；Esc 取消无副作用
- [ ] 扫描 PDF 截图中的英文可识别并完成一次完整 LLM 解析
- [ ] 识别结果走 content_filter；密码截图不发送
- [ ] 无 OCR 语言包时错误可读，且不崩溃
- [ ] 本地统计出现 `ocr_triggered`；关闭开关后热键失效
- [ ] 单元测试：行拼接、截断、拒绝空结果（引擎 mock / 纯函数层）

## 3. O1：Anki Connect 可选同步（P0）

### 3.1 问题

生词导出 TSV 再手工导入 Anki 转化率极低；Saladict 因 Anki Connect 形成学习闭环优势。本产品不做完整 SRS，但应让用户「一键进自己的 Anki」。

### 3.2 约束

- 仅 HTTP `127.0.0.1:8765`（AnkiConnect 默认端口，可配置）。
- **默认关闭**；开启前不发任何请求。
- 协议：`api` 版本 6，动作：`requestPermission`、`deckNames`、`modelNames`、`addNote`、`updateNoteFields`（可选）。
- 失败必须可恢复：Anki 未开 → 明确提示「请启动 Anki 并安装 AnkiConnect」。

### 3.3 数据映射

| 生词字段 | Anki 字段（默认映射） |
|---|---|
| lemma | Front |
| translation + contextMeaning | Back |
| explanation | Extra |
| examples[].en / zh | Example（模板可改） |
| tags | Note tags（含来源 app、领域 profile） |
| sourceApp / savedAt | 可选字段 |

牌组与笔记类型可在设置中选择；首次连接时拉取列表缓存到 settings（本地）。

### 3.4 交互

1. 设置 → 「Anki 同步」：开关、地址、牌组、笔记类型、字段映射（默认模板即可用）。
2. 「测试连接」：`requestPermission` + 显示 Anki 版本。
3. 生词详情 / 批量选择：「发送到 Anki」按钮；成功 Toast，失败给排查步骤。
4. 可选：收藏成功后自动发送（默认关，避免误推）。
5. 已发送词条记录 `ankiNoteId`（JSON blob 或独立列，schema v5 若需要）。

### 3.5 验收

- [ ] 未开启时零网络请求（可用日志/断言验证）
- [ ] 连接成功后可列出牌组；发送单词后 Anki 中可见
- [ ] 重复发送同一 lemma 不产生重复卡（按 deck+front 查询或标记 noteId）
- [ ] Anki 未启动时错误文案可操作
- [ ] 关闭开关后 UI 隐藏发送入口

## 4. O2：真实上下文捕获（P1）

### 4.1 问题

当前 `context ≈ selection`，语境义依赖模型脑补；句子/段落质量受「无邻近上下文」限制。

### 4.2 设计（保守、可关闭）

- 设置 `captureContext` 从「仅复制文本」升级为两档：
  - `off`：context 为空（省 token）
  - `selection_only`（默认，兼容现状）
  - `surrounding`：**尽力** 从剪贴板扩展（见下）
- v1.6 **不** 做全局 UIA 读屏（兼容性差、权限敏感）。
- 「surrounding」实现策略：
  1. 复制后若用户在 800ms 内再次复制且两次文本有重叠/相邻特征 → 合并（弱启发式，默认关）。
  2. 提供「手动补上下文」：查词窗内可粘贴/编辑 context 后重新解析（低风险、立刻有用）。
- 记录 `contextSource`: `none` | `manual` | `heuristic` 到 `words.data`，便于复盘。

### 4.3 验收

- [ ] 查词窗可编辑 context 并「用新上下文重新解析」
- [ ] 默认行为与 v1.5 一致（不回归 token 消耗）
- [ ] 启发式合并默认关闭，开启后有单测覆盖边界

## 5. O3：查词窗体验补强（P1）

| 项 | 要求 |
|---|---|
| 去掉 `location.reload()` | 重用窗口时增量重置状态，避免闪白（`clipboard_watcher.rs`） |
| 首字段进度 | 流式首字段到达时高亮/骨架切换，P50 视觉反馈 <1s（已有埋点，UI 对齐） |
| OCR / 复制统一空态 | 未识别、已过滤、无 Key、网络失败四种空态文案可操作 |
| 字体与主题 | 沿用 v1.5 设置，不新增主题系统 |

### 验收

- [ ] 连续三次查词无白屏闪烁
- [ ] 四种空态有独立文案与按钮（去设置 / 重试 / 关闭）

## 6. 明确不做（再次强调）

- 云 OCR、云同步、账号
- 浏览器扩展、多语种泛化
- 完整 SRS / 替代 Anki
- Authenticode（#14，证书就绪后单独小版本）
- 常驻鼠标钩子划词

## 7. Schema 与 Commands

### 7.1 Schema v5（若需要）

```sql
-- 仅当需要持久化 Anki 映射时
ALTER TABLE words ADD COLUMN anki_note_id TEXT;
CREATE INDEX IF NOT EXISTS idx_words_anki ON words(anki_note_id)
WHERE anki_note_id IS NOT NULL;
```

迁移保持 v1.4.3 风格：单事务 + 预迁移备份 + 失败回滚。

### 7.2 新增 Commands（示意）

```text
ocr_recognize_region(rect) -> OcrResult
get_ocr_status() -> { available, languages, message }
test_anki_connection(config) -> { ok, version, error? }
list_anki_decks() -> string[]
list_anki_models() -> string[]
send_words_to_anki(ids, config) -> SendReport
update_lookup_context(requestId, context) -> Entry   # O2 重解析
```

本地统计新增事件：`ocr_triggered`、`ocr_filtered`、`anki_send_ok`、`anki_send_fail`。

## 8. 工程与发布

- PR CI 沿用 v1.5 `ci.yml`；Rust 新增模块需 `cargo test --lib` 覆盖纯函数。
- 前端 Vitest：Anki 设置表单、OCR 开关注册/注销热键逻辑（mock bridge）。
- 版本三处同步 `1.6.0`；`RELEASE-NOTES-v1.6.0.md` + README 特色表更新。
- 实机验收清单写入 compose 文档：扫描 PDF、视频截图、Anki 桌面端、无语言包环境。

## 9. 实施任务

| 编号 | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T1 | WinRT OCR 封装 + 状态检测 | — | 纯图片内存识别英文行 |
| T2 | 框选窗 + 热键 + 托盘入口 | T1 | Ctrl+Shift+O 完整走通 |
| T3 | OCR 接入 Lookup 管道与统计 | T2 | 与剪贴板查词同构 |
| T4 | AnkiConnect 客户端 + 设置 UI | — | 测试连接 / 列牌组 |
| T5 | 发送生词与去重 | T4 | Anki 中可见且可重发不重复 |
| T6 | 上下文手编重解析 | — | 查词窗可改 context 重查 |
| T7 | 查词窗去 reload + 空态 | T3 | 无闪白；四空态 |
| T8 | 文档 / Issue / 版本 / README | T1–T7 | 可发 1.6.0 |

建议顺序：T1 ∥ T4 ∥ T6 → T2 → T3 → T5 → T7 → T8。

## 10. 工作量与节奏

| 块 | 估时（1 人 + AI 助手） |
|---|---|
| O0 OCR | 4–6 天（框选 UI + WinRT 兼容调试占大头） |
| O1 Anki | 2–3 天 |
| O2 上下文 | 1 天 |
| O3 体验 | 1–2 天 |
| 文档/验收/发版 | 1 天 |
| **合计** | **约 2 周** |

风险：WinRT OCR 在部分精简 LTSC / 未装识别包机器不可用 → 必须有优雅降级与文档说明；AnkiConnect 版本差异 → 只依赖稳定 action 子集。

## 11. Success Metrics（本地统计可查）

| 指标 | 目标 |
|---|---|
| OCR 触发成功率（有英文文本） | ≥ 90% |
| OCR 误触发/空选取消 | 不产生缓存脏数据 |
| Anki 发送成功率（Anki 已开） | ≥ 95% |
| 复制主路径回归 | v1.5 误触发与缓存命中不劣化 |
| 手编上下文重解析 | 功能可达；默认 token 不升 |

## 12. 发布叙事

> **v1.6 — 截得下，也学得走**  
> 系统级截图 OCR 覆盖扫描件与视频字幕；可选一键同步到本机 Anki；查词窗支持补上下文重解析，首屏更稳。依旧零服务端、数据全本地。

---

关联文档：`docs/PRD-v1.5-spec.md`、`docs/ROADMAP-v1.1-v1.3.md`、`docs/RELEASE-NOTES-v1.5.0.md`、Issue #13 #14。
