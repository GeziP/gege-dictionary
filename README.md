<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="鸽鸽词典">
</p>

<h1 align="center">鸽鸽词典 / Gege Dictionary</h1>

<p align="center">
  <strong>复制即查词 · AI 深度解析 · 本地离线存储</strong>
</p>

<p align="center">
  <a href="https://github.com/GeziP/gege-dictionary/releases/latest">
    <img src="https://img.shields.io/github/v/release/GeziP/gege-dictionary?style=flat-square" alt="Release">
  </a>
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/github/repo-size/GeziP/gege-dictionary?style=flat-square" alt="Repo Size">
</p>

---

## 简介

鸽鸽词典是一款 Windows 桌面英语词典应用，在任意应用中 **Ctrl+C 复制英文** 即可弹出查词窗口，由你自己配置的大语言模型（LLM）实时解析，结果保存在本机 SQLite 数据库中。

- **零服务端**：请求直接从你的电脑发往你配置的 LLM 服务，鸽鸽词典没有任何后端服务器
- **零数据上传**：生词库、设置、使用记录全部存在本地
- **自带你的 Key**：支持主流 LLM 提供商，一个 API Key 即可使用

## 核心特色

| 特色 | 说明 |
|------|------|
| **复制即查** | 在浏览器、PDF、Word、IDE 等任意应用中选中英文后 Ctrl+C，自动弹出查词窗口 |
| **单词 / 短语 / 句子 / 段落** | 自动识别选中内容类型，匹配不同的解析模板 |
| **逐句对照翻译** | 段落翻译支持沉浸式逐句对照显示，原文+译文一一对应 |
| **领域知识扩展** | 自动识别专业领域（计算机/IVD医疗/金融等），补充深度知识、代码示例 |
| **Markdown 富文本** | 解析结果中的 **加粗**、`代码`、列表等自动渲染 |
| **TTS 朗读** | 调用 Windows 语音引擎朗读单词和例句 |
| **生词库管理** | 支持搜索、筛选、标签、批量操作、导入/导出（CSV/Markdown/Anki） |
| **多模型支持** | 兼容 OpenAI / Anthropic 协议，支持 GLM、DeepSeek、Kimi、Ollama 等 |
| **系统托盘常驻** | 最小化到托盘，随时可用 |
| **字体大小调节** | 查词窗口和生词库均可实时调整字体大小 |
| **剪贴板去重** | 已查过的内容不会重复触发，除非重新复制 |

## 安装

### 下载安装包

前往 [Releases](https://github.com/GeziP/gege-dictionary/releases/latest) 页面，下载最新的 `鸽鸽词典_x.x.x_x64-setup.exe`，双击安装即可。

> 系统要求：Windows 10 (1803+) / Windows 11，需要 WebView2 运行时（Win10 通常已自带，Win11 100% 自带）。

### 从源码构建

```bash
# 前置条件：Node.js 18+、Rust 1.75+、Visual Studio Build Tools
git clone https://github.com/GeziP/gege-dictionary.git
cd gege-dictionary
npm install
npx tauri build
```

构建产物在 `src-tauri/target/release/bundle/nsis/` 目录下。

## 快速上手

### 1. 首次启动 — 配置 LLM

首次启动会进入设置向导，选择一个 LLM 提供商（推荐 GLM / DeepSeek），填入你的 API Key，点击「测试连接」确认连通后即可开始使用。

> 鸽鸽词典不内置任何 API Key，你需要自行在对应平台申请。

### 2. 查词

在任意应用中选中英文文本，按 **Ctrl+C** 复制，查词窗口会自动弹出。

- **单词**：完整解析（音标、释义、义项、词根、近义辨析、领域知识、例句、搭配）
- **句子**：句法拆解 + 关键词汇 + 翻译
- **段落**：逐句对照翻译 + 领域知识扩展

### 3. 收藏

在查词窗口底部点击「加入生词库」，可选打标签，保存到本地数据库。

### 4. 复习

点击系统托盘图标打开主窗口，进入生词库浏览、搜索、筛选已收藏的单词，支持导出为 CSV / Markdown / Anki TSV。

## 支持的 LLM 提供商

| 提供商 | 协议 | 推荐模型 | 备注 |
|--------|------|----------|------|
| [智谱 GLM](https://open.bigmodel.cn) | Anthropic 兼容 | GLM-5.2 | 国内直连，免费额度 |
| [DeepSeek](https://platform.deepseek.com) | OpenAI 兼容 | deepseek-chat | 中文好，价格低 |
| [OpenAI](https://platform.openai.com) | OpenAI | gpt-4o-mini | 结构化输出好 |
| [Kimi](https://platform.moonshot.cn) | OpenAI 兼容 | moonshot-v1-8k | 国内直连 |
| [Anthropic](https://console.anthropic.com) | Anthropic | claude-sonnet-4 | 高质量 |
| [OpenRouter](https://openrouter.ai) | OpenAI 兼容 | 多模型 | 一个 Key 调多家 |
| Ollama / LM Studio | OpenAI 兼容 | qwen2.5:14b 等 | 完全离线本地部署 |

## 技术栈

- **桌面框架**：[Tauri 2.0](https://tauri.app)（Rust + WebView2）
- **前端**：React 18 + TypeScript + Tailwind CSS + Vite
- **数据库**：SQLite（via rusqlite，bundled，无需额外安装）
- **HTTP**：reqwest（Rust 异步 HTTP 客户端）
- **TTS**：Windows Speech Synthesis（PowerShell 桥接）
- **安装包**：NSIS

## 项目结构

```
gege-dictionary/
├── src/                    # React 前端
│   ├── pages/              # 页面（Library, Lookup, Onboarding, Settings）
│   ├── components/         # UI 组件
│   ├── contexts/           # React Context 状态管理
│   ├── data/               # 预设数据和 Prompt 模板
│   ├── lib/                # Tauri Bridge（前后端通信）
│   └── types/              # TypeScript 类型定义
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── lib.rs          # 主逻辑、Tauri Commands、托盘
│   │   ├── db.rs           # SQLite 数据访问层
│   │   ├── llm.rs          # LLM API 调用 + JSON 修复
│   │   ├── clipboard_watcher.rs  # 剪贴板监控
│   │   └── tts.rs          # 语音朗读
│   └── icons/              # 应用图标
└── package.json            # 前端依赖
```

## 隐私说明

- 鸽鸽词典 **没有服务端**，不收集任何用户数据
- 只有「选中的文本 + 上下文 + Prompt」会发送到你自己配置的 LLM 服务
- 所有数据（生词库、设置、使用记录）保存在本机 `%APPDATA%/GegeDic/` 目录下

## 开源协议

[Apache License 2.0](LICENSE)

---

<p align="center">
  <sub>Made with ❤️ by <a href="https://github.com/GeziP">GeziP</a></sub>
</p>
