# 鸽鸽词典 V1.9 开发规格

文档状态：已实现（as-built），待发布

目标版本：1.9.0

版本定位：偿还信任债，并补上「查过的词找得回」与「学习看得见」两个最基础的反馈回路。

基线：v1.8.0（`main`），开发分支 `feat/v1.9`。

路线背景：见 `docs/ROADMAP-v1.9-v2.0.md`；交付与验证记录见 `docs/compose/spec/v1.9.md`。

## 1. 范围与原则

### 1.1 产品原则

- 继续 **零服务端、零上传**：新增的查词历史与学习洞察只读写本机 SQLite。
- v1.9 **不加新的取词入口**。修复优先于功能。
- 每个修复都带一个「修之前会失败」的测试；不能自动化的（真实语音、托盘）在实机清单里说明。
- Schema 变更沿用 v1.4.3 做法：单事务、预迁移备份、失败回滚、单测；并且旧版本的备份仍然可以恢复。
- 用户可控：查词历史默认开启，但可以关闭、可以删除单条、可以一键清空。

### 1.2 非目标

- 备用模型、生词库行虚拟化、复习「有点难」、批量补全（v1.10，见路线图）。
- Authenticode 代码签名（#14）。
- 任何形式的历史同步或上传。

## 2. E0：信任债偿还

每一项都先复现、再修、再用测试守住。

### 2.1 安全

**TTS 命令注入。** `tts.rs` 用 `format!` 把文本拼进 PowerShell 脚本，只把 ASCII 单引号写成两个。PowerShell 还把 U+2018 / 2019 / 201A / 201B 当作单引号定界符，所以带弯引号的文本会让脚本语法错误（静默不出声），构造过的文本可以逃出字符串并执行任意命令（本机用无害标记复现过）。

设计：文本、语音名、语速分别经 `GEGE_TTS_TEXT` / `GEGE_TTS_VOICE` / `GEGE_TTS_RATE` 环境变量传入，脚本是编译期常量，不再包含任何用户输入。新一句朗读替换上一句；新增 `stop_speaking`；`speak_text` 在播放真正结束时才返回，朗读按钮因此能反映引擎状态。

验收：`user_text_never_reaches_the_script_only_the_environment`、`speak_script_reads_every_input_from_the_environment_only`，以及经过真实 PowerShell 的字节级往返 `environment_transport_is_byte_exact_in_powershell`。

**日志不打印译文。** `parse_entry` 在解析失败时曾把模型输出的前 500 个字符写进日志，违背 v1.5 对用户的承诺。现在日志只记录输出长度与解析器放弃的行列位置（`parse_failure_note`）。

### 2.2 数据完整性

**保存即合并。** 查词窗口曾构造一个全新的词（掌握度 new、备注空、标签只有刚输入的）并整体替换库里的文档；再查一个已收藏的词就会重置掌握度、备注、标签并丢掉 Anki 关联，还因为只按 id 识别而可能产生重复。

设计：后端 `save_lookup_result` 合并——内容刷新；掌握度、备注、标签（取并集）、`savedAt`、最初的来源、`ankiNoteId` 保留；`lookups` 加一。识别规则为 id，或归一化 lemma 加 kind（支持 Unicode 大小写，与导入器一致）；历史遗留的重复项合并到最早保存的那个。

**Anki 配对。** note id 曾按位置与词配对，而 `get_words_by_ids` 按时间倒序并丢弃未知 id。现在按词自身 id 配对（`get_words_in_order`），note id 在一个事务里同时写入文档 JSON 与 `anki_note_id` 列（该列此前从未被写入）；写回失败会报告而不是吞掉。

**其他事务化。** `batch_update_words`（掌握度与标签批量改）、`delete_words`、`tag_session` 均在单个事务内完成；`import_words` 用哈希索引代替逐行线性扫描。测试用内存库同样开启外键。

**撤销是真的。** 撤销收藏会删除由这次保存创建的词，或通过 `restore_word` 还原之前的文档。

### 2.3 查词窗口

- 键盘规则收敛到 `lookup-keys.ts` 的 `resolveLookupShortcut`：忽略文本框、可激活控件、组合键、输入法组合态与长按。
- 保存进行中同步记录并禁用按钮；标签限 32 个字符；保存失败显示原因，不会留下「幻影词」。
- 查词与 OCR 窗口不再冷启动加载整库（`LexNoteProvider` 的 `loadWords` 开关），查词窗口用 `find_word_by_lemma` 询问后端那一个词。

