# 鸽鸽词典 v1.4.4

本版本在 v1.4.3 的数据安全和行为修复基础上，补充真实 Windows 数据库/API 验证、首屏性能优化与构建依赖安全修复。

## 可靠性与验证

- 使用真实 Windows 数据库中的 DPAPI API Key 完成只读在线查词 smoke，验证不会改写用户数据库。
- 继续覆盖 SQLite WAL 快照、迁移、恢复、导入、剪贴板去重和流式降级回归。
- Tauri 实机在隔离 `%APPDATA%` 下验证启动、onboarding 懒加载和 updater 签名检查。

## 性能与供应链

- 路由页面改为按需加载，首屏 JS 主 chunk 从约 635KB 降至约 244KB。
- 锁定 `nanoid` 至 3.3.18，清除 npm audit 高危开发依赖告警。
- 发布工作流继续执行 TypeScript、Vitest、Lint、生产构建、Rust 测试与格式检查。

正式发布仍须由 GitHub Actions 使用受控的 updater 私钥生成 `.sig` 和 `latest.json`。
