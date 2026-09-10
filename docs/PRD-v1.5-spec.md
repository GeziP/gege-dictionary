# 鸽鸽词典 V1.5 开发规格

文档状态：执行版

目标版本：1.5.0

版本定位：不堆新大功能，把主场景（IDE / 浏览器 / 阅读器复制查词）做稳，把隐私卖点在运行时兑现，并让 Success Metrics 本地可核验。

基线：v1.4.4（`ffab072`）。数据迁移、备份、导入已在 v1.4.3/4 收敛。

## 1. 范围与原则

V1.5 核心范围由四部分组成：取词主场景纠正、过滤误杀治理、隐私运行时补丁、本地可观测。

### 1.1 产品原则

- 目标用户是英文阅读中的技术人员与职场用户；IDE、浏览器、PDF 阅读器是主场景，不能默认静默禁用。
- 过滤的职责是「拦住不该发给模型的内容」，不是「拦住看起来像代码的英文句子」。
- 隐私承诺必须落在运行时：CSP、日志、API Key 桥接面，而不只是磁盘 DPAPI 与 README 文案。
- 所有新增埋点仅写本机 SQLite，不上传、不新增网络请求。
- 继续零服务端；本版本不引入 OCR、云同步、Anki Connect、新领域。

### 1.2 非目标

- 不实现截图 OCR（继续由 Issue #13 独立选型）。
- 不实现 Windows Authenticode 代码签名（Issue #14，采购证书后单独版本）。
- 不合并 `lookup_word` / `lookup_word_stream` 双路径（重要，但属重构债，避免与行为变更纠缠）。
- 不做多语种、浏览器扩展、完整 SRS、云同步。
- 不修改 schema 版本号以外的破坏性变更；若埋点需要新表，走 schema v4 迁移。

## 2. K0：取词主场景纠正

### 2.1 问题

`clipboard_watcher.rs` 默认黑名单包含：

```text
1password, keepass, bitwarden, lastpass,
cmd.exe, powershell.exe, pwsh.exe, windowsterminal.exe,
code.exe, devenv.exe, idea64.exe
```

开发者在 VS Code / Visual Studio / IDEA 中复制英文文档或注释时，smart 模式永不弹窗。产品主打技术读者，却在主场景静默失效。

### 2.2 设计

**默认黑名单只保留密码管理器**：

```text
1password, keepass, bitwarden, lastpass
```

移除：终端（cmd / powershell / pwsh / Windows Terminal）与 IDE（code / devenv / idea64）。

**新增设置**：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `lookupInIde` | boolean | `true` | 为 false 时，额外使用「IDE/终端软黑名单」拦截 |
| `ideBlacklist` | string[] | 见下 | 仅在 `lookupInIde=false` 时生效 |

默认 `ideBlacklist` 预填（不再写死进代码路径）：

```text
code.exe, devenv.exe, idea64.exe, cursor.exe,
cmd.exe, powershell.exe, pwsh.exe, windowsterminal.exe
```

**行为矩阵**：

| 前台进程 | `lookupInIde=true`（默认） | `lookupInIde=false` |
|---|---|---|
| 密码管理器 | 拦截 | 拦截 |
| IDE / 终端 | **放行** | 拦截 |
| 其他应用 | 按现有逻辑 | 按现有逻辑 |
| 自定义黑名单 | 始终生效 | 始终生效 |

匹配规则不变：进程名或窗口标题 contains（大小写不敏感）。

### 2.3 设置 UI

`CaptureSection.tsx` 增加：

- 开关「在 IDE / 终端中查词」（绑定 `lookupInIde`）
- 关闭开关时展开「IDE / 终端进程」编辑框（逗号 / 换行分隔，复用现有 blacklist 输入样式）
- 说明文案：默认开启，避免在开发场景复制英文时无法查词；仅复制代码仍会被内容过滤拦截

### 2.4 验收