### 2.4 错误与连接测试

`llm.rs` 的 `ERROR_CODES` 与 `coded()` / `error_code()`：每个错误出口按真实原因打码（HTTP 状态、reqwest 错误类别、解析失败）。前端 `lookup-errors.ts` 把码翻译成标题、建议与动作，`LookupErrorState` 取代了 `Lookup.tsx` 里 80 行的字符串猜测。一个 Rust 测试读取 `lookup-errors.ts` 并在两份码表不一致时失败。首次配置与设置页共用 `useConnectionTest`，显示真实延迟与真实失败原因，并丢弃过期结果。

Anthropic 协议下回答因 `max_tokens` 被截断时，后端识别并报告为截断，而不是「JSON 解析失败」。

### 2.5 信任

- **重新解析**：`useReanalysis` 用词条最初选中的文本、句子与类型强制刷新查词，经合并保存路径写回——模型写的内容被替换，掌握度、备注、标签、Anki 关联、收藏时间与来源保持不变；失败如实报告原因且词条不变；可回滚，回滚保留用户之后的修改；迟到的结果仍保存到它所属的词条。
- **用量统计**：`finish_lookup()` 是所有出口（缓存命中 / 流式 / 回退，阻塞 / 流式）的汇合处，在这里统一计数；缓存命中算一次查询但不耗 token；模型调用按文字类型估算 token（窄字符约 4 个一 token，汉字约 1.5 个）。`increment_usage` 命令已删除，前端不再能自行上报，主窗口回到前台时重新读取。
- **模板填充**一次完成（`build_prompt`），选中文本里恰好含有 `{{context}}` 不会再被改写。

### 2.6 托盘与朗读

**监听开关。** 新增 `watch_switch.rs` 的 `WatchSwitch`：开 / 关 / 暂停三个动作，由托盘、设置页与剪贴板线程共用。规则：暂停只在它仍是最后一次改动时才自己结束；暂停期间用户手动打开即取消暂停；暂停后用户手动关掉的监听，到点不会被重新打开；第二次暂停重新计时；已经被用户关掉的监听无从暂停。托盘「划词即查」的勾选通过一个类型擦除的闭包随状态更新（闭包而不是 `CheckMenuItem<Wry>`，原因见 §7.3）；设置页的开关在窗口重新获得焦点时重读后端状态。

**语音。** 优先使用设置里指定的语音，找不到时选 en-US，再找任一英文语音，最后才用系统默认；设置页列出本机已安装的语音，并用原生引擎试听（带「停止」），不再使用浏览器的 `speechSynthesis`。

### 2.7 视觉

`tailwind.config.cjs` 把主题色（CSS 变量）改为 `color-mix(in srgb, var(--x) N%, transparent)` 的函数式颜色，`bg-danger/5`、`border-line/60` 等带透明度的类终于产出 CSS。

## 3. E1：查词历史

### 3.1 问题

查过的词如果没有收藏就消失了：想再看一眼只能重新复制、重新等模型。生词库只能回答「我存了什么」，回答不了「我查过什么」。

### 3.2 设计

**Schema v6**

```sql
CREATE TABLE IF NOT EXISTS lookup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    history_key TEXT NOT NULL UNIQUE,
    selection TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    lemma TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'word',
    source_app TEXT NOT NULL DEFAULT '',
    source_title TEXT NOT NULL DEFAULT '',
    lookup_count INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_history_last_at ON lookup_history(last_at DESC);
```

**记录规则**

- 在 `finish_lookup()` 里记录，也就是答案产生的地方（模型或缓存），不是保存的地方。
- 一个 `history_key` 一行：词与短语忽略大小写与空格差异，句子与段落只忽略空格差异（与查词缓存的规则一致），类型不同永不合并。重复查询累计次数并移到最上面。
- 只保留最近 500 条；选中文本最多 2000 字符、上下文 1000 字符；空白选择不记录。
- 来源应用与窗口标题只在「这次捕获确实就是被查的文本」时才记在这一条上。
- 设置键 `historyEnabled`（默认 `true`）关闭后不再记录，已有记录仍可查看与删除。

**命令**

```text
get_lookup_history()                 # 最新在前
delete_lookup_history(ids)           # 返回删除条数
clear_lookup_history()               # 返回删除条数
reopen_lookup_from_history(id)       # 以当初的选中文本、句子与类型打开查词窗口
```

**界面**

