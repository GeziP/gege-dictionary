# 鸽鸽词典 V1.10 开发规格

文档状态：已实现（as-built），待发布

目标版本：1.10.0

版本定位：模型出问题时词典仍然能用（备用模型）、大词库仍然顺手（列表窗口化）、导入的词能变成完整词条（批量补全），并把复习与学习回顾做细（「有点难」、复习日历、每周回顾与周报）。

基线：v1.9.0（`feat/v1.9`，`c83e637`），开发分支 `feat/v1.10`。

路线背景：见 `docs/ROADMAP-v1.9-v2.0.md` §三；交付与验证记录见 `docs/compose/spec/v1.10.md`。

## 1. 范围与原则

### 1.1 产品原则

- 继续 **零服务端、零上传**：批量补全、每周回顾、复习日历只读写本机 SQLite；向外发送内容的仍然只有用户自己配置的模型服务。备用模型是其中的第二个，启用并被触发时才会收到与主模型相同的选中文本与上下文，设置页的开关说明与 README 都逐字写明。
- v1.10 **不加新的取词入口**。
- **不静默改写用户的数据**：批量补全只填空缺；重新解析遇到词形变化先问再存；周报遇到没覆盖的日子说「没有读到记录」，而不是写 0。
- **失败说真实原因**：备用模型只在它能帮上忙的错误上触发（不掩盖配置错误）；批量补全遇到每个词都会遇到的失败时整体停下并说明，而不是把每个词都标成失败。
- Schema 变更沿用单事务、预迁移备份、失败回滚、单测；旧版本的备份仍然可以恢复。
- 每个功能先把规则写成纯函数并单测（`review.rs`、`enrich.rs` 的规则、`row-window.ts`、`weekly.ts`），再接界面。

### 1.2 非目标

- v2.0 的 G1–G4：Authenticode 代码签名、可选 RapidOCR、FSRS 式间隔评估、安装包体积与冷启动预算。
- 完整 SRS、云同步、多个备用模型的链式回退（备用模型只有一个，且只试一次）。
- 常驻后台的自动补全：批量补全只在用户点「开始补全」之后运行，应用关闭即停。

## 2. F3：固定工具链与 clippy 门禁

问题：v1.9 把 clippy 清零，但 CI 并不检查它；新的 lint 或新的稳定版 Rust 会悄悄让它退化，或者让一个与改动无关的 PR 变红。

设计：

- `rust-toolchain.toml` 固定 `1.95.0`（含 clippy 与 rustfmt）。升级工具链是一次有意的改动：改这个文件、跑 clippy 与 `cargo test --lib`、修掉新版本的抱怨、一起提交。
- `ci.yml` 与 `release.yml` 用 `rustup toolchain install`（读取该文件）安装工具链，而不是 `stable`。
- 在任何 cargo 步骤之前先构建前端（`tauri::generate_context!` 在 lint 与单测构建里也会校验 `frontendDist`），随后 `cargo fmt -- --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked --lib`。
- 路线图里「耗时预算类测试改为相对基线」已在 v1.9 T13 完成，这一项没有重复。

## 3. F1：备用模型

问题：主模型偶尔遇到 429、5xx、超时或断网，查词就落到一张错误卡片；而用户常常有第二个可用的服务（另一家，或同一家的另一个模型）。

设计：

- **设置**：`backupProvider`（与 `provider` 同样的字段，外加 `enabled`，默认关闭）。备用 Key 与主 Key 一样走 DPAPI：页面只会拿到占位符；空值或占位符保留已存的密文；无法解密的 Key 会被清除并带上它自己的错误信息（`backupApiKeyError`），主 Key 不受影响。Key 的迁移、脱敏与保存对 `PROVIDER_KEYS` 循环处理，两把 Key 走同一条逻辑。
- **何时试备用**（`llm::another_provider_may_help`）：只有 `rate_limit`、`server`、`timeout`、`network`。Key 无效（`auth`）、模型不存在（`model`）、返回内容解析失败或为空，换个服务也一样会失败，不触发——否则只会盖住配置错误。
- **备用何时算数**：已启用、字段齐全、Key 能解密，并且与主模型不是同一个服务。
- **`ask_services`** 是「先主后备」的唯一入口，`lookup_word` 与 `lookup_word_stream` 共用。流式路径在备用即将接手时，不再先做「同一服务的非流式重试」。
- **两个都失败**：错误码取主模型的失败，并附上备用的原因。
- **缓存**：答案存在主模型的缓存键下，并记录真正回答的模型（`_model`、`_viaBackup`）。同一个问题下次直接命中，不再打扰备用。
- **本机统计**：事件 `lookup_backup_used` → 「设置 → 本地统计」里的「备用模型接管」。
- `test_connection` 新增 `backup` 参数，可以测试备用服务；占位符 Key 会解析为备用服务自己的那把。
- **界面**：设置 → 模型服务 → 备用模型（启用开关、与主模型相同的字段 `ProviderFields`、缺哪些字段的状态行、「测试备用连接」）；查词结果标明回答的模型，备用回答时带「备用模型」徽标；重新解析走同一条路径，同样会标明；批量补全也走这条路径，并把回答的模型写进词条（`_model`、`_viaBackup`）。