- [ ] 默认配置下，在 VS Code 复制自然英文句子会弹出查词窗（不再因 `code.exe` 被拦）
- [ ] 默认配置下，复制 1Password / Bitwarden 等仍被拦
- [ ] 关闭「在 IDE / 终端中查词」后，IDE / 终端恢复拦截；密码管理器仍拦
- [ ] 自定义黑名单在两种开关状态下均生效
- [ ] 设置可持久化，重启后保持；升级用户不会被旧默认值锁死在 IDE 屏蔽

## 3. K1：过滤误杀治理

### 3.1 问题

`content_filter.rs::is_code_snippet` 对**首行前缀**做单指标命中即拒：

- `import ` / `from ` / `type ` / `const ` / `let ` / `var ` 等
- 导致 `import the data from Excel`、`From now on`、`Constant practice matters` 等自然英语被拒
- 安全前缀列表（`sk-`、`ghp_` 等）与高熵检测合理，应保留

### 3.2 设计

**原则**：自然语言误杀率优先于代码拦截率；密码 / 密钥 / 路径 / 邮箱 / IP 等安全类规则不变。

#### A. 关键字前缀改为「强语境」才拒

下列前缀 **单独出现不足以拒绝**，须再满足至少一项：

- 同行或全文出现配对符号：`()` `[]` `{}` 且含 `;` `=>` `->` `::` 之一
- 缩进 ≥ 2 个 tab 或 ≥ 4 个空格且同行含 `{` `;`
- 该词后紧跟标识符特征：`import numpy`、`from x import y`、`const x =`、`let mut`、`type Foo =`

弱语境示例（**应放行**）：

- `import the data from Excel`
- `From now on, always validate`
- `Constant practice matters`
- `type the answer in the box`

强语境示例（**应拒绝**）：

- `import numpy as np`
- `from typing import List`
- `const x = 1;`
- `type Foo = { a: number }`

#### B. 保留的强拒绝（不受 A 影响）

- `#include` / `pub fn` / `async fn` / `impl ` / `namespace ` 等几乎不会出现在自然句首
- 多行结构：≥3 行中 ≥2 行以 `;` `{` `}` `//` `#` 结尾或开头（维持现状）

#### C. 安全类规则不动

- `is_secret`：密钥前缀 + 高熵无空格串
- `is_file_path` / `is_email` / `is_ip_address` / `is_base64_blob`

#### D. 返回原因（为 K3 埋点铺路）

`should_reject` 升级为：

```rust
pub enum FilterReason {
    Empty,
    Secret,
    FilePath,
    Code,
    Base64,
    Email,
    IpAddress,
}

pub fn reject_reason(text: &str) -> Option<FilterReason>;
pub fn should_reject(text: &str) -> bool { reject_reason(text).is_some() }
```

调用方（`clipboard_watcher`）记录 `reason` 到本地事件表，**不记录原文**。

### 3.3 验收

- [ ] 单测覆盖 §3.2 弱语境全部放行、强语境全部拒绝
- [ ] 既有安全类单测全部保持通过
- [ ] `import the data from Excel`、`From now on` 在实机查词弹窗
- [ ] `import numpy as np`、含 `;` 的代码行仍被过滤
- [ ] 密码 / 路径 / 高熵串行为与 v1.4.4 一致

## 4. K2：隐私运行时补丁

### 4.1 问题

| 缺口 | 证据 | 风险 |
|---|---|---|
| CSP 关闭 | `tauri.conf.json` `"csp": null` | WebView 无第二道防线 |
| stderr 可能输出 selection | `lib.rs:721`、`lib.rs:1302`、`clipboard_watcher.rs` 多处 | 与「敏感内容不落日志」承诺冲突 |
| API Key 整份 settings 下发 | `get_settings` 解密后原样返回 | 磁盘有 DPAPI，运行时桥接面无隔离 |

### 4.2 设计

#### A. 最小可用 CSP

```json
"security": {
  "csp": "default-src 'self'; img-src 'self' asset: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost"
}
```

约束：

- 不引入远程脚本 / 远程字体
- 若 Tauri 2 与现有 `react-markdown` / framer-motion 实测需要额外指令，只允许加到 **style-src / img-src**，不得放宽 `script-src` / `connect-src`
- 打包后实机：主窗口、查词窗、设置页、Markdown 渲染、代码卡片复制均可用
- 若某第三方资源被拦，优先改前端资源引用，而不是放宽 CSP