- 生词库新增「历史」页：按天分组、搜索（词、释义、来源）、标出「已收藏」、悬停显示删除、右上角「清空历史」（带确认）；关闭记录时顶部提示并可跳转设置。
- 设置 → 数据 → 「查词历史」：开关、当前条数、清空；隐私说明写明保存了什么，以及它不会发送给模型或任何服务器。

**旧备份仍可恢复。** schema 每升一版，旧版本做的备份都不能再通过「必须是最新 schema」的恢复校验。现在恢复按备份自身版本的要求校验，复制进来后立即升级（与应用启动时升级旧库同一条路径）；比当前应用更新的备份被明确拒绝。

### 3.3 验收

- [x] v5 → v6 迁移保留已有词，新库同样有历史表（`upgrades_v5_with_lookup_history_and_keeps_existing_words`、`a_new_database_has_the_history_table_too`）
- [x] 同一个词一行并累计次数、重复移到最上；句子区分大小写、类型永不合并；只保留最新 500 条；空白选择忽略、长文本被截断
- [x] 可删除单条与清空；重新打开已不存在的条目有明确提示
- [x] 旧版本备份可恢复并升级，新版本备份被拒绝且不改动当前库（`a_backup_from_an_older_version_is_restored_and_brought_up_to_date`、`a_backup_from_a_newer_version_is_refused_and_nothing_changes`）
- [x] 前端：分组、搜索、「已收藏」标记、关闭时的提示、删除与清空、并发读取只采用最后一次（`HistoryTab.test.tsx`）

## 4. E2：学习洞察

### 4.1 问题

复习、收藏、查词的数据都在，但没有任何地方告诉用户「这周学得怎么样」。

### 4.2 设计

**数据来源（全部是本机既有的表，无新表）**

| 指标 | 来源 |
| --- | --- |
| 每日查词次数 | `usage_log.queries`（v1.9 起在出结果处计数，见 §2.5） |
| 每日收藏数 | `words.saved_at`，按用户本地日期归日 |
| 每日复习数 | `local_events` 中 `review_card_answered` 的按日计数 |
| 掌握度分布 | `words.mastery`（未知值计为新词，保证各部分之和等于总数） |
| 复习档位、待复习、答对 / 答错 | `review_state` |
| 常查的词、易错的词、生词来源 | `words.lookups`、`review_state.wrong_count`、`words.source_app` |

**命令**：`get_learning_insights(days)`，`days` 夹在 7 到 90 之间，返回 `LearningInsights`（见 `src/types/lexnote.ts`）：窗口内每天一个点（缺的天补零）、窗口合计、本周新增、连续天数（当前 / 最长 / 活跃天数）、总量、掌握度、复习、三份排行。统计逻辑是 `insights.rs` 中的纯函数（给定当天日期，不读时钟），数据库层只负责取数。

**连续天数**：任何活动（查词、收藏、复习）算一天；从今天往回数，今天还没学不算断（昨天结束的连续仍计入当前连续）；错过一整天才断，最长记录不受影响。

**页面**：`/insights`（侧边栏「学习洞察」，懒加载）。顶部四个数字、活动曲线、掌握程度、复习（带「去复习」入口）、三份排行；范围切换 7 / 30 / 90 天；回到窗口时自动刷新，读取失败时保留上一次的结果并提示；完全没有记录时显示引导文案而不是一堆零。

### 4.3 验收

- [x] 连续天数：从今天计、今天未学不算断、错过一天断但保留最长、跨月跨年、未来日期忽略、无记录为 0（`insights.rs` 13 个测试）
- [x] 数据库集成：空库全零不报错、窗口夹在 7 到 90 天、日期按本地日归并（`db.rs` 3 个测试）
- [x] 前端：加载 / 失败重试 / 空状态 / 切换范围 / 去复习 / 排行（`Insights.test.tsx`、`insights.test.ts`）

## 5. E3：生词库列表性能

- `library-list.ts`：`filterWords` 与 `sortWords` 是纯函数；每个词的搜索文本（词形、释义、语境义、解析、上下文、例句）转小写后缓存在 `WeakMap`；排序用一个 `Intl.Collator` 和一次性解析的日期，稳定。
- `Library.tsx`：搜索词用 `useDeferredValue`，输入框跟手，列表在浏览器有空时跟上；选中集合用 `Set`；`WordRow` / `WordCard` 用 `memo`；`FilterPanel` 的计数 `useMemo`。
- 表头「全选」只针对当前列出的词：全部已选则取消这些词，否则把这些词加入选择；列表被筛窄之前选下的其他词保持不变。「已全选」只在每个被列出的词都在选择里时成立，不再用选中数是否等于列表数来判断。