验收：哪些错误值得问第二个服务（`only_a_struggling_service_is_worth_a_second_opinion`）；备用何时算数（未开启、字段不全、与主模型相同都不算）；主备顺序与错误合并（`a_struggling_main_service_is_followed_by_the_backup_which_is_asked_once`、`a_failure_that_another_service_cannot_fix_is_not_hidden_behind_the_backup`、`when_the_backup_fails_too_both_are_reported_under_the_code_of_the_main_service`）；缓存键与标注（`what_the_backup_wrote_is_labelled_kept_under_the_main_key_and_counted_once`）；备用 Key 的迁移 / 脱敏 / 保存（`a_plaintext_backup_key_is_migrated_to_dpapi_like_the_main_key`、`an_unreadable_backup_key_is_cleared_with_its_own_error_and_the_main_key_is_left_alone`、`the_page_only_ever_gets_a_placeholder_for_either_key` 等）；`ProviderSections.test.tsx` 覆盖设置页。

## 4. F2：生词库长列表

问题：数千词的库里，每次选中或滚动都会重新绘制并布局每一行。v1.9 已经让过滤与排序便宜了，剩下的成本是渲染。

设计：

- 表格视图下词数**超过 400**（`WINDOW_FROM`）时，`WordTable` 只绘制屏幕上的行外加上下余量，两个占位行撑住其余的高度，滚动条始终是整个列表的长度。400 词以内不窗口化：全部绘制很便宜，并且保证 Tab 键与页内查找可达每一行。
- `lib/row-window.ts` 是纯算术（画哪些行、两个占位有多高），结果总是加起来等于整个列表的高度；能处理不可用的数字，也能处理「列表变短到比滚动位置还短」。
- `hooks/useRowWindow.ts` 跟随滚动容器（scroll + `ResizeObserver`），只在窗口真的可能变化时重绘；行高从已绘制的两行里量出来，所以字号或主题变化不会让列表漂移。
- 行固定为一行（不换行、超长截断，完整内容在详情里）。表格带 `aria-rowcount`，每个已绘制的行带 `aria-rowindex`，读屏器听到的仍是真实长度。
- 卡片视图仍然全部绘制，屏外的卡片由浏览器跳过（`content-visibility: auto`）。

验收：9 个算术用例；15 个表格用例（窗口化、滚动、最后一行、选中与打开、列表变短、实测行高、卡片）。

## 5. F4：复习「有点难」与复习日历

问题：二元答案不够细。刚好想起来的词，答对后直接跳到一周之后；洞察页的「易错的词」也分不出「差点忘了」和「忘了」。

设计：

