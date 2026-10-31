# WA & TG 翻译助手（Chrome 插件，Mac 用）

在 Chrome / Edge 里打开官方 WhatsApp Web 或 Telegram Web，装上这个插件后功能和 Windows 桌面版一样：消息自动翻译、中文按回车自动翻译再发送、每个聊天记住语言、聊天助手（WhatsApp）、用量统计。Windows 上的 Chrome 也能用。

## 安装（约 1 分钟）

1. 把 `translator-chrome-extension` 这个文件夹放到一个固定的位置（例如「文稿」里），**之后不要删除或移动**。
2. Chrome 地址栏打开 `chrome://extensions`（Edge 打开 `edge://extensions`）。
3. 打开右上角的「开发者模式」。
4. 点「加载已解压的扩展程序」，选择 `translator-chrome-extension` 文件夹。
5. 点浏览器工具栏里的插件图标（拼图图标里可以固定它）→ 打开设置，填 API Key，点「测试连接」→「保存」。
6. 打开 https://web.whatsapp.com 或 https://web.telegram.org/k/ ，右下角出现「译」等按钮就说明生效了。

## 使用

- 收到的消息下面自动显示中文。
- 输入框打中文按回车：自动翻译成对方语言再发。`Ctrl+Enter`（Mac：`⌘+Enter`）直接发原文。
- 右下角语言按钮：给当前聊天选语言，会自动记住。按钮可以按住拖动。
- Telegram 请使用 K 版：https://web.telegram.org/k/

## 更新

插件不是从 Chrome 商店装的，不会自动更新。拿到新版本后，用新文件夹覆盖旧文件夹里的文件，然后在 `chrome://extensions` 里点插件上的刷新按钮，再刷新 WhatsApp 网页即可。设置和联系人语言都会保留。

## 说明

- 设置、翻译缓存、聊天助手记录都保存在这台电脑的 Chrome 里，只有翻译时会把消息文本发给你选的翻译服务商。
- 用自定义接口地址时，保存时 Chrome 会询问是否允许访问那个地址，点允许即可。
- 这个文件夹是由 WhatsApp 桌面版项目里的 `npm run build:ext` 生成的，不要直接改这里的代码。
