# Pi Tab

[简体中文](README.md) | English

**Run Pi Agent in your browser.**

Built on Pi Durable, Pi Tab brings an agent into the webpage you are browsing. Open it with a bookmark or Chrome extension to read the page, interact with elements, run JavaScript, and save conversations, without setting up a separate automation environment.

[Get started](https://aitimos.github.io/pi-tab/) | [Download extension](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip) | [Changelog](CHANGELOG.md)

## Highlights

- **Open with a click**: the bookmark contains the Agent runtime and needs no extension or server deployment. A Chrome extension is also available.
- **Work directly on the page**: use page content and the DOM to analyze, click, fill forms, and debug JavaScript in your current browser context.
- **Keep your conversations**: history stays on your device and can be reopened. Pi Durable supports unfinished task recovery; extension background runs survive webpage reloads.
- **Choose your models**: add multiple providers and models, switch from the composer, and set thinking levels supported by each model.

## Features

| Feature | What you can do |
| --- | --- |
| Reading and extraction | Summarize pages, extract tables and lists, and organize data as JSON or CSV |
| Page interaction and debugging | Click, fill forms, inspect DOM and styles, and execute JavaScript |
| Files and images | Attach text and code files, drop files, or paste images with a vision-capable model |
| Follow-up messages | Add tasks while a reply is running, edit the queue, or prioritize a message to steer the current task |
| Formatted replies | Markdown headings, lists, tables, quotes, and code blocks; copying preserves the original Markdown |
| Edge sidebar | Dock to either edge to collapse on mouse leave and expand on hover; active drafts stay open |
| Conversation management | Generate titles automatically, see running status, switch or delete conversations, and open another task in a new window |
| Agent collaboration | Exchange messages between agents on the same page; the extension can also open tabs, send tasks, and read results |
| Chinese and English | Follow your browser language or switch in settings without interrupting conversations or tasks |
| Appearance and preferences | Follow the page or system theme, or choose light or dark; drag, resize, minimize, and dock windows at the edge |

Try: “Summarize this page,” “Turn this table into CSV,” or “Find out why this page scrolls horizontally.”

Choose **Manage models** in the composer’s model menu to edit or delete saved providers and models. Provider connection changes apply to linked models. Deleting configurations keeps conversations and signed-in accounts; stop tasks that use a configuration before changing it.

## Quick start

Choose an API type, then a supported authentication method: API key, no authentication, or a provider account. After sign-in, select from models available to that account and API. Key-based connections use a Base URL, API key, and model name.

### Bookmark

1. Open the [installer](https://aitimos.github.io/pi-tab/), configure your model, and try it out.
2. Drag the **Pi Tab** button to your bookmarks bar.
3. Open a webpage, click the bookmark, and enter a task.

No extension is required. Configure the installer before saving the bookmark to carry all saved models and providers, including their keys and your current default selection, to other sites. Changes made on a webpage stay on that site and do not update existing bookmarks.

### Chrome extension

1. [Download the extension](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip) and extract it.
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the `pi-tab-extension` folder.
3. Click the Pi Tab toolbar icon on a webpage, configure a model, and start working.

| | Bookmark | Chrome extension |
| --- | --- | --- |
| Launch | Click the bookmark to inject it into the page | Click the browser toolbar icon |
| After a reload | Click again for a blank conversation, or to resume an unfinished task | Enabled tabs restore automatically; background tasks keep running |
| Conversations and settings | Instructions, models and providers are shared by origin (scheme, hostname and port), independently of conversations; concurrent tabs can keep separate conversation records | Conversations shared by exact hostname; model settings shared across websites |
| Collaboration | Multiple agents on the current page | Tasks across browser tabs |

Stop cancels the current conversation and its queued messages. In extension mode, closing the task’s tab also stops its tasks; reloading preserves them. Page actions already performed are not undone.

The two modes keep separate conversation records. Start from the extension icon for cross-tab tools; installing the extension does not add those tools to bookmark sessions.

## Before you start

- Inference uses your configured service. Page content and attachments needed for a task are sent to that API. Bookmarks may contain API keys; do not share bookmarks containing credentials.
- Page security policies may block bookmark execution or model connections. The extension supports ordinary HTTP/HTTPS webpages, not browser internal pages or other pages that prohibit injection.
- Conversations stay on your device, with no cloud sync. To update, save a new bookmark from the installer or replace and reload the extension files.

See the [user guide](docs/usage.en.md) for detailed controls, attachment formats, storage, and recovery behavior.

## Contribute

Report problems through [Issues](https://github.com/aitimos/pi-tab/issues) or send a pull request.

Thanks to the [LINUX DO](https://linux.do/) community for providing a space to exchange ideas and share projects.

Licensed under the [Apache License 2.0](LICENSE).

## Account sign-in

Uses Pi’s native OAuth login, token refresh, and provider implementations without a local service. Anthropic accepts an authorization code or full callback URL. OpenAI Codex (Pi’s legacy provider) offers pasted callback URLs or device codes; GitHub Copilot, Kimi Coding, Meta, and xAI use device authorization. Pi parses and validates pasted callbacks without a local callback server. Available models depend on account entitlements. Anthropic’s token endpoint currently rejects cross-origin requests from the installation site; use the extension to sign in. Pasting a callback URL does not remove that restriction.

The bookmark loads OAuth and Bedrock code from the installation site on demand and requires the page to allow those scripts and network requests. Bookmark credentials stay on the current origin and are never exported in bookmarks; sign in again on another site. Extension credentials stay in the extension and work across websites. Signing out deletes that provider’s credentials.