- **三个答案**：认识（键 1）、有点难（键 2）、不认识（键 3）。**键 2 原来是「不认识」，现在是「有点难」**，不认识改为键 3。
- **调度**（`review.rs::schedule`，纯函数）：认识 → 升一档（最高第 3 档），之后的间隔是所到档位的间隔（1 / 3 / 7 天）；有点难 → 留在原档，明天再见；不认识 → 回到第 1 档，明天再见。掌握度跟着档位走（第 1 档「新词」、第 2 档「巩固中」、第 3 档「已掌握」）。
- **Schema v7**：`review_state.hard_count INTEGER NOT NULL DEFAULT 0`，单事务迁移（预迁移备份、失败回滚、可重复执行）；v6 及更早的备份恢复后立即升级。
- `submit_review` 以文本接收答案（`correct` / `hard` / `wrong`）；事件 `review_card_answered` 记录是哪一种；`last_result` 的 `correct` 与 `wrong` 与旧版本相同。卡片对应的词已被删除时，`submit_review` 报告「词已删除」，今日回顾页据此跳到下一张。
- **洞察**：`review.hard`；`hardWords` 按「答错 × 2 + 有点难」排序；**12 周复习日历**由 `local_events` 生成（保留 90 天，12 周放得下），每天按答题数着色，鼠标悬停每格可以看到「答对 x，有点难 y，答错 z」，读屏器读到的是整张日历的概述；答对率 = 认识 ÷（认识 + 有点难 + 不认识），也就是「有点难」不算答对。
- **今日回顾页**：一次只保存一个答案（按住数字键不再跳过下一张卡）；保存失败时卡片保留并说明原因，不再丢弃答案；朗读按钮只发声，不再翻面泄露释义。每个答案的按钮提示写明后果。
- 设置 → 复习与会话 → 每日回顾的说明改为三个答案各自的后果。

验收：`review.rs` 的调度单测；`upgrades_v6_with_a_hard_count_and_keeps_the_review_progress` 与「新库也有 `hard_count`」；`Review.test.tsx` 覆盖三个答案、按键、保存失败与已删除词；`insights` 的日历与排序用例。

## 6. F5：批量补全

问题：从词表导入的库里有大量「光秃」的词：只有词形和释义，没有义项和例句。逐个手动查词，正是让这类词库用不起来的杂务。

设计（`enrich.rs`；规则不碰窗口也不碰数据库，可以单独测试）：

- **光秃的词**（`is_bare`）：类型是单词或短语（没写类型按单词）、没有义项、没有例句。句子与段落没有义项可补，不算。`db.rs` 在 SQL 里问同一个问题（`BARE_WORDS_SQL`），一个测试让两处互相核对。
- **队列每次启动都从数据库重新计算**。每个词一得到答案就入库，所以「断点续跑」不需要保存任何东西——还光秃的就是剩下的。关闭应用、额度用完、服务出错之后，再点一次开始就是继续。
- **只填空**（`fill_gaps`）：模型的回答只补空缺（11 个字段，以及仍是「中性」的语域）；导入的释义、lemma、笔记、标签、掌握度、复习进度、收藏时间与来源都不动，即使模型给的是另一个词形。补上内容时写入 `_model`（备用模型回答时再写 `_viaBackup`）。每个词一个事务；回答里没有任何可补的东西算作错误，词保持原样；回答回来时词已被删除，或已有义项 / 例句（来自一次查词或上一轮），则跳过并计入「已无需补全」。
- **安静**：批量请求不进查词历史、不计入查词次数、不进缓存与备用模型统计。它们用掉的 token 计入当天用量。本机只记四种事件：`enrichment_started`、`enrichment_word_done`、`enrichment_word_failed`（只带错误码）、`enrichment_ended`（带结束原因）；事件与日志都不写词本身。
- **额度**（`enrichDailyTokens`）：默认 100,000；`0` 表示不限制；小于 1,000 或不合理的值按默认处理——绝不会变成「不限制」，悄悄消失的上限是更糟的错误。额度按「今天查词与补全一共用掉的估算 token」计算；每个词在见到真实花费之前先按 1,500 token 预估。
- **节奏**（`enrichPace`）：从容（每 6 秒一个词）、标准（每 3 秒，默认）、较快（每 1.5 秒，容易被限流）。
- **重试**：`rate_limit` 依次等待 10 / 30 / 90 秒；`server`、`timeout`、`network` 重试两次（3 秒、10 秒）；其余不重试。
- **失败**：每个词都会遇到的失败（`no_key`、`auth`、`model`，以及重试之后仍然的 `rate_limit`）结束整轮并说明原因；连续 5 个词失败也结束（说明问题不在词上）。其余失败只记在那个词上；界面列出前 50 个失败的词与原因，总数完整。
- **控制**：同一时间一轮；暂停 / 继续 / 停止。停止先进入「正在停止」，等手头那个请求返回；暂停同样让手头的请求完成。每一轮有序号（`run`），窗口不会把两轮的进度混在一起；进度由事件 `enrichment://progress` 推送。
- **命令**：`get_enrichment_status`、`start_enrichment(ids?)`、`pause_enrichment`、`resume_enrichment`、`stop_enrichment`。`ids` 用于「补全所选」：只处理所选里仍然光秃的词。
- **界面**：生词库顶部的面板——有多少词需要补全与预计 token → 进度条、正在处理的词、本轮与今天的用量、没补成功的词、结束原因与下一步；选中栏的「补全所选」；设置 → 模型服务 → 批量补全（每天最多用、请求节奏），用量说明写明批量用掉的 token 也计在内。