#### B. 日志脱敏

统一规则：

- **禁止**打印 selection / context / 翻译正文 / API Key / 完整剪贴板内容
- 允许打印：长度、kind、模型名、协议、缓存命中、耗时、错误码、FilterReason
- 新增 helper（`lib.rs` 或 `log_util.rs`）：

```rust
fn log_selection_meta(prefix: &str, selection: &str, kind: &str) {
    eprintln!("{prefix} len={} kind={kind} head_hash={:x}", selection.len(), sha256_8(selection));
}
```

必须改造的调用点（至少）：

- `lib.rs`：`lookup_word` / `lookup_word_stream` / `get_last_capture` 中的 `selection=...`
- `clipboard_watcher.rs`：跳过原因、黑名单命中（可保留进程名/窗口标题，不保留剪贴板正文）
- `llm.rs`：不得打印完整 URL query 中的 Key；错误响应体截断至 200 字符且去 Key

#### C. settings 下发时屏蔽密钥明文

- `get_settings` 返回给前端时，`provider.apiKey` 替换为占位符 `••••`（或 `hasApiKey: true` + 不返回原文）
- 前端 ProviderSection：显示为「已配置 / 未配置」；仅在用户主动粘贴新 Key 时上行明文
- `save_settings`：若前端传回占位符或空且原库已有密文，则保留原密文（避免用户误点保存清掉 Key）

### 4.3 验收

- [ ] CSP 生效后，开发与生产构建主流程无 console 报错、无空白窗
- [ ] 全仓库 `eprintln!` 无 selection / context / apiKey 原文
- [ ] 复制含 API Key 形态的文本，过滤命中日志仅有 reason 与长度/哈希
- [ ] 前端无法通过 `get_settings` 读到明文 Key；更换 Key 后查词仍可用
- [ ] 现有 DPAPI 读写与启动迁移行为不变

## 5. K3：本地观测面板

### 5.1 目标

把 ROADMAP Success Metrics 从「文档目标」变成「本地可核验」，同时服务 BYOK 用户的成本叙事。**零上传。**

### 5.2 数据

Schema v4，新增表：

```sql
CREATE TABLE local_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,          -- YYYY-MM-DD 本地日
    event       TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    extra       TEXT NOT NULL DEFAULT '{}'  -- 小 JSON，无原文
);
```

按日聚合 upsert，避免无限膨胀。保留最近 90 天。

事件枚举（与 ROADMAP 对齐）：

| event | extra |
|---|---|
| `clipboard_filtered` | `{reason}` |
| `clipboard_triggered` | `{kind}` |
| `lookup_cache_hit` | `{kind}` |
| `lookup_cache_miss` | `{kind}` |
| `lookup_stream_first_field` | `{ms_bucket}`（0–500 / 500–1000 / 1000–2000 / 2000+） |
| `lookup_stream_fallback` | `{}` |
| `review_card_answered` | `{result}` |
| `reading_session_viewed` | `{}` |
| `glossary_term_applied` | `{count_bucket}` |

Commands：

```text
get_local_metrics(days: u32) -> LocalMetrics
clear_local_metrics() -> ()
```

`LocalMetrics` 至少包含：今日/近 7 日查询数、缓存命中率、误触发（filtered）按 reason 分布、流式首字段耗时分位、复习回访条数。

### 5.3 UI

设置 → 新增「本地统计」（或数据区子卡片）：

- 只读卡片 + 「清除本地统计」
- 明确文案：**仅保存在本机，不会上传**
- 不提供导出到网络；可选导出 JSON 到本地文件（P2，可砍）

### 5.4 验收

- [ ] 查词 / 过滤 / 复习后，面板数字可对上操作
- [ ] 飞行模式或无网时面板完全可用
- [ ] 数据库中不存在 selection 原文
- [ ] 清除后计数归零；超过 90 天的行在启动清理
- [ ] schema v3 → v4 迁移可回滚且有测试

## 6. K4：工程卫生（随版完成）