验收：`library-list.test.ts`（过滤、排序、搜索文本缓存、稳定性）与 `Library.test.tsx`（搜索含例句、无匹配提示与清除、表头全选、被隐藏的已选词不会让全选框误判）。

## 6. E4：工程

- 版本三处同步 `1.9.0`（`package.json` / `Cargo.toml` / `tauri.conf.json`，连同两份 lock 文件）。`package.json` 补上实际在用却未声明的 `autoprefixer` 与 `postcss`（锁文件原本就包含它们，补写后 `npm ci` 的根依赖一致检查才不会失败）。
- `cargo clippy --all-targets` 零警告：`ModelCall`（base URL、Key、模型、温度、token 上限、超时、协议）取代 `llm.rs` 里各函数的 10 个参数；`LookupPlan` 取代 `lookup.rs` 里的 10 元素元组。
- vitest：每个用例 30 秒超时，Testing Library 异步等待 8 秒；测试配置合并 Vite 配置以得到 `__APP_VERSION__`。
- 删除原型期无人引用的演示与 mock（21 个文件，约 2700 行）。

## 7. Schema、命令与设置

### 7.1 Schema

`LATEST_SCHEMA_VERSION = 6`，新增 `lookup_history`（§3.2）。

### 7.2 命令增量

```text
get_lookup_history / delete_lookup_history / clear_lookup_history / reopen_lookup_from_history
get_learning_insights
stop_speaking
restore_word / find_word_by_lemma / batch_update_words
```

删除：`increment_usage`。

### 7.3 一个会咬人的坑：测试可执行文件与 Tauri 句柄类型

`AppState` 里若放 `CheckMenuItem<Wry>` 这类带运行时的类型，`cargo test --lib` 的测试可执行文件会被链接进系统对话框相关的导入，而测试可执行文件没有 comctl32 v6 清单，启动即以 `0xc0000139`（`STATUS_ENTRYPOINT_NOT_FOUND`）失败，且报错里看不出原因。因此 `AppState` 保存的是 `Arc<dyn Fn(bool) + Send + Sync>` 形式的「更新勾选」闭包，由 `setup_tray` 在运行时创建，测试可达的代码里不出现任何 `Wry` 类型。

### 7.4 设置键增量

```text
historyEnabled: boolean       # 默认 true
```

## 8. 实施任务

| 编号 | 任务 |
| --- | --- |
| T1 | 分支与 rustfmt：恢复 CI 门禁 |
| T2 | TTS 注入修复（环境变量传参、可打断、测试） |
| T3 | 保存合并、Anki 配对、事务化、导入哈希索引 |
| T4 | 查词窗口：键盘规则、防重复保存、真撤销、不加载整库 |
| T5 | 错误码体系与真实的连接测试 |
| T6 | 重新解析、用量统计 |
| T7 | 清理死代码 |
| T8 | 查词历史（schema v6、命令、历史页、设置、旧备份恢复） |
| T9 | 学习洞察（`insights.rs`、`get_learning_insights`、页面） |
| T10 | 托盘监听开关与暂停；语音选择与试听 |
| T11 | 主题色透明度；Anthropic 截断识别；日志隐私 |
| T12 | 生词库列表性能与全选修正 |
| T13 | clippy 清零与结构体化；测试配置 |
| T14 | 版本 1.9.0、文档、全量验证 |

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| 历史记录了用户选中的文本，属于敏感数据 | 默认只存本机；可关闭、可单条删除、可一键清空；设置页写明保存了什么；「导出全部数据」得到的是完整 SQLite 快照，其中也含历史，README 的隐私说明已写明 |
| Schema v6 迁移失败锁库 | 沿用单事务、预迁移备份、失败回滚；`failed_migration_rolls_back_version_and_schema` |
| 合并保存改变了「重复查词」的语义 | 规则由 `db.rs` 的合并测试守住（`saving_a_lookup_again_keeps_everything_the_user_owns` 等） |
| 洞察页的数字被用户当作权威 | 页面注明数据来源于本机记录；所有数字可由既有表复算 |
| 耗时预算类测试在繁忙机器上偶发失败 | v1.10 F3：改为相对基线判断 |

---

关联文档：`docs/ROADMAP-v1.9-v2.0.md`、`docs/PRD-v1.7-spec.md`、`docs/RELEASE-NOTES-v1.8.0.md`。