验收：`enrich.rs` 的单测覆盖光秃判定（含与 SQL 的一致性）、`fill_gaps` 逐字段保留、额度与节奏取值、重试表、整轮结束与单词失败的区分、暂停 / 继续 / 停止的状态机与 `run` 序号；`db.rs` 的单词事务；`EnrichmentPanel`、`EnrichmentSection`、`useEnrichment`、`enrichment.ts` 的前端测试。

## 7. F6：重新解析遇到词形变化

问题：重新解析「running」可能得到 lemma「run」。v1.9 的保存会悄悄把词条改名，而词库里已有「run」时就变成两个「run」。

设计：先问，回答之前什么都不保存。

- **更新「running」**：新内容写进这个词条，词条保留它的词形；和一般的重新解析一样可以回滚。
- **另存为「run」**：新解析成为一个独立词条；词库里已有「run」时更新那一个，不会重复；打开的词条保持原样。可以撤销：新建的词会被删除（除非用户之后又对它做了别的事）；被刷新的词恢复原样，并保留用户之后做的修改。
- **都不要**：丢弃新解析。
- 空白或大小写不同不算另一个词形（与后端一致）。问题只能在词条打开时提出；用户离开之后才到的答案被丢弃，而不是替用户做决定。保存失败时问题保持打开，并显示原因。
- **后端护栏**：当回答属于另一个 lemma 时，`save_lookup_result` 拒绝按 id 覆盖那个词，所以任何调用方都不能靠「再保存一次」给词条改名。

验收：`WordDetail.test.tsx` 覆盖三条路径、已有词的更新、撤销、离开时丢弃、保存失败；后端护栏 `an_answer_for_another_lemma_is_not_saved_over_the_word_with_that_id`。

## 8. F7：每周回顾与周报

设计：

- **每周回顾卡片**（洞察页，位于统计格与活动图之间）：本周（周一至周日）逐日显示——学习了 / 今天还没学 / 还没到 / 没有记录。「学习了一天」= 当天有任何查词、收藏或复习（与连续天数的口径相同）。
- **每周目标**：每周 1–7 天（`weeklyGoalDays`，`0` 为不设，无效值按 0 处理），进度条加一句话：已达成 / 还差 N 天、本周还有 M 天可以学 / 剩下的日子不够补到 N 天了。今天只有在还没学的时候才算「还剩的一天」。
- **周报**：本周或上周，「保存周报」（系统保存对话框，文件名 `鸽鸽词典周报-周一日期.md`）与「复制周报」，格式为 Markdown。内容：周范围、逐日表、复习作答（答对 / 有点难 / 答错 / 未记录；只有所有答案种类都已知时才给答对率）、词库现状快照（常查的词、易错的词，标注「截至」日期）。
- **数据来源**：报告永远用点击那一刻读取的 `getLearningInsights(14)`——14 天从一周中任何一天都够得到上周的周一（13 天从周日起就够不到），与页面上选的 7 / 30 / 90 天无关；不为周报读取整个词库（洞察页上的词库上下文可能是旧的）。来自词库的词会做 Markdown 转义，不能改变文档结构。
- **「周」从哪里来**：由后端给出的 `today` 字符串用 date-fns 推算，不用机器时钟。数据没有覆盖整周时，卡片与周报明说「没有读到记录」，不把未知当成「没学」。
- 顺带的修正：洞察页的「本周新增」改名为「近 7 天新增」（它是滚动 7 天，不是日历周）；掌握度名称集中到 `MASTERY_LABELS`，菜单顺序按词的成长顺序（新词、巩固中、熟悉、已掌握）。

验收：`weekly.test.ts`（32 项：周的推算与跨月跨年、目标判定、文案、转义、窗口足够性）与 `WeeklyCard.test.tsx`（24 项：卡片状态、目标、保存与复制、取消对话框、失败提示）。

