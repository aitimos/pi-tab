# Pi Tab

简体中文 | [English](README.en.md)

**在浏览器里运行 Pi Agent。**

Pi Tab 基于 Pi Durable，把 Agent 带进你正在浏览的网页。点击书签或 Chrome 扩展，就能让它阅读页面、操作元素、执行 JavaScript，并保存会话，无需另外搭建自动化环境。

[开始使用](https://aitimos.github.io/pi-tab/) | [下载扩展](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip) | [更新记录](CHANGELOG.md)

## 亮点

- **点击即用**：书签包含 Agent 运行代码，无需安装插件或部署服务；也可通过 Chrome 扩展快捷打开。
- **直接操作当前网页**：结合页面内容和 DOM 完成分析、点击、填写与 JavaScript 调试，使用当前浏览器中的页面状态。
- **会话持久保存**：历史保存在本机，可随时切回；基于 Pi Durable 恢复未完成任务，扩展后台运行不随网页刷新销毁。
- **自由选择模型**：添加多个提供商和模型，在输入框下方快速切换、编辑或删除，按模型能力设置思考强度。

## 能做什么

| 功能 | 用法 |
| --- | --- |
| 页面阅读与整理 | 总结内容、提取表格或列表，整理成 JSON、CSV |
| 网页操作与调试 | 点击、填写表单、检查 DOM 和样式、执行 JavaScript |
| 文件与图片 | 上传文本和代码文件，拖入文件或粘贴图片；图片需要视觉模型 |
| 连续对话 | 运行时追加任务、编辑待发送队列，或优先发送消息介入当前任务 |
| 回复排版 | Markdown 标题、列表、表格、引用和代码块；复制保留原始 Markdown |
| 侧边收起 | 窗口吸附左右边缘后，移开鼠标收成窄条，移入展开；编辑中的内容保持展开 |
| 会话管理 | 自动生成标题、显示运行状态、切换和删除会话，也可在新窗口继续另一项任务 |
| 多 Agent 协作 | 同页 Agent 互发消息；扩展还可打开其他标签页、发送任务并读取结果 |
| Linux 工具（仅扩展） | 每个会话独立运行 Linux，使用 `bash/read/grep/edit` 执行命令、读取、搜索和修改文件 |
| 中英双语 | 默认跟随浏览器语言，也可在设置中切换；切换不影响会话和正在执行的任务 |
| 界面与偏好 | 跟随网页或系统主题，也可选浅色、深色；支持拖动、缩放、最小化和贴边放置 |

可以试试：“总结这个页面”“把表格整理成 CSV”“检查页面为什么出现横向滚动条”。

在输入框模型菜单选择「管理模型」，可修改已保存提供商的地址、密钥及关联模型，或删除不再使用的配置。删除会保留会话历史和 OAuth 登录，正在运行的配置需先停止任务。

## 快速开始

先选择接口类型，再选择对应的认证方式：密钥、无需认证或提供商账号登录。登录后只显示该接口下账号可用的模型；使用密钥时填写 Base URL、API Key 和模型名称。

### 书签

1. 打开[安装页](https://aitimos.github.io/pi-tab/)，配置模型并试用。
2. 将 **Pi Tab** 按钮拖到浏览器书签栏。
3. 打开目标网页，点击书签，输入任务。

无需安装扩展。在安装页配置后保存的书签会携带全部已保存模型、供应商和当前默认选择到其他网站；网页内修改的配置仅保存在本站，不会改写已有书签。

### Chrome 扩展

1. [下载扩展包](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip)，解压。
2. 打开 `chrome://extensions`，开启开发者模式，选择「加载已解压的扩展程序」，加载 `pi-tab-extension` 文件夹。
3. 在目标网页点击工具栏的 Pi Tab 图标，配置模型后开始使用。

| | 书签 | Chrome 扩展 |
| --- | --- | --- |
| 打开方式 | 点击书签，注入当前网页 | 点击浏览器工具栏图标 |
| 刷新之后 | 重新点击默认打开空白会话；有未完成任务时恢复该任务 | 已启用标签页自动恢复，后台任务继续运行 |
| 会话与配置 | 提示词、模型与供应商设置按网站来源共享（协议、域名、端口相同），与会话独立保存；并发标签页可有各自的会话记录 | 同一完整域名共享会话列表，模型配置跨网站共享 |
| 协作范围 | 当前页面内的多个 Agent | 支持跨标签页任务协作 |

两种模式的会话记录独立。跨标签页能力需要从扩展图标启动，安装扩展不会改变书签模式的能力。

### 扩展内的 Linux

首次调用文件或命令工具时启动，默认目录为 `/workspace`。`bash` 工具运行 BusyBox `/bin/sh`，支持管道和重定向，不支持 GNU Bash 专属语法。`read` 支持分页和图片，`edit` 使用 `{path, edits:[{oldText,newText}]}` 并返回修改差异。`grep` 支持扩展正则、字面量、文件 glob 和上下文，默认最多 100 条匹配、50 KiB，不读取 `.gitignore`。

文件只存在于当前会话的 Linux 内存中，子 agent 有自己的文件系统。刷新网页或关闭标签页保留文件；删除或重置会话、扩展重载、后台页面重建及退出浏览器会清空文件。未完成的 Linux 工具调用不会自动重放。内核和初始文件系统随扩展打包，启动 Linux 不需要联网；模型调用仍需要模型服务。

当前不提供交互式终端、本机目录挂载或命令挂载。后续将 JS tool 接入 Linux 命令的约定见[命令挂载设计](docs/linux-command-mounts.md)，其中 `curl → fetch` 仅作设计说明。

普通 `npm run build` 校验并复制已构建的 Linux 资源；重编译使用 `npm run build:linux`，需要 Docker。固定版本、补丁、源码导出和验证命令见 [Linux 构建说明](linux/README.md)。

开发和测试使用 Node.js 24（可运行 `nvm use`），先执行 `npm ci`。浏览器测试直接使用项目锁定的 `agent-browser`，不使用全局安装版本。运行 `npx playwright install chromium` 后，将 `PI_TAB_TEST_CHROME` 设置为 `node --input-type=module -e "import {chromium} from 'playwright'; console.log(chromium.executablePath())"` 输出的路径，即可运行 `npm run test:bookmarklet`、`npm run test:extension` 等回归，与 CI 使用相同的工具和浏览器版本。

## 使用前了解

- 模型推理使用你配置的服务，任务所需的页面内容和附件会发送到该接口。书签可能包含 API Key，请勿分享含密钥的书签。
- 页面安全策略可能限制书签运行或模型连接；扩展适用于普通 HTTP/HTTPS 网页，不支持浏览器内部页等禁止注入的页面。
- 点击停止会取消当前会话的执行和排队消息；扩展关闭任务所属标签页时也会停止该页任务，刷新仍可继续。已经发生的页面操作不会撤回。
- 会话保存在本机，没有云端同步。更新书签需从安装页重新拖入；扩展需替换文件并重新加载。

详细操作、附件格式、存储与恢复规则见[使用指南](docs/usage.md)。

## 账户登录

直接复用 Pi 的 OAuth 登录、令牌刷新和提供商调用，无需本地服务。支持 Anthropic 粘贴授权码或完整回调 URL；OpenAI Codex（Pi 的 legacy 提供商）可选择粘贴回调 URL 或设备码登录。GitHub Copilot、Kimi Coding、Meta、xAI 使用设备授权流程。回调 URL 由 Pi 原生逻辑解析并校验，无需本地回调服务。可用模型由账号权限决定。 Anthropic 令牌接口目前不允许安装页来源的跨域请求，请使用扩展登录；粘贴回调 URL 本身不能解除跨域限制。

书签首次登录或使用 Bedrock 时从安装站加载所需资源，需要网页允许相应脚本和网络请求。书签登录状态保存在当前网站，不随书签导出，换网站需重新登录；扩展的登录状态在扩展内保存，可跨网站使用。退出登录会删除对应提供商凭据。

## 参与项目

欢迎通过 [Issues](https://github.com/aitimos/pi-tab/issues) 反馈问题，或提交 Pull Request。

感谢 [LINUX DO](https://linux.do/) 社区提供交流与分享的空间。

本项目代码采用 [Apache License 2.0](LICENSE)；随扩展分发的 Linux、BusyBox 和 linux-wasm 运行代码保留各自许可证，详见 [NOTICE](NOTICE) 和 [Linux 构建说明](linux/README.md)。
