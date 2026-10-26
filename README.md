# Pi Tab

简体中文 | [English](README.en.md)

**Harness in Browser**

Pi Tab 可以作为书签或 Chrome 扩展使用。在网页中打开悬浮聊天窗后，AI 可以阅读页面、点击按钮、填写表单和执行 JavaScript。扩展还支持刷新后自动恢复，以及标签页之间的 agent 协作。

## 开始使用

### → [打开 Pi Tab 安装页](https://aitimos.github.io/pi-tab/)

1. 用 Chrome 打开上面的安装页。也可以下载 [HTML 文件](pi-bookmarklet-chat-install.html) 后在本地打开。
2. 在聊天窗口选择 **接口类型**，填写 **接口地址（Base URL）和密钥（API Key）**。模型列表会自动获取，选好模型和思考档位后点击「保存并开始」。可以直接试用，书签也会自动使用这份设置；也可以先保存空白书签，在使用时配置。
3. 显示书签栏（Windows：`Ctrl+Shift+B`；macOS：`⌘+Shift+B`），把 **Pi Tab** 按钮拖到书签栏。
4. 打开想操作的网页，点击 **Pi Tab**。
5. 配置齐全时直接输入任务；未填写完整时，在悬浮窗补全缺少的配置，点击「保存并开始」。

例如：

- “总结这个页面的主要内容。”
- “把页面上的表格整理成 CSV。”
- “检查为什么出现横向滚动条，并修复。”

按 `Enter` 发送，`Shift+Enter` 换行。生成回复时发送的消息会排队；长按发送按钮可选择立即加入当前任务。排队消息可以编辑或取消。窗口可以拖动和调整大小，支持深浅主题；对话可以新建、切换，也可以新开 agent 窗口。书签方式刷新后需要重新点击书签打开窗口，对话记录会恢复。

## 安装 Chrome 扩展

扩展适合需要刷新后自动继续任务，或让不同标签页的 agent 协作的情况。

1. 下载并解压 [Pi Tab 扩展](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip)。
2. 打开 `chrome://extensions`，开启开发者模式，点击“加载未打包的扩展程序”，选择解压后的 `pi-tab-extension` 文件夹。
3. 打开普通网页，点击工具栏中的 Pi Tab 图标启用当前标签页。填写模型信息后即可使用。已启用的标签页刷新后会自动恢复。

扩展提供 `tab_list`、`tab_open`、`tab_send`、`tab_read` 工具，agent 可以打开新标签页，给其中的 agent 发任务并读取结果。同一网站的会话由扩展中的一个运行实例管理，刷新或跳转到该网站的其他页面后仍可继续；已添加的模型和提供商配置在不同网站之间共享。扩展访问普通 HTTP 和 HTTPS 网页，不会在浏览器内部页面运行。

## 模型怎么填

使用支持工具调用的模型，地址和模型名按你的服务商提供的信息填写。

接口类型、已知服务地址、模型参数和思考档位来自项目安装的 Pi SDK。填写地址后会自动获取服务的模型列表，也可点击「获取模型」重试；获取失败时可以手动填写模型名称。标为「目录参考」的模型来自 Pi 内置目录，是否可用取决于你的服务和账号权限。

对话输入框下方可以搜索和切换模型、调整思考档位，已有对话会保留。在模型列表中可以单独保存提供商，再为它添加模型。当前任务运行时不能切换。思考档位显示 Pi 的原始值，只列出当前模型支持的选项；不在目录中的模型可手动启用思考能力。

`google-vertex` 使用 Vertex Express API Key，`bedrock-converse-stream` 使用 Bedrock API Key，`openai-codex-responses` 需要有效的 Codex OAuth Access Token。这些凭据由相应服务提供，页面不包含 OAuth 登录或凭据刷新流程。

书签包含完整代码，运行时不下载外部脚本；模型请求仍会访问你填写的 API。

## 使用范围

- AI 操作当前网页，可以读取内容和元素样式、点击、填写、执行 JS，并查看注入之后记录的 Console 日志及 fetch 请求概况。
- 安装页是独立的纯 HTML，直接在浏览器中生成书签，无需 Node.js 或服务端。填写的配置（包括 API Key）会保存在书签地址中，也可能随浏览器书签同步。书签方式的运行时配置和多段对话保存在当前网站的 IndexedDB 中，每个标签页使用独立的存储。刷新会清除书签脚本，重新点击书签即可继续该标签页的对话；不同网站来源的数据相互隔离。网页脚本可能观察到页面内请求，请只在信任的网页使用。
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

插件源码入口为 `src/plugin.js`，安装页源码为 `src/install-template.html`。构建生成 `dist/` 下的 Console 插件、书签安装页、Chrome 扩展文件夹和 ZIP，并更新根目录聊天安装页的内嵌运行时和 Pi 模型目录。`npm test` 检查模型发现、接口请求和思考能力。

如果模型接口没有开放 CORS，可以运行 `npm start` 启动本机转发服务，再在当前网页的 Console 中将终端打印的 `proxyUrl` 和 `proxyToken` 传给 `pi.configure()`。页面仍需允许连接本机地址。
