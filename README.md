# Pi Tab

简体中文 | [English](README.en.md)

**Harness in Browser**

Pi Tab 基于 Pi Durable，在浏览器中运行 Pi Agent。通过书签注入或 Chrome 扩展快捷打开，Agent 可以阅读页面、点击按钮、填写表单和执行 JavaScript，并保存会话。扩展支持同域标签页共享会话、刷新后恢复窗口和跨标签页协作。

## 开始使用

### → [打开 Pi Tab 安装页](https://aitimos.github.io/pi-tab/)

1. 用 Chrome 打开上面的安装页。也可以下载 [独立 HTML 文件](https://github.com/aitimos/pi-tab/releases/latest/download/pi-bookmarklet-chat-install.html) 后在本地打开。
2. 在聊天窗口选择 **接口类型**，填写 **接口地址（Base URL）和密钥（API Key）**。模型列表会自动获取，选好模型和思考档位后点击「保存并开始」。可以直接试用，书签也会自动使用这份设置；也可以先保存空白书签，在使用时配置。
3. 显示书签栏（Windows：`Ctrl+Shift+B`；macOS：`⌘+Shift+B`），把 **Pi Tab** 按钮拖到书签栏。
4. 打开想操作的网页，点击 **Pi Tab**。
5. 配置齐全时直接输入任务；未填写完整时，在悬浮窗补全缺少的配置，点击「保存并开始」。

例如：

- “总结这个页面的主要内容。”
- “把页面上的表格整理成 CSV。”
- “检查为什么出现横向滚动条，并修复。”

桌面宽度下按 `Enter` 发送，`Shift+Enter` 换行；窄屏用发送按钮提交。生成回复时发送的消息会排队；长按或右键点击发送按钮，可选择「直接发送」介入当前任务。排队消息支持编辑、取消或改为直接发送。

顶部的「新对话」在当前窗口创建空白会话；「新开窗口」创建另一个空白会话，沿用原会话的模型配置。任务运行时可以切换到其他会话，会话列表右侧的圆环表示正在运行。点击会话右侧的删除图标，再点「确认删除」可从列表移除会话；运行中的会话需先停止。删除当前会话会切换到其他会话，删除最后一条会创建空白会话。

窗口支持拖动、调整大小、贴边吸附和最小化。主题放在顶部「Pi 设置」中；这里还可以查看、修改内置指令，设置上下文自动压缩、失败重试、工具执行和消息队列方式。模型配置在输入框下方。

## 安装 Chrome 扩展

扩展适合需要刷新后自动继续任务，或让不同标签页的 agent 协作的情况。

1. 下载并解压 [Pi Tab 扩展](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip)。
2. 打开 `chrome://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择解压后的 `pi-tab-extension` 文件夹。
3. 打开普通网页，点击工具栏中的 Pi Tab 图标启用当前标签页。填写模型信息后即可使用。已启用的标签页刷新后会自动恢复。

扩展提供 `tab_list`、`tab_open`、`tab_send`、`tab_read` 工具，agent 可以打开新标签页，给其中的 agent 发任务并读取结果。会话按完整域名（hostname）保存，例如 `www.bilibili.com` 下的不同路径、查询参数和标签页共享列表；`search.bilibili.com` 则是另一组会话。模型和提供商配置在各网站之间共享。扩展访问普通 HTTP 和 HTTPS 网页，不支持浏览器内部页面、扩展商店等禁止注入的页面，也不支持本地 `file://` 页面。

## 模型怎么填

使用支持工具调用的模型，地址和模型名按你的服务商提供的信息填写。

接口类型、已知服务地址、模型参数和思考档位来自项目安装的 Pi SDK。填写地址后会自动获取服务的模型列表，也可点击「获取模型」重试；获取失败时可以手动填写模型名称。标为「目录参考」的模型来自 Pi 内置目录，是否可用取决于你的服务和账号权限。

输入框下方的模型下拉可以直接切换已保存的模型和当前提供商获取到的模型；需要配置时点击「添加模型」或「添加提供商」，在窗口内填写。提供商保存接口类型、地址和密钥，模型关联提供商并保存模型 ID 和思考配置。切换模型保留对话内容，当前会话运行时不能更换模型或思考档位，但可以切换会话。思考档位只列出当前模型支持的选项；不在目录中的模型可手动启用思考能力。新会话继承来源会话的模型和思考配置，目前没有单独的全局默认模型设置。

`google-vertex` 使用 Vertex Express API Key，`bedrock-converse-stream` 使用 Bedrock API Key，`openai-codex-responses` 需要有效的 Codex OAuth Access Token。这些凭据由相应服务提供，页面不包含 OAuth 登录或凭据刷新流程。

书签包含完整代码，运行时不下载外部脚本；模型请求仍会访问你填写的 API。

## 会话保存与恢复

| | 书签 | Chrome 扩展 |
| --- | --- | --- |
| 保存位置 | 当前网页来源的 IndexedDB | 扩展自己的 IndexedDB，按完整域名分组 |
| 多标签页 | 同时打开时可能使用独立存储，不保证共享会话列表 | 相同完整域名共享会话列表 |
| 刷新与跳转 | 需要重新点击书签；同一标签页、同源下可恢复记录 | 已启用标签页会重新注入，后台运行不随网页刷新销毁 |
| 模型配置 | 各网页存储独立，书签携带保存时的模型配置 | 已保存模型和提供商跨网站共享 |

扩展恢复页面操作需要目标网站仍有可用标签页；关闭浏览器、卸载扩展或清除存储后，不能保证任务继续。书签模式还受网页 CSP、同源策略和存储权限限制。两种模式都没有云端会话同步，也不会自动合并彼此的记录。

删除会话会移除列表项并清空该会话的当前上下文，不删除已保存的模型和提供商。Pi Durable 的底层历史日志仍保留在本地存储中，这不是磁盘数据擦除功能。

## 使用范围

- AI 操作当前网页，可以读取内容和元素样式、点击、填写、执行 JS，并查看注入之后记录的 Console 日志及 fetch 请求概况。
- 安装页是独立 HTML，无需 Node.js 或服务端。书签包含保存时的模型设置（含 API Key），可能随浏览器书签同步；安装页修改设置后需要重新保存书签。不要分享含密钥的书签。
- 书签运行在网页环境中，可以访问页面公开的 JavaScript 全局变量。扩展的页面工具运行在隔离环境中，可以操作 DOM，但不能直接读取网页脚本的全局变量；Console 和 fetch 记录也仅限工具所在环境，不等同于 DevTools 的完整日志和 Network 面板。
- 书签的模型接口需要允许网页跨域请求（CORS），页面安全策略也可能阻止脚本或连接。扩展从后台发送模型请求，不使用网页来源发起请求；仍需有效凭据和可访问的模型接口。
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

使用 Node.js 24，在仓库根目录安装依赖并验证：

```bash
npm ci
npm run build
npm test
```

插件源码入口为 `src/plugin.js`，安装页源码为 `src/install-template.html`。构建生成 `dist/` 下的 Console 插件、书签安装页、Chrome 扩展文件夹和 ZIP，并更新根目录聊天安装页的内嵌运行时和 Pi 模型目录。`npm test` 覆盖模型发现、接口请求、思考能力、书签打包和扩展消息路由。

扩展窗口回归测试使用独立的 Chrome for Testing 和 `agent-browser`。构建后，设置 `PI_TAB_TEST_CHROME` 为 Chrome for Testing 可执行文件的完整路径，再运行 `npm run test:extension`，验证启动、窗口操作、会话创建与删除、运行状态、主题和重复注入。该脚本不代替真实模型服务的端到端验收。

如果模型接口没有开放 CORS，可以运行 `npm start` 启动本机转发服务，再在当前网页的 Console 中将终端打印的 `proxyUrl` 和 `proxyToken` 传给 `pi.configure()`。页面仍需允许连接本机地址。

### 自动发布扩展

Pull Request 和 main 分支推送会自动构建并运行测试。发布时同步更新 `package.json`、`package-lock.json`、`extension/manifest.json` 的版本及 `CHANGELOG.md`，提交后推送对应的 `vX.Y.Z` 标签。GitHub Actions 验证版本一致、测试通过后，自动发布 Release，上传 `pi-tab-extension.zip` 和独立安装页。安装页的下载按钮始终指向最新 Release。

加载未打包扩展的用户需要替换原目录文件，在 `chrome://extensions` 重新加载，再刷新网页；GitHub Release 不会自动更新浏览器中已安装的扩展。

## 参与社区

[问题反馈与功能建议](https://github.com/aitimos/pi-tab/issues/new/choose) | [贡献指南](CONTRIBUTING.md) | [行为准则](CODE_OF_CONDUCT.md) | [安全报告](SECURITY.md)

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
