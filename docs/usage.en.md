# User guide

[Back to README](../README.en.md) | [简体中文](usage.md)

## Interface language

The installer and chat support Simplified Chinese and English. Auto follows your browser’s language preference order; Chinese variants use Simplified Chinese, and unmatched languages fall back to English. Change Auto / 中文 / English at the top of the installer or in Settings → General. Changes apply immediately.

Bookmark preferences are saved per website. The extension shares the preference across websites in the same browser profile. Changing language preserves conversations, drafts, attachments, and running tasks. User messages, filenames, and model output remain unchanged; the model replies in the user’s language.

## Get started

### [Open the Pi Tab installer](https://aitimos.github.io/pi-tab/)

1. Open the installer above in Chrome. You can also download the [standalone HTML file](https://github.com/aitimos/pi-tab/releases/latest/download/pi-bookmarklet-chat-install.html) and open it locally.
2. Select the **API protocol** and enter the **Base URL and API Key** in the chat panel. Models are discovered automatically; choose a model and thinking level, then click **保存并开始** (Save and start). You can try it immediately, and the bookmark will use the saved settings. You can also save an unconfigured bookmark and set it up later.
3. Show the bookmarks bar (Windows: `Ctrl+Shift+B`; macOS: `⌘+Shift+B`), then drag the **Pi Tab** button onto it.
4. Open the webpage you want to work with and click **Pi Tab**.
5. If the saved configuration is complete, enter a task directly. Otherwise, fill in the missing settings in the floating window and click **保存并开始** (Save and start).

Try these prompts:

- “Summarize the main points of this page.”
- “Convert the table on this page to CSV.”
- “Find out why this page scrolls horizontally and fix it.”

At desktop widths, press `Enter` to send or `Shift+Enter` for a new line; use the send button on narrow screens. Messages sent during a reply wait until the current task finishes (`followUp`). Hold or right-click the send button and choose **Send with priority** (`steer`) to deliver a message after all tools in the current round finish, before the next model request. During a text-only reply, it waits for that reply to finish. Priority messages do not interrupt an active model request or tool. Queued messages can be edited, canceled, or promoted to priority messages.

The top **新对话** button starts a blank conversation in the current window. **新开窗口** opens another blank conversation with the same model configuration. You can switch conversations while tasks run; a ring on the right marks running conversations. To remove a conversation, click its trash icon, then **确认删除**. Stop running tasks first. Deleting the current conversation switches to another; deleting the last one creates a blank conversation.

Windows support dragging, resizing, snapping to the left or right edge, and minimizing. While dragging, windows can move beyond either edge. Moving the pointer to the viewport edge shows a docking hint; releasing folds the window immediately, while moving back cancels docking. Positions in the middle stay where you place them. Docked windows remain at the edge when the browser resizes. In **Pi 设置**, choose **跟随** (follow), **浅色** (light), or **深色** (dark). Follow is the default: it uses the page’s CSS color scheme or background, falling back to the browser or system preference. Settings are grouped into General, Model, Instructions, Execution, and MCP, with a fixed save button. They include a restore-built-in-instructions action, automatic context compaction, retries, tool execution, and queue options. In **Pi settings → Model**, add models or edit and delete saved providers and models; each item saves separately. Quick switching remains below the composer, and the existing **Manage models** shortcut opens the same settings page.

Stop cancels the current conversation and queued messages. Closing its tab in extension mode also stops that tab’s tasks; background tasks survive reloads, but page operations require explicit authorization for the new document. Page actions already performed are not undone. Docked windows collapse to an edge handle when the mouse leaves and expand on hover; drag the handle vertically to reposition it or inward to restore the floating window; active input drafts stay open. Replies support Markdown headings, lists, tables, quotes, and code blocks, and copying preserves the original Markdown.

## Install the Chrome extension

Use the extension when you want active tasks to resume automatically after a reload or agents in different tabs to collaborate.

1. Download and extract the [Pi Tab extension](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip).
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the extracted `pi-tab-extension` folder.
3. On a regular webpage, click the Pi Tab toolbar icon to enable that tab. Configure a model and start working. The tab will restore automatically after a reload.

Bookmark mode uses `agent_spawn` to create a conversation on the same page. Installing the extension does not add extension tools to a bookmark session; start from the Chrome toolbar icon for cross-tab work.

The extension provides `tab_list`, `tab_open`, `tab_send`, and `tab_read`. `tab_open` opens a new tab with its own conversation, including on the same hostname, and returns `tabId` and `chatId` for sending tasks and reading results. Conversations are grouped by exact hostname: paths, query parameters, and tabs on `www.bilibili.com` share a list, while `search.bilibili.com` has a separate list. Saved models and providers are shared across websites. The extension supports ordinary HTTP and HTTPS pages, not browser internal pages, extension stores or other pages that prohibit injection, or local `file://` pages.

## Continue a conversation on another page

Enable the extension on the destination page, open **Conversation history** from the conversation menu, and select the original conversation. Selecting only opens history; send a new message to use the current page. Existing context and model settings remain with the original conversation, while page tools use the selected document. This works on the same hostname, another subdomain, or another hostname.

While a task runs, wait or use Stop, then send a new message. Reloading, navigation, and closing revoke the old document's authorization without replaying tasks. A new message uses the current page. After a background restart, interrupted tasks stay paused. Choose **Stop interrupted tasks for source site** from the conversation menu and confirm the affected conversations to clear them. Cancel leaves them unchanged; history is retained. **Go to execution page**, in the same menu, focuses the existing tab and window.

New conversations, new windows, and `tab_open` create independent tasks without inheriting messages. `tab_open` also returns `conversationRef`; `tab_send` and `tab_read` accept `ownerSite` and reject ambiguous numeric IDs.

Bookmark history belongs to the current origin. When another tab owns that history, startup waits at most 1.5 seconds and offers retry or an explicit independent conversation. Pages without Web Locks also require an explicit independent conversation. Use the extension for cross-site continuation.

## Configure your model

Use a model that supports tool calling. Enter the API address and model name supplied by your provider.

API types, endpoint suggestions, model metadata, and thinking levels come from the installed Pi SDK. Models are fetched from your service automatically. Retry with **获取模型** (Fetch models), or enter a model ID manually. Models labeled **目录参考** come from Pi's catalog and are not confirmed available for your account.

After the first reply, the current model generates a short conversation title in the background. It is saved and updated in the list without blocking input. Failed attempts keep the temporary title and retry after a later completed reply.

The lightweight model dropdown below the composer lists saved models and discovered models from the current provider. Choose **添加模型** (Add model) to select a provider inside the window. Use **添加提供商** (Add provider) beside the provider field to add a connection. Providers store a name, API type, URL, and key. Adding a model reuses a provider and offers model discovery, search, or a manually entered ID, with its own thinking settings. Changing models preserves the conversation. Model and thinking changes are disabled while that conversation runs, but you can switch conversations. Only supported thinking levels are listed; unknown models can have reasoning enabled manually. New conversations inherit the source conversation's model and thinking settings; there is no separate global default-model setting.

`google-vertex` uses a Vertex Express API key; `bedrock-converse-stream` uses a Bedrock API key; `openai-codex-responses` needs a valid Codex OAuth access token. Obtain credentials from the respective service; this page does not perform OAuth login or refresh.

The bookmark contains all the code and does not download external scripts at runtime. Model requests still connect to the API you configure.

## Files and images

Use the attachment button, drop files into the composer, or paste images. Supported formats are UTF-8 text, source code, Markdown, JSON, CSV, and PNG/JPEG/WebP/GIF images. Images require a vision-capable model; custom models can enable image input in the model configuration when the service supports it. PDF, Word, Excel, audio/video, and archives are not parsed.

Up to 8 attachments are allowed, with 5 MB per file and 10 MB total. Attachments are sent to the configured model service and saved with sent messages. Editing a queued message preserves its attachments. Switching conversations within a window retains separate drafts and pending attachments; unsent drafts do not survive a page reload.

If a send is definitely rejected, its original text and attachments return to the composer. If you have already started editing another message, the original appears under **Saved drafts**. Choose **Move to composer** to retrieve it while keeping your current edit as another saved draft. This does not send a message. Accepted submissions and submissions with an unknown result do not enter this list; check history and the queue first. Saved drafts last only within the current window.

## Conversation storage and recovery

| | Bookmark | Chrome extension |
| --- | --- | --- |
| Storage | IndexedDB in the webpage's origin | Extension IndexedDB, grouped by exact hostname |
| Multiple tabs | Concurrent tabs may use separate stores; a shared list is not guaranteed | History stays grouped by source; explicitly select any source to continue |
| Reload and navigation | Click again to open a blank conversation, or resume an unfinished task; previous conversations remain in the list | Enabled tabs are reinjected; background runs survive webpage reloads |
| Model settings | Separate webpage storage; the bookmark carries its saved configuration | Saved models and providers are shared across websites |

Continuing page operations requires an available tab on the target website. Task continuity is not guaranteed after closing the browser, uninstalling the extension, or clearing storage. Bookmark mode also depends on the page's CSP, same-origin restrictions, and storage permissions. Neither mode provides cloud conversation sync or automatically merges records with the other mode.

Deleting a conversation removes its list entry and resets its active context. Saved models and providers remain. Pi Durable's underlying history log is retained in local storage; this is not a disk data erasure feature.

## MCP servers

Open **Pi settings → MCP** to view servers. Use **Add server** or **Edit** to manage one entry, with headers and advanced options. Each entry saves independently; cancel leaves it unchanged. Deletion asks for confirmation and removes its tools. Header and environment values, and saved URLs containing a query, are hidden by default. Select **Show** to view or edit them.

**Import JSON** accepts pasted text or a file and always previews changes before confirmation. Four strict JSON formats are supported:

- One entry: `{"name":"docs","config":{"url":"https://example.com/mcp"}}`.
- A batch: an array of those named entries.
- A complete Pi document: the `mcpServers` example below.
- A legacy server map, retaining top-level `env` and `autoEnableCodemode`.

Existing names are kept by default. Replace explicitly overwrites an entire server entry. Names differing only in case or `-`/`_` must be renamed or skipped. Any JSON, duplicate-key, field, or naming error prevents the entire batch from being written. Global variables and extra fields also have conflict previews; variable changes validate affected existing servers.

Saving and connecting are separate results: connection failure retains saved data for correction or reconnection. Stop running tasks and wait for connections to finish before editing. Changes from another window require a fresh preview. Simultaneous writes from same-origin bookmark windows on plain HTTP do not have a strict mutual-exclusion guarantee. Legacy and unknown fields are preserved; unsupported entries remain visible.

Configuration example:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer ${DOCS_TOKEN}"},
      "description": "Product documentation search",
      "timeout": 30
    }
  },
  "env": {"DOCS_TOKEN": "..."}
}
```

- Only remote streamable HTTP servers are connected (an entry with `url`). stdio servers defined with `command` and `args` need a local process, which neither the bookmark nor the extension can start, so they are listed as unsupported.
- Fields follow Pi: `url`, `headers`, `timeout` (seconds, default 60), `enabled`, `description`, `exposure`, `toolExposure`. The legacy `type: "sse"` is retained as unsupported; servers that require OAuth sign-in are not supported yet, so use headers such as `Authorization`.
- `${NAME}` in header values resolves from an `env` object beside `mcpServers`; `!command` values cannot run in the browser.
- Tool names follow Pi: `mcp__<server>__<tool>`, with any other character replaced by `_`. Tools marked `hidden` in `toolExposure` are not registered and the rest are offered to the model directly; this runtime has no `codemode` or `tool_search`, so `exposure` is accepted for compatibility only.
- Connection state, tool counts, and errors appear under the field. **Reconnect** drops the current connections and reconnects with the saved configuration; saving changes reconnects and replaces the previous tools.
- A bookmark stores its configuration for the current site and carries it to other sites when the bookmark is saved; a site that already defines the same server keeps its own entry. Bookmark requests come from the webpage, so the server must allow CORS. The extension stores one configuration for all sites and requests from its background page.
- Tool results are data, not new instructions; MCP calls go through the same tool pipeline as the built-in page tools.

## Scope and limitations

- AI works within the current webpage. It can read content and element styles, click, fill out forms, run JavaScript, and inspect Console logs and fetch request summaries recorded after injection.
- The standalone installer needs no Node.js or server. Bookmark URLs include the saved model configuration and API key and may sync with browser bookmarks. Save the bookmark again after changing installer settings. Do not share bookmarks containing keys.
- Bookmark tools run in the webpage environment and can access exposed JavaScript globals. Extension tools run in an isolated environment: they can operate on the DOM but cannot directly access the page scripts' globals. Console and fetch capture only covers the tools' execution environment, not the complete DevTools Console or Network panel.
- Bookmark requests require the model API to allow cross-origin browser requests (CORS), and page policies may block scripts or connections. The extension sends model requests from its background environment rather than the webpage origin; valid credentials and a reachable API are still required.
- Stopping a task does not undo changes already made to the page or interrupt synchronous JavaScript that blocks the page.

## Updates

Bookmarks contain the code and configuration saved when you created them. Drag a new bookmark from the installer after an update or a configuration change; existing bookmarks do not update automatically.

For the unpacked extension, replace the files in its original directory, reload it in `chrome://extensions`, and refresh the webpage. GitHub Releases do not automatically update installed extensions.