## 9. Schema、命令与设置

### 9.1 Schema

`LATEST_SCHEMA_VERSION = 7`：`ALTER TABLE review_state ADD COLUMN hard_count INTEGER NOT NULL DEFAULT 0`（`add_column_if_missing`，可重复执行）。首次启动 v1.10.0 时，数据库从 v6 升到 v7，先做预迁移备份，失败回滚。

### 9.2 命令与事件增量

```text
get_enrichment_status / start_enrichment / pause_enrichment / resume_enrichment / stop_enrichment
test_connection（新增 backup 参数）
submit_review（答案为 correct / hard / wrong）
get_learning_insights（新增 review.hard、hardWords、reviewCalendar）
事件 enrichment://progress
本机事件 lookup_backup_used / enrichment_started / enrichment_word_done / enrichment_word_failed / enrichment_ended
```

无删除的命令。

### 9.3 设置键增量

```text
backupProvider: { enabled, baseUrl, model, protocol, apiKey }   # 默认关闭；apiKey 走 DPAPI
enrichDailyTokens: number                                     # 默认 100000；0 = 不限制
enrichPace: 'gentle' | 'normal' | 'fast'                      # 默认 normal
weeklyGoalDays: number                                        # 0–7；默认 0（不设目标）
```

## 10. 实施任务

| 编号 | 任务 | 提交 |
| --- | --- | --- |
| T1 | F3：固定工具链与 clippy 门禁 | `05ec9a3` |
| T2 | F1：备用模型 | `89a1477` |
| T3 | F2：生词库长列表窗口化 | `5d09175` |
| T4 | F4：「有点难」、schema v7、复习日历 | `0b64261` |
| T5 | F5：批量补全 | `0d90105` |
| T6 | F6：重新解析遇到词形变化 | `8d846ee` |
| T7 | F7：每周回顾与周报 | `aa956a2` |
| T8 | 版本 1.10.0、文档、全量验证 | — |

## 11. 已知边界

- 窗口化的表格里，浏览器的页内查找（Ctrl+F）只找得到已经绘制的行；搜索框与排序才是在大词库里找词的正路。400 词以内不受影响。
- 批量补全的 token 是估算值，不是服务商的账单；账单以服务商为准。
- 暂停与停止都让手头那个请求完成，所以最多要等一次请求才会静止。
- 批量请求不出现在查词历史里，也不计入「今日查询」，只计入 token 用量。
- 备用模型只有一个，只试一次；两个都失败时按主模型的失败给建议，并附上备用的原因。
- 周报不含逐词清单（洞察页上的词库上下文可能是旧的），它给的是「常查 / 易错」的快照。
- 复习日历依赖 `local_events`，只保留 90 天，12 周放得下；升级之前的复习没有日历数据（`review_state` 的累计数不受影响）。

## 12. 风险

| 风险 | 缓解 |
| --- | --- |
| 备用模型把同一份选中文本发给第二个服务 | 默认关闭；开关说明与 README 写明；只在能帮上忙的错误上触发；与主模型是同一个服务则不启用 |
| 复习键位变化，肌肉记忆按错 | 发布说明与升级说明写明；每个答案的按钮提示写明后果；键 3 = 不认识 |
| 批量补全悄悄花掉用户的 token | 默认每天 10 万 token 的上限；`0` 才是不限制，无效值回到默认；开始前显示预计用量；设置里写明是估算 |
| 批量补全覆盖用户写的内容 | 只填空缺；每个词一个事务；`fill_gaps` 的测试逐字段断言保留 |
| 窗口化让页内查找 / Tab 键够不到未绘制的行 | 400 词以内不窗口化；超过之后靠搜索与排序；读屏器通过 `aria-rowcount` 听到真实长度；列入已知边界 |
| Schema v7 迁移失败锁库 | 沿用单事务、预迁移备份、失败回滚；旧备份恢复后立即升级；迁移测试 |
| 周报数据不足被当成「没学」 | 数据没有覆盖整周时不给数字、不生成报告 |
| 洞察页的数字被当作权威 | 页面注明数据来源于本机记录；所有数字可由既有表复算 |

---

关联文档：`docs/ROADMAP-v1.9-v2.0.md`、`docs/PRD-v1.9-spec.md`、`docs/RELEASE-NOTES-v1.9.0.md`。
