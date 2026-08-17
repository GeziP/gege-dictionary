# 鸽鸽词典发布流程

v1.2 起，安装包必须使用 Tauri updater 密钥签名。公钥已提交到
`src-tauri/tauri.conf.json`；私钥和密码不得进入仓库、Issue、日志或构建产物。

## 首次配置 GitHub Secrets

在仓库的 Actions secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码

维护者还应把私钥和密码分别备份到受控的密码管理器或离线介质。丢失私钥或密码后，
已安装客户端将无法验证后续更新。

## 发布

1. 同步 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本号。
2. 本地执行 `npm ci`、`npx tsc --noEmit`、`npm run lint` 和 Rust 单元测试。
3. 推送 `vX.Y.Z` tag，或在 Actions 中手动运行 `release` workflow。
4. workflow 构建签名 NSIS、生成 `latest.json`，并创建 draft release。
5. 检查版本、release notes、安装包、`.sig` 与 `latest.json` 后再发布 draft。
6. 使用上一版本客户端完成一次检查、下载、签名校验、安装和重启验收。

如需在不同 Windows 用户或机器上执行可选 live smoke test，可临时设置
`GEGE_LIVE_API_KEY`；它只被 ignored 测试读取，不会写入数据库或日志。未设置时，测试从
`GEGE_LIVE_DB` 的 DPAPI 密文读取，必须在原始加密用户/机器上下文中运行。

更新包签名与 Windows Authenticode 代码签名用途不同；公开发布时仍建议为可执行文件配置
Windows 代码签名证书，以减少 SmartScreen 警告。
