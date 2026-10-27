# Pi Tab

[简体中文](README.md) | English

**Harness in Browser**

Pi Tab runs Pi Agent in your browser using Pi Durable. Open it with a bookmark or Chrome extension to read pages, click buttons, fill forms, run JavaScript, and save conversations. The extension shares conversations across tabs on the same hostname, restores windows after reloads, and supports collaboration across tabs.

## Get started

### → [Open the Pi Tab installer](https://aitimos.github.io/pi-tab/)

1. Open the installer above in Chrome. You can also download the [standalone HTML file](https://github.com/aitimos/pi-tab/releases/latest/download/pi-bookmarklet-chat-install.html) and open it locally.
2. Select the **API protocol** and enter the **Base URL and API Key** in the chat panel. Models are discovered automatically; choose a model and thinking level, then click **保存并开始** (Save and start). You can try it immediately, and the bookmark will use the saved settings. You can also save an unconfigured bookmark and set it up later.
3. Show the bookmarks bar (Windows: `Ctrl+Shift+B`; macOS: `⌘+Shift+B`), then drag the **Pi Tab** button onto it.
4. Open the webpage you want to work with and click **Pi Tab**.
5. If the saved configuration is complete, enter a task directly. Otherwise, fill in the missing settings in the floating window and click **保存并开始** (Save and start).

Try these prompts:

- “Summarize the main points of this page.”
- “Convert the table on this page to CSV.”
- “Find out why this page scrolls horizontally and fix it.”

At desktop widths, press `Enter` to send or `Shift+Enter` for a new line; use the send button on narrow screens. Messages sent during a reply enter a queue. Hold or right-click the send button and choose **直接发送** to steer the current task. Queued messages can be edited, canceled, or promoted to steering messages.

The top **新对话** button starts a blank conversation in the current window. **新开窗口** opens another blank conversation with the same model configuration. You can switch conversations while tasks run; a ring on the right marks running conversations. To remove a conversation, click its trash icon, then **确认删除**. Stop running tasks first. Deleting the current conversation switches to another; deleting the last one creates a blank conversation.

Windows support dragging, resizing, snapping to the left or right edge, and minimizing. Release position and drag velocity determine the docked side, which is preserved when the browser resizes. In **Pi 设置**, choose **跟随** (follow), **浅色** (light), or **深色** (dark). Follow is the default: it uses the page’s CSS color scheme or background, falling back to the browser or system preference. Settings are grouped into General, Instructions, and Execution, with a fixed save button. They include a restore-built-in-instructions action, automatic context compaction, retries, tool execution, and queue options. Model controls are below the composer.

## Install the Chrome extension

Use the extension when you want active tasks to resume automatically after a reload or agents in different tabs to collaborate.

1. Download and extract the [Pi Tab extension](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip).
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the extracted `pi-tab-extension` folder.
3. On a regular webpage, click the Pi Tab toolbar icon to enable that tab. Configure a model and start working. The tab will restore automatically after a reload.

Bookmark mode uses `agent_spawn` to create a conversation on the same page. Installing the extension does not add extension tools to a bookmark session; start from the Chrome toolbar icon for cross-tab work.

The extension provides `tab_list`, `tab_open`, `tab_send`, and `tab_read`. `tab_open` opens a new tab with its own conversation, including on the same hostname, and returns `tabId` and `chatId` for sending tasks and reading results. Conversations are grouped by exact hostname: paths, query parameters, and tabs on `www.bilibili.com` share a list, while `search.bilibili.com` has a separate list. Saved models and providers are shared across websites. The extension supports ordinary HTTP and HTTPS pages, not browser internal pages, extension stores or other pages that prohibit injection, or local `file://` pages.

## Configure your model

Use a model that supports tool calling. Enter the API address and model name supplied by your provider.

API types, endpoint suggestions, model metadata, and thinking levels come from the installed Pi SDK. Models are fetched from your service automatically. Retry with **获取模型** (Fetch models), or enter a model ID manually. Models labeled **目录参考** come from Pi's catalog and are not confirmed available for your account.

After the first reply, the current model generates a short conversation title in the background. It is saved and updated in the list without blocking input. Failed attempts keep the temporary title and retry after a later completed reply.

The lightweight model dropdown below the composer lists saved models and discovered models from the current provider. Choose **添加模型** (Add model) to select a provider inside the window. Use **添加提供商** (Add provider) beside the provider field to add a connection. Providers store a name, API type, URL, and key. Adding a model reuses a provider and offers model discovery, search, or a manually entered ID, with its own thinking settings. Changing models preserves the conversation. Model and thinking changes are disabled while that conversation runs, but you can switch conversations. Only supported thinking levels are listed; unknown models can have reasoning enabled manually. New conversations inherit the source conversation's model and thinking settings; there is no separate global default-model setting.

`google-vertex` uses a Vertex Express API key; `bedrock-converse-stream` uses a Bedrock API key; `openai-codex-responses` needs a valid Codex OAuth access token. Obtain credentials from the respective service; this page does not perform OAuth login or refresh.

The bookmark contains all the code and does not download external scripts at runtime. Model requests still connect to the API you configure.

## Files and images

Use the attachment button, drop files into the composer, or paste images. Supported formats are UTF-8 text, source code, Markdown, JSON, CSV, and PNG/JPEG/WebP/GIF images. Images require a vision-capable model; custom models can enable image input under Model capabilities when the service supports it. PDF, Word, Excel, audio/video, and archives are not parsed.

Up to 8 attachments are allowed, with 5 MB per file and 10 MB total. Attachments are sent to the configured model service and saved with sent messages. Editing a queued message preserves its attachments. Switching conversations within a window retains separate drafts and pending attachments; unsent drafts do not survive a page reload.

## Conversation storage and recovery

| | Bookmark | Chrome extension |
| --- | --- | --- |
| Storage | IndexedDB in the webpage's origin | Extension IndexedDB, grouped by exact hostname |
| Multiple tabs | Concurrent tabs may use separate stores; a shared list is not guaranteed | Tabs on the same hostname share a conversation list |
| Reload and navigation | Click the bookmark again; records can be restored in the same tab and origin | Enabled tabs are reinjected; background runs survive webpage reloads |
| Model settings | Separate webpage storage; the bookmark carries its saved configuration | Saved models and providers are shared across websites |

Continuing page operations requires an available tab on the target website. Task continuity is not guaranteed after closing the browser, uninstalling the extension, or clearing storage. Bookmark mode also depends on the page's CSP, same-origin restrictions, and storage permissions. Neither mode provides cloud conversation sync or automatically merges records with the other mode.

Deleting a conversation removes its list entry and resets its active context. Saved models and providers remain. Pi Durable's underlying history log is retained in local storage; this is not a disk data erasure feature.

## Scope and limitations

- AI works within the current webpage. It can read content and element styles, click, fill out forms, run JavaScript, and inspect Console logs and fetch request summaries recorded after injection.
- The standalone installer needs no Node.js or server. Bookmark URLs include the saved model configuration and API key and may sync with browser bookmarks. Save the bookmark again after changing installer settings. Do not share bookmarks containing keys.
- Bookmark tools run in the webpage environment and can access exposed JavaScript globals. Extension tools run in an isolated environment: they can operate on the DOM but cannot directly access the page scripts' globals. Console and fetch capture only covers the tools' execution environment, not the complete DevTools Console or Network panel.
- Bookmark requests require the model API to allow cross-origin browser requests (CORS), and page policies may block scripts or connections. The extension sends model requests from its background environment rather than the webpage origin; valid credentials and a reachable API are still required.
- Stopping a task does not undo changes already made to the page or interrupt synchronous JavaScript that blocks the page.

## Development and debugging

For everyday use, the bookmark installer above is all you need. To work from the browser’s developer Console, you can also paste the [complete plugin](dist/pi-console.js), then run:

```js
await pi.configure({
  api: 'openai-completions',
  baseUrl: 'https://your-model-provider/v1',
  apiKey: 'your API key',
  model: 'your model name',
});
await pi.prompt('Check this page for layout issues');
pi.help(); // Show tools, configuration, and control methods
```

Use Node.js 24. From the repository root:

```bash
npm ci
npm run build
npm test
```

The plugin source entry point is `src/plugin.js`, and the installer source is `src/install-template.html`. This command generates the Console plugin, bookmark installer, and Chrome extension folder and ZIP under `dist/`, and updates the runtime in the floating chat bookmark installer in the repository root. `npm test` covers model discovery, API requests, thinking settings, bookmark packaging, and extension message routing.

Extension window regression tests use `agent-browser` in a separate Chrome for Testing session. After building, set `PI_TAB_TEST_CHROME` to the full executable path and run `npm run test:extension` to verify startup, window operations, conversation creation and deletion, running indicators, themes, and repeated injection. Run `npm run test:tabs` to drive actual tool calls through a local model protocol server and verify opening, listing, messaging, page execution, and reading results across same-host and cross-host tabs. It also checks the tool list sent to the model. These scripts do not replace end-to-end testing with a real model service.

If your model API does not allow CORS, run `npm start` to start the local relay. Then pass the `proxyUrl` and `proxyToken` printed in the terminal to `pi.configure()` in the current page’s Console. The page must still allow connections to the local address.

### Automated extension releases

Pull requests and pushes to main build and test the extension. To release, update the versions in `package.json`, `package-lock.json`, and `extension/manifest.json`, add a `CHANGELOG.md` entry, commit, then push the matching `vX.Y.Z` tag. GitHub Actions checks the versions, builds and tests, then publishes the extension ZIP and standalone installer together. The installer download button points to the latest Release.

Unpacked extensions require replacing the files in the original directory, reloading in `chrome://extensions`, and refreshing the webpage. GitHub Releases do not automatically update installed browser extensions.

## Community

[Issues and feature requests](https://github.com/aitimos/pi-tab/issues/new/choose) | [Contributing](CONTRIBUTING.md) | [Code of conduct](CODE_OF_CONDUCT.md) | [Security policy](SECURITY.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