| 项 | 验收 |
|---|---|
| 关闭过时 Issue #1 / #3 / #4 | 各附一句「已由 v1.4.x / v1.5.x 落地」并关闭 |
| PR CI | 新增 `.github/workflows/ci.yml`：`npm ci` + `tsc --noEmit` + `npm run lint` + `npm run build` + `cargo test --manifest-path src-tauri/Cargo.toml --lib`；PR 与 push main 触发 |
| 品牌清理（P2） | `CaptureMethod` 去掉未实现的 `'uia'` 默认值；不强制重命名 `LexNoteContext`（避免大范围 churn） |
| 版本三处同步 | `package.json` / `Cargo.toml` / `tauri.conf.json` 均为 `1.5.0` |

## 7. 明确不在本版

- 截图 OCR（#13）
- Authenticode（#14）
- Anki Connect
- 真实 UIA / 窗口前后文捕获
- 合并 lookup 双路径
- 新增金融等结构化领域

## 8. 实施任务

| 编号 | 任务 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|
| T1 | schema v4 + `local_events` 迁移与测试 | — | v3→v4 升级/回滚测试通过 | 已完成 |
| T2 | K1 过滤器重写 + 原因枚举 + 单测 | — | 弱/强语境与安全类用例全绿 | 已完成 |
| T3 | K0 黑名单策略 + 设置项 + UI | T2（日志原因可共用） | IDE 默认放行；开关与持久化正确 | 已完成 |
| T4 | K3 事件写入与 `get_local_metrics` | T1, T2, T3 | 命令返回与操作一致 | 已完成 |
| T5 | K3 设置页本地统计 UI | T4 | 面板可读、可清除 | 已完成 |
| T6 | K2 CSP + 日志脱敏 + settings 屏蔽 Key | — | CSP 实机通过；日志无原文；前端无明文 Key | 已完成（CSP 实机待装包回归） |
| T7 | PR CI workflow | — | 空 PR 或测试分支触发且全绿 | 已完成 |
| T8 | Issue 卫生 + README/RELEASE-NOTES-v1.5.0 | T1–T7 | 文档与 Issue 状态一致 | 文档已写，Issue 关闭待人工 |

建议顺序：T1 ∥ T2 ∥ T6 → T3 → T4 → T5 → T7 → T8。

## 9. 验证计划

1. **单元**：`content_filter` 新用例；`migrations` v4；`db` local_events 聚合与清理。
2. **前端**：CaptureSection 新开关、Provider 密钥占位、本地统计渲染（Vitest）。
3. **实机**：VS Code 复制英文 → 弹窗；复制密码管理器 → 不弹；复制 `import numpy as np` → 不弹；关闭 IDE 开关后再试 VS Code → 不弹。
4. **隐私**：全文检索源码 `eprintln!` 确认无 selection；DevTools 读 `get_settings` 无明文 Key。
5. **CSP**：`npm run build` + 实机过主窗 / 查词窗 / 设置 / Markdown / 代码卡。
6. **回归**：现有 Rust 62+ 测试与前端 Vitest 全绿；缓存、流式、复习、导入导出主路径不回退。

## 10. Success Metrics（发布后本地可查）

| 指标 | 目标 |
|---|---|
| 日常 1 小时非查词意图弹窗 | ≤ 1 次 |
| 自然英文被过滤误杀率 | < 2%（K1 单测 + 抽样） |
| 密码/密钥/路径/代码拦截率 | ≥ 95%（安全类用例） |
| 缓存命中率（近 7 日） | 可展示，基线不下降 |
| 流式首字段 P50 | < 1s（分桶可观测） |
| 升级后 IDE 场景 | 默认可查词（K0） |

## 11. 发布叙事

> **v1.5 — 主场景更稳，隐私更实**  
> 默认不再屏蔽 IDE 与终端；自然英语不再被当成代码丢掉；启用 WebView CSP，日志与设置接口不再暴露选中原文与 API Key；新增仅本机可见的使用统计。

---

关联文档：`docs/ROADMAP-v1.1-v1.3.md`、`docs/PRD-v1.4-spec.md`、`docs/superpowers/specs/2026-08-12-reliability-hardening-design.md`、Issue #1 #3 #4 #13 #14。
