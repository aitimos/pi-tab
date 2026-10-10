# Pi Tab

简体中文 | [English](README.en.md)

**Harness in Browser**

把 Pi Tab 拖进书签栏，打开网页，点击书签，就能在悬浮聊天窗里让 AI 阅读页面、点击按钮、填写表单、执行 JavaScript。无需安装浏览器扩展，也无需部署服务；填入自己的模型接口即可开始。

## 开始使用

### → [打开 Pi Tab 安装页](https://xred-team.github.io/pi-tab/)

1. 用 Chrome 打开上面的安装页。也可以下载 [HTML 文件](pi-bookmarklet-chat-install.html) 后在本地打开。
2. 在安装页填写想保存在书签中的 **接口类型、接口地址（Base URL）、密钥（API Key）和模型名称**，点击「生成书签」。可以全部留空或只填部分内容。
3. 显示书签栏（Windows：`Ctrl+Shift+B`；macOS：`⌘+Shift+B`），把 **Pi Tab** 按钮拖到书签栏。
4. 打开想操作的网页，点击 **Pi Tab**。
5. 配置齐全时直接输入任务；未填写完整时，在悬浮窗补全缺少的配置，点击「保存并开始」。

例如：

- “总结这个页面的主要内容。”
- “把页面上的表格整理成 CSV。”
- “检查为什么出现横向滚动条，并修复。”

按 `Enter` 发送，`Shift+Enter` 换行。窗口可以拖动、最小化，也可以停止任务或新建对话；关闭窗口后，再点书签即可打开。

## 模型怎么填

使用支持工具调用的模型，地址和模型名按你的服务商提供的信息填写。

| API 协议 | Base URL |
| --- | --- |
| `openai-completions` | Chat Completions 兼容接口根地址，通常以 `/v1` 结尾 |
| `openai-responses` | Responses 接口根地址，通常以 `/v1` 结尾 |
| `anthropic-messages` | Anthropic 接口根地址，官方地址为 `https://api.anthropic.com` |

书签包含完整代码，运行时不下载外部脚本；模型请求仍会访问你填写的 API。

## 使用范围

- AI 操作当前网页，可以读取内容和元素样式、点击、填写、执行 JS，并查看注入之后记录的 Console 日志及 fetch 请求概况。
- 安装页是独立的纯 HTML，直接在浏览器中生成 JS 配置常量和书签，无需 Node.js 或服务端。填写的配置（包括 API Key）会保存在书签地址中，也可能随浏览器书签同步；不想保存的字段可以留空。刷新或跳转后，再次点击书签会载入已保存的配置，并要求补全缺少的字段。对话和运行时修改的配置仅保留在当前页面内存中。网页脚本可能观察到页面内请求，请只在信任的网页使用。
- 页面安全策略可能阻止书签或模型连接，浏览器内部页面不支持。模型接口也需要允许网页跨域请求（CORS）。
- 停止任务不会撤销已经发生的页面修改，也无法中断阻塞页面的同步 JavaScript。

## 开发与调试

日常使用只需要上面的书签安装页。需要在开发者工具 Console 中操作时，也可以粘贴 [完整插件](dist/pi-console.js)：

```js
await pi.configure({
  api: 'openai-completions',
  baseUrl: 'https://你的模型服务/v1',
  apiKey: '你的 API Key',
  model: '你的模型名',
});
await pi.prompt('检查当前页面的布局问题');
pi.help(); // 查看工具、配置和控制方法
```

修改源码后打包：

```bash
npm install
npm run build
```

源码入口为 `src/plugin.js`。此命令生成 `dist/` 下的 Console 插件及 Console 书签安装页，不会更新根目录的悬浮聊天书签安装页。

如果模型接口没有开放 CORS，可以运行 `npm start` 启动本机转发服务，再在当前网页的 Console 中将终端打印的 `proxyUrl` 和 `proxyToken` 传给 `pi.configure()`。页面仍需允许连接本机地址。
