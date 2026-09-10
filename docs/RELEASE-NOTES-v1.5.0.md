# 鸽鸽词典 V1.5.0

本版本不堆新大功能，把取词主场景做稳，把隐私卖点在运行时兑现，并让使用指标本地可核验。

## 主场景

- 默认黑名单只保留密码管理器；不再默认屏蔽 VS Code / Visual Studio / IDEA / 终端。
- 新增「在 IDE / 终端中查词」开关（默认开启）；关闭后可自定义 IDE/终端进程列表。
- 内容过滤改为强语境判定：`import the data from Excel`、`Constant practice matters` 等自然英语不再被误杀；`import numpy as np`、`const x = 42` 等仍被拦截。
- 过滤结果记录原因枚举，便于本地统计。

## 隐私运行时

- 启用 WebView 最小 CSP（`script-src 'self'`，禁止远程脚本）。
- 日志不再打印选中原文，仅保留长度、类型与短哈希。
- `get_settings` 不再向界面下发明文 API Key；界面仅显示「已配置」占位符，测试连接由后端使用本机密文解密。

## 本地统计

- Schema v4：新增 `local_events` 按日聚合表（保留 90 天）。
- 设置 → 本地统计：近 7 日查词、缓存命中率、过滤原因分布、流式降级、复习答题；可一键清除。
- 全部数据仅存本机，不上传。

## 工程

- 新增 PR CI：`tsc --noEmit`、lint、Vitest、生产构建、`cargo fmt`、`cargo test`。
- 版本号三处同步为 1.5.0。

## 验证

- Rust 单元测试覆盖过滤弱/强语境、schema v4 迁移与 local_events。
- 前端类型检查与生产构建通过。
- 升级用户：v3 数据库自动迁移到 v4，迁移前自动备份。
