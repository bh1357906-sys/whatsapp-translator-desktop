# WA Translator（Windows 桌面版）

加载官方 WhatsApp Web：聊天消息自动翻译成你的语言；你用中文打字，按回车自动翻译成对方语言再发出。自带 API Key（DeepSeek / OpenAI / Gemini / 任意 OpenAI 兼容接口），无后端，不碰聊天协议。

Mac 用户请用 Chrome 插件版（`translator-chrome-extension`），功能相同。

## 功能

- **自动翻译消息** — 每条消息下面显示一行译文。只翻译屏幕附近的消息，最多同时 3 个请求，结果缓存在本机，重启不重复花钱。
- **回车自动翻译发送** — 草稿有中文时，按回车 / 点发送会先翻译再发；翻译失败**不会发出原文**，草稿保留。
  - `Ctrl+Enter`：不翻译，直接发原文。
  - 草稿里没有中文（直接打外语、纯表情、链接）→ 原样发送，不调接口。
  - `Shift+Enter` 换行；`Alt+T` 或「译」按钮只翻译草稿不发送。
- **每个聊天单独记语言** — 右下角语言按钮切换，自动记住；新聊天用设置里的默认语言。
- **悬浮按钮可拖动** — 按住任意按钮拖到合适位置，会记住；语言面板里可以一键恢复默认位置。
- **用量统计** — 语言面板和设置页显示今天 / 本月的请求次数和 tokens。
- **API Key 加密保存** — 用 Windows 系统加密（DPAPI），不再明文存盘。
- **自动更新** — 启动后自动检查 GitHub Release，有新版本就在后台下载，下载完提示「立即重启安装」；选「稍后」则下次关闭应用时自动安装。
- **聊天助手（💬）** — 设一个目标聊天后，分析对方态度、给 3 条候选回复（点一下填入输入框）、复盘、导入 WhatsApp 导出的 txt 生成人物档案。

## 发布新版本

1. 改 `package.json` 里的 `version`（例如 `0.3.1`）。
2. 提交后打标签并推送：`git tag v0.3.1 && git push --tags`。
3. GitHub Actions 自动打包 exe，并把 `exe`、`.blockmap`、`latest.yml` 一起上传到 Release（**自动更新靠这三个文件**，不要删）。
4. 已安装的用户下次启动就会自动收到更新。

## 本地开发

```bash
npm install
npm start
npm test        # 单元测试
npm run dist    # 本机打 Windows 安装包
```

## 代码结构

```
main.js               应用配置（网址、名称、更新仓库）
preload.js            页面适配器：WhatsApp Web 的所有选择器都在这里
core/                 通用逻辑（WA / TG 两个项目完全相同，改一边要同步到另一边）
  lang.js             语言列表、中/日/韩文字识别、发送前检查
  service.js          翻译服务：设置、队列、缓存、重试、用量（桌面版和插件共用）
  main-core.js        Electron 主进程：窗口、菜单、自动更新、输入框写入
  renderer-core.js    页面：翻译行、发送拦截、工具栏和面板
wingman/              聊天助手（服务 + 页面）
extension/            Chrome 插件的构建脚本（npm run build:ext）
settings.*            设置窗口
test/                 单元测试
```

## 已知限制

- 只翻译文字；图片、语音、贴纸跳过。
- 网页版改版后如果翻译不出现或回车不翻译，只需要更新 `preload.js` 里的选择器。
- exe 没有代码签名，首次运行 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」。
- 消息文本会发送到你选择的翻译服务商，按 token 计费。
