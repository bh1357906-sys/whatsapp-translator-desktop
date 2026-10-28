# WA Translator (desktop)

独立桌面版 WhatsApp 翻译工具：加载官方 WhatsApp Web，收到的消息自动翻成中文，草稿一键翻成对方语言再手动发送。自带 DeepSeek 引擎、自带 API key、无后端、不碰 WhatsApp 协议。

## 功能

- **自动翻译收到的消息** — 每条 incoming 消息下方渲染一行翻译（原文不改动）。
- **翻译草稿** — 输入框写中文，点右下角「译」按钮或按 `Alt+T`，草稿替换为对方语言，确认后手动发送。
- **本地设置** — DeepSeek key、阅读语言、对方语言，存本机 `settings.json`。

## 本地运行（Mac）

```bash
npm install
npm start
```

打开后扫码登录 WhatsApp Web，菜单 →「设置…」填 DeepSeek key。

## 打包

- **Windows exe（在本机）**：`npm run dist:win` — 需在 Windows 机器上执行（或交叉打包装 wine）。
- **Windows exe（CI）**：推送到 GitHub，workflow 在 Windows runner 上自动打出 `dist/*.exe` 并作为 artifact 下载。
- **macOS dmg（本机，Apple Silicon）**：`npm run dist:mac`。

## 已知限制

- 只翻译文本；图片、语音、贴纸、文档跳过。
- 消息里的 emoji 可能不进入翻译文本（WhatsApp 用图片渲染 emoji）。
- exe 未做代码签名，Windows SmartScreen 会提示「未知发布者」，点「仍要运行」即可。
- WhatsApp Web 会不定期改页面结构，若翻译突然不出现，需更新 `.message-in` / `.copyable-text` 选择器。
- 翻译走你填的 DeepSeek 账号，按 token 计费；消息文本会发送到该服务商。
