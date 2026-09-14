# 鸽鸽词典 V1.7 开发规格

文档状态：规划定稿（可开工评审）

目标版本：1.7.0

版本定位：偿还 v1.6 遗留技术债，补全 Anki 学习闭环与上下文体验，为后续 Authenticode 发布加固留出干净底座。

基线：v1.6.0 + 修复 `7a6108d`（`main`）。

关联 Issue：[#14 自动更新负向验证与 Windows 代码签名](https://github.com/GeziP/gege-dictionary/issues/14)（本版不阻塞，独立推进）。

## 1. 范围与原则

### 1.1 产品原则

- 继续 **零服务端**：无云同步、无账号、无第三方 Anki/OCR。
- v1.7 **不堆新取词入口**，优先「同一条查词管道更稳、闭环更完整」。
- 行为默认不回归：流式仍为默认；`captureContext` 默认 `selection_only`；Anki 仍默认关闭。
- Schema 变更必须走 v1.4.3 风格：单事务 + 预迁移备份 + 失败回滚 + 单测。
- 所有新增指标仅写本机 `local_events`。

### 1.2 非目标

- 不实现 Authenticode 采购与签名（#14，证书就绪后单独小版本）。
- 不做完整 SM-2/FSRS；复习仍为三档 Leitner。
- 不做云 OCR / 云 Anki / 多语种 OCR / 常驻鼠标钩子。
- 不做 macOS/Linux、浏览器扩展。
- 不做 RapidOCR 可选引擎（评估后若做，放 v1.8）。

## 2. E0：合并 lookup 双路径（P0 技术债）

### 2.1 问题

`lookup_word` 与 `lookup_word_stream`（`lib.rs`）前半段 settings/provider/模板/glossary/DPAPI/maxTokens/timeout 约 **150 行几乎逐行拷贝**。改一处漏一处的风险已实际出现过审查分叉（cache 命中 `_templateName`、SSE 回退策略不对称）。

### 2.2 设计

抽出单一准备函数：

```text
prepare_lookup(selection, context, kind, force_refresh, settings)
  -> PreparedLookup {
       cache_key, kind, template, glossary_hits,
       provider, api_key, max_tokens, timeout,
       payload_prompt, cache_hit_entry?
     }
```

- 非流：`prepare` → cache hit 则返回（补全 `_templateName`）→ 否则 `stream_lookup`/一次性请求 → parse → 落库缓存。
- 流式：`prepare` → cache hit 短路并 emit done → 否则 `stream_lookup_sse` + delta → 失败回退仅在 **首字段前** 发生（与现实现一致）。
- **禁止** 再复制第二份 settings 解析；公共错误文案、埋点（`lookup_cache_hit/miss`、`lookup_stream_*`）只在一处。

### 2.3 验收

- [ ] `prepare_lookup` 单测覆盖：cache key、模板匹配、无 Key、forceRefresh 绕过缓存
- [ ] 流式与非流对同一 selection 的最终 Entry 字段集合一致（除 `_fromCache`）
- [ ] cache 命中时两条路径都带 `_templateName`
- [ ] `cargo test --lib` 全绿；主路径手工回归 A1–A5（见 QA 清单）

## 3. E1：Anki 闭环补全（P0 功能）

### 3.1 问题

- 无批量发送：生词库多选后不能一键进 Anki。
- 字段映射固定 Front/Back/Extra，例句已进 Extra 但无法关到 Example 字段。
- 去重仅靠 AnkiConnect `findNotes`；Anki 库清空/重建后无法本地对账。

### 3.2 设计

**批量**

- 生词库 SelectionBar：「发送到 Anki」；调用现有 `send_words_to_anki(ids)`。
- 报告 Toast：`added/skipped/errors`；计入 `anki_send_ok/fail`。

**字段映射（设置页高级折叠）**

| 设置键 | 默认 | 说明 |
|---|---|---|
| `anki.fieldMap.front` | `Front` | |
| `anki.fieldMap.back` | `Back` | |
| `anki.fieldMap.extra` | `Extra` | 空字符串表示不发送 Extra |
| `anki.fieldMap.examples` | `""` | 非空则把例句写入该字段，且不再塞进 Extra |
| `anki.includeExamplesInExtra` | `true` | 与 examples 字段互斥优先 |

Basic 模型未知字段失败时仍回退 Front/Back（现状保留）。

**Schema v5：`anki_note_id`**

```sql
ALTER TABLE words ADD COLUMN anki_note_id TEXT;
CREATE INDEX IF NOT EXISTS idx_words_anki ON words(anki_note_id)
WHERE anki_note_id IS NOT NULL;
```

- 发送成功后把 Anki 返回的 note id 写入本地（`addNote` 结果）。
- 发送前若已有 `anki_note_id`，可先 `notesInfo` 校验；不存在则清空并重发。
- 迁移：单事务；失败回滚；预迁移备份；`upgrades_v4_with_anki_note_id` 单测。

### 3.3 验收

- [ ] 多选 10 词批量发送，Anki 与 Toast 报告正确
- [ ] 映射到自定义 Example 字段成功；Basic 回退不炸
- [ ] v4→v5 迁移测试通过；重复发送不新增卡
- [ ] 未开启 Anki 时批量按钮隐藏或禁用

## 4. E2：真实上下文与查词空态（P1）

### 4.1 上下文

将 `captureContext: boolean` 升级为三档（迁移：`true`→`selection_only`，`false`→`off`）：

| 值 | 行为 |
|---|---|
| `off` | context 空，省 token |
| `selection_only`（默认） | context = selection（兼容 v1.6） |
| `surrounding` | 尽力扩展：见下；失败则退回 selection_only |

`surrounding` v1.7 仅做 **弱启发式**（默认关，设置显式开启才写）：

1. 复制后 800ms 内再次复制，且文本重叠/相邻 → 合并为 context。
2. 记录 `contextSource`: `none|manual|heuristic` 到 `words.data`。

**不做** UIA 全局读屏。

手编重解析保持 v1.6 路径；可选增加 `update_lookup_context` 仅当需要避免整段 LLM 重放时再评估（非必须）。

### 4.2 空态

| 场景 | 文案要点 | 操作 |
|---|---|---|
| 网络失败 | 区分超时 / 连接失败 | 重试 |
| 鉴权失败 | Key 无效或额度 | 去设置 |
| 解析失败 | JSON/流异常 | 重试 / 查看详情 |
| OCR 引擎不可用 | 缺语言包 | 打开语言设置说明 |

实现要点：

- 后端错误带稳定 `code`（`timeout|auth|network|parse|filtered|no_key`），前端按 code 渲染，**不再**靠英文串匹配。
- 查词窗 `gege-lookup-reset` 时同时清空 `lookupResult/lookupStatus/lookupError`，避免旧词条闪现。

### 4.3 验收

- [ ] 三档设置可切换且默认行为与 v1.6 一致
- [ ] heuristic 开启后有单测（重叠合并 / 超时不合并）
- [ ] 四种空态独立文案 + 按钮；连续查词无旧结果闪现

## 5. E3：工程与文档（P0）

- 版本三处同步 `1.7.0`（`package.json` / `Cargo.toml` / `tauri.conf.json`）。
- `RELEASE-NOTES-v1.7.0.md` + README 特色表若有必要微调。
- compose：`docs/compose/spec/v1.7.md`（Problem → Design → Tasks → Verification）。
- PR CI 沿用；新模块必须有 `cargo test --lib`。
- 关闭 #14 的前置说明写入 RELEASE 附录（证书未采购则保持 OPEN）。

## 6. 明确不做

- Authenticode 实际采购与签名流水线（#14）
- lookup 之外的大规模重构（如 DB 抽象层）
- 云同步、账号、多端
- 完整 SRS / 替代 Anki
- 常驻划词钩子、多语种

## 7. Schema 与 Commands

### 7.1 Schema v5

见 §3.2。`LATEST_SCHEMA_VERSION = 5`。

### 7.2 Commands

沿用：

- `send_words_to_anki(ids)` — 增强返回 `noteIds`
- `apply_ocr_hotkey_from_settings`（v1.6 已有）

评估新增（仅当批量/映射不够用）：

```text
update_anki_field_map(settings_patch)   # 可并入 save_settings
get_anki_send_report(ids)               # 可选
```

### 7.3 设置键增量

```text
captureContext: 'off' | 'selection_only' | 'surrounding'
contextHeuristicEnabled: boolean        # surrounding 时是否启用弱启发式
anki.fieldMap / anki.includeExamplesInExtra
```

## 8. 实施任务

| 编号 | 任务 | 依赖 | 估时 |
|---|---|---|---|
| T1 | `prepare_lookup` 抽取 + 双路径接线 | — | 1.5–2d |
| T2 | 双路径行为对齐单测与回归 | T1 | 0.5–1d |
| T3 | Anki 批量 UI + Toast 报告 | — | 0.5d |
| T4 | 字段映射设置 + 发送逻辑 | T3 | 1d |
| T5 | Schema v5 迁移 + noteId 落库 | T4 | 1d |
| T6 | captureContext 三档 + 启发式 | — | 1d |
| T7 | 错误 code 化 + 四空态 + reset 清结果 | — | 1d |
| T8 | 版本/文档/RELEASE/实机清单勾选 | T1–T7 | 0.5d |

建议顺序：T1 → T2 ∥ T3 → T4 → T5；T6 ∥ T7；最后 T8。  
合计约 **7–9 个工作日**（1 人 + AI）。

## 9. Success Metrics（本地可查）

| 指标 | 目标 |
|---|---|
| 双路径分叉事故 | 合并后 0 次「改流式漏非流」类 bug |
| Anki 批量成功率（Anki 已开） | ≥ 95% |
| 重复卡 | 0（deck+Front 或 noteId） |
| 默认 token 消耗 | 与 v1.6 持平（heuristic 默认关） |
| 空态误匹配 | 无 Key/网络错误均可一键恢复 |

## 10. 发布叙事（草案）

> **v1.7 — 一条管道，学得更稳**  
> 合并查词双路径，消灭改一漏一；生词可批量进 Anki，字段可映射，note 落库可对账；上下文三档与可操作空态让默认体验不回归、进阶可控。依旧零服务端。

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 双路径合并引入流式回归 | T2 对齐测试 + 实机 A/B 清单 |
| Schema v5 失败锁库 | 沿用事务+备份+回滚测试 |
| Anki 模型字段名因人而异 | 映射可配置 + Front/Back 回退 |
| 启发式上下文吃 token | 默认关；开启时上限字符（如 500） |

---

关联文档：`docs/PRD-v1.6-spec.md`、`docs/QA-machine-checklist-v1.6.md`、`docs/RELEASE-NOTES-v1.6.0.md`、Issue #14。
