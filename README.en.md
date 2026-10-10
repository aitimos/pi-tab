# Pi Tab

[简体中文](README.md) | English

**Harness in Browser**

Drag Pi Tab to your bookmarks bar, open a webpage, and click the bookmark. Use the floating chat window to ask AI to read the page, click buttons, fill out forms, and run JavaScript. No browser extension or server deployment is required; configure your model API to get started.

## Get started

### → [Open the Pi Tab installer](https://xred-team.github.io/pi-tab/)

1. Open the installer above in Chrome. You can also download the [HTML file](pi-bookmarklet-chat-install.html) and open it locally.
2. Select the **API protocol** and enter the **Base URL and API Key** in the chat panel. Models are discovered automatically; choose a model and thinking level, then click **保存并开始** (Save and start). You can try it immediately, and the bookmark will use the saved settings. You can also save an unconfigured bookmark and set it up later.
3. Show the bookmarks bar (Windows: `Ctrl+Shift+B`; macOS: `⌘+Shift+B`), then drag the **Pi Tab** button onto it.
4. Open the webpage you want to work with and click **Pi Tab**.
5. If the saved configuration is complete, enter a task directly. Otherwise, fill in the missing settings in the floating window and click **保存并开始** (Save and start).

Try these prompts:

- “Summarize the main points of this page.”
- “Convert the table on this page to CSV.”
- “Find out why this page scrolls horizontally and fix it.”

Press `Enter` to send or `Shift+Enter` for a new line. You can drag or minimize the window, stop a task, or start a new conversation. Click the bookmark again to reopen a hidden window.

## Configure your model

Use a model that supports tool calling. Enter the API address and model name supplied by your provider.

API types, endpoint suggestions, model metadata, and thinking levels come from the installed Pi SDK. Models are fetched from your service automatically. Retry with **获取模型** (Fetch models), or enter a model ID manually. Models labeled **目录参考** come from Pi's catalog and are not confirmed available for your account.

Use the controls below the composer to search and switch models or adjust thinking without clearing the conversation. Switching is disabled while a task runs. Thinking levels use Pi's original values and supported options.

`google-vertex` uses a Vertex Express API key; `bedrock-converse-stream` uses a Bedrock API key; `openai-codex-responses` needs a valid Codex OAuth access token. Obtain credentials from the respective service; this page does not perform OAuth login or refresh.

The bookmark contains all the code and does not download external scripts at runtime. Model requests still connect to the API you configure.

## Scope and limitations

- AI works within the current webpage. It can read content and element styles, click, fill out forms, run JavaScript, and inspect Console logs and fetch request summaries recorded after injection.
- The installer is a standalone HTML file that generates a JavaScript configuration constant and bookmark in the browser, without Node.js or a server. Entered settings, including the API key, are stored in the bookmark URL and may sync with browser bookmarks. Leave any setting blank if you prefer to enter it each time. After a reload or navigation, clicking the bookmark restores saved settings and asks for missing ones. Conversations and settings changed at runtime stay only in the current page’s memory. Page scripts may observe requests made within the page, so use it only on websites you trust.
- A page’s security policy may block the bookmark or model connection. Browser internal pages are unsupported. The model API must also allow cross-origin browser requests (CORS).
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

Build after changing the source:

```bash
npm install
npm run build
```

The source entry point is `src/plugin.js`. This command generates the Console plugin and Console bookmark installer under `dist/`, and updates the runtime in the floating chat bookmark installer in the repository root. Run `npm test` to check model discovery and Pi model settings.

If your model API does not allow CORS, run `npm start` to start the local relay. Then pass the `proxyUrl` and `proxyToken` printed in the terminal to `pi.configure()` in the current page’s Console. The page must still allow connections to the local address.
