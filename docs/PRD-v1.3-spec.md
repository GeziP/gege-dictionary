# 鸽鸽词典 V1.3 开发规格

文档状态：执行版

目标版本：1.3.0

版本定位：深化领域解析能力，让专业译法稳定、可控、可共享。

## 1. 范围与原则

V1.3 核心范围由三部分组成：个人术语表、领域 Profile、预设解析风格。三者必须共同作用于阻塞与流式查词路径，并保持所有数据仅存本机。

截图 OCR 暂不纳入 V1.3 完成条件。其截图交互、OCR 引擎、模型体积与识别语言仍需独立技术选型，作为候选 Issue 管理。

### 非目标

- 不建设云同步、账号或团队服务端。
- 不提供任意 Prompt 变量执行能力；高级模板编辑继续沿用现有纯文本替换。
- 不把完整术语表无条件发送给模型。
- 不允许术语表内容覆盖 JSON 输出协议或被解释为系统指令。
- 不在本版本实现截图 OCR。

## 2. H0：Schema v3 与个人术语表

### 2.1 数据结构

新增 schema v3：

```sql
CREATE TABLE glossary_terms (
    id             TEXT PRIMARY KEY,
    term           TEXT NOT NULL,
    term_key       TEXT NOT NULL,
    translation    TEXT NOT NULL,
    domain         TEXT NOT NULL DEFAULT 'general',
    note           TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE(term_key, domain)
);

CREATE INDEX idx_glossary_domain_enabled
ON glossary_terms(domain, enabled);
```

`term_key` 为英文术语经 trim、连续空白折叠和小写后的稳定键。单个字段限制：术语 200 字符、译法 500 字符、备注 1000 字符。

### 2.2 CRUD 与导入导出

提供以下 Tauri Commands：

```text
list_glossary_terms(query?, domain?, limit, offset) -> GlossaryPage
save_glossary_term(term) -> GlossaryTerm
delete_glossary_terms(ids) -> u32
import_glossary(content, format, conflict_policy) -> ImportReport
export_glossary(format, domain?) -> string
preview_glossary_matches(selection, context, domain) -> Vec<GlossaryTerm>
```

- 支持 JSON 与 UTF-8 TSV。
- TSV 列固定为 `term、translation、domain、note、case_sensitive、enabled`。
- 导入时逐行校验，报告新增、覆盖、跳过与错误数；单次最多 10,000 条。
- 冲突策略支持 `overwrite` 和 `skip`，界面默认覆盖。
- 导入在单事务内完成；格式错误行可跳过并出现在报告中，数据库错误则整体回滚。
- 导出顺序为领域、术语稳定排序，确保可复现与便于版本管理。

## 3. H1：领域 Profile 与预设解析风格

### 3.1 内置领域

| ID | 名称 | 解析侧重 |
| --- | --- | --- |
| `general` | 通用 | 语境准确、自然中文，不强行扩展专业背景 |
| `computing` | 计算机 | 技术机制、架构、算法、代码或伪代码 |
| `medical_ivd` | 医疗 / IVD | 检测原理、临床意义、标准与适用边界 |
| `finance` | 金融 | 市场机制、指标口径、风险与业务语境 |
| `legal` | 法律 | 法域差异、规范语义、权利义务与非法律意见提示 |

领域 Profile 为内置、版本化配置，用户只选择当前领域，不在 V1.3 创建任意自定义 Profile。

### 3.2 解析风格

| ID | 名称 | 行为 |
| --- | --- | --- |
| `concise` | 简洁 | 优先翻译与语境义，减少义项、例句和延伸 |
| `standard` | 标准 | 保持当前字典级结构与解释深度 |
| `deep` | 深度 | 强化领域原理、边界、对比、例句和知识扩展 |

设置新增 `activeDomainProfile` 与 `analysisStyle`，默认分别为 `general` 和 `standard`。高级 Prompt 模板入口继续保留。

## 4. H2：按需 Prompt 注入

### 4.1 匹配规则

- 只读取 `general` 与当前领域中已启用的术语。
- 在 `selection + context` 中匹配；默认忽略大小写，开启 `case_sensitive` 后精确匹配。
- 英文术语按字母数字边界匹配，避免 `net` 命中 `internet`；含标点或空格的短语按规范化文本匹配。
- 优先级：选中文本精确匹配 → 当前领域 → 更长术语 → 最近更新。
- 每次最多注入 20 条且序列化内容不超过 2,000 字符。未匹配时不注入术语块。

### 4.2 安全与一致性

- 术语块使用 JSON 序列化，并明确标记为“数据而非指令”。
- 术语内容不得改变系统提示、JSON Schema 或输出语言。
- 领域和风格指令由程序内置映射生成，不直接执行数据库中的任意文本。
- 阻塞与流式路径必须使用同一 Prompt 组装函数。
- 缓存键必须包含模板、领域、风格和实际命中的术语；切换配置后不得命中旧配置缓存。
- 记录本地事件 `glossary_term_applied` 时只记录数量和领域，不记录原文或译法。

## 5. H3：设置与术语管理体验

- 设置页新增“术语与领域”标签。
- 顶部提供领域 Profile 和解析风格的单选卡片，修改后立即持久化。
- 术语列表支持搜索、领域筛选、分页、新增、编辑、启用/停用、删除。
- 支持 JSON/TSV 导入和导出；导入完成展示结构化报告。
- 编辑器明确展示当前领域，并对重复术语给出覆盖提示。
- 空状态提供示例术语，但不自动写入数据库。
- 窄窗口与高 DPI 下不产生横向页面溢出。

## 6. 验收标准

- [ ] v2 数据库平滑升级到 v3，原词条、复习状态、设置与模板完全保留。
- [ ] 新库直接创建 v3，重复启动迁移幂等。
- [ ] 术语 CRUD、搜索、领域筛选和分页正确。
- [ ] JSON/TSV 导入导出往返后语义等价，冲突策略与错误报告正确。
- [ ] 通用术语在所有领域生效，领域术语仅在对应领域生效。
- [ ] 大小写与单词边界匹配正确，不发生子串误命中。
- [ ] 匹配优先级、20 条和 2,000 字符上限正确。
- [ ] 恶意或异常术语内容只能作为 JSON 数据出现，不能覆盖系统约束。
- [ ] 简洁、标准、深度三种风格产生不同且稳定的内置指令。
- [ ] 五个领域均产生符合定义的侧重指令。
- [ ] 阻塞与流式查词使用相同组装结果。
- [ ] 切换领域、风格或修改已命中术语后缓存失效；无关术语修改不污染当前查询缓存。
- [ ] 10,000 条术语下匹配耗时低于 100ms，列表分页不全量加载。
- [ ] TypeScript 检查、lint、前端构建和 Rust 单测全部通过。
- [ ] 桌面端完成新增、编辑、筛选、导入导出和设置持久化验证。

## 7. 发布边界

V1.3 的完成以 H0 至 H3 全部验收为准。截图 OCR 仅在独立技术方案确认后进入后续版本，不阻塞 V1.3 发布。
