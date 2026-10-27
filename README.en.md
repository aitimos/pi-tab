# Pi Tab

[简体中文](README.md) | English

**Run Pi Agent in your browser.**

Built on Pi Durable, Pi Tab brings an agent into the webpage you are browsing. Open it with a bookmark or Chrome extension to read the page, interact with elements, run JavaScript, and save conversations, without setting up a separate automation environment.

[Get started](https://aitimos.github.io/pi-tab/) | [Download extension](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip) | [Changelog](CHANGELOG.md)

## Highlights

- **Open with a click**: the bookmark contains the complete runtime and needs no extension or server deployment. A Chrome extension is also available.
- **Work directly on the page**: use page content and the DOM to analyze, click, fill forms, and debug JavaScript in your current browser context.
- **Keep your conversations**: history stays on your device and can be reopened. Pi Durable supports unfinished task recovery; extension background runs survive webpage reloads.
- **Choose your models**: add multiple providers and models, switch from the composer, and set thinking levels supported by each model.

## Features

| Feature | What you can do |
| --- | --- |
| Reading and extraction | Summarize pages, extract tables and lists, and organize data as JSON or CSV |
| Page interaction and debugging | Click, fill forms, inspect DOM and styles, and execute JavaScript |
| Files and images | Attach text and code files, drop files, or paste images with a vision-capable model |
| Follow-up messages | Add tasks while a reply is running, edit the queue, or send a message directly to steer the current task |
| Conversation management | Generate titles automatically, see running status, switch or delete conversations, and open another task in a new window |
| Agent collaboration | Exchange messages between agents on the same page; the extension can also open tabs, send tasks, and read results |
| Appearance and preferences | Follow the page or system theme, or choose light or dark; drag, resize, minimize, and dock windows at the edge |

Try: “Summarize this page,” “Turn this table into CSV,” or “Find out why this page scrolls horizontally.”

## Quick start

You need a model that supports tool calling, its Base URL, API key, and model name.

### Bookmark

1. Open the [installer](https://aitimos.github.io/pi-tab/), configure your model, and try it out.
2. Drag the **Pi Tab** button to your bookmarks bar.
3. Open a webpage, click the bookmark, and enter a task.

No extension is required. You can also save the bookmark first and configure it when you use it.

### Chrome extension

1. [Download the extension](https://github.com/aitimos/pi-tab/releases/latest/download/pi-tab-extension.zip) and extract it.
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the `pi-tab-extension` folder.
3. Click the Pi Tab toolbar icon on a webpage, configure a model, and start working.

| | Bookmark | Chrome extension |
| --- | --- | --- |
| Launch | Click the bookmark to inject it into the page | Click the browser toolbar icon |
| After a reload | Click again for a blank conversation, or to resume an unfinished task | Enabled tabs restore automatically; background tasks keep running |
| Conversations and settings | Stored within the webpage origin; concurrent tabs may use separate records | Conversations shared by exact hostname; model settings shared across websites |
| Collaboration | Multiple agents on the current page | Tasks across browser tabs |

The two modes keep separate conversation records. Start from the extension icon for cross-tab tools; installing the extension does not add those tools to bookmark sessions.

## Before you start

- Inference uses your configured service. Page content and attachments needed for a task are sent to that API. Bookmarks may contain API keys; do not share bookmarks containing credentials.
- Page security policies may block bookmark execution or model connections. The extension supports ordinary HTTP/HTTPS webpages, not browser internal pages or other pages that prohibit injection.
- Conversations stay on your device, with no cloud sync. To update, save a new bookmark from the installer or replace and reload the extension files.

See the [user guide](docs/usage.en.md) for detailed controls, attachment formats, storage, and recovery behavior.

## Contribute

[Issues and suggestions](https://github.com/aitimos/pi-tab/issues/new/choose) | [Development and contributing](CONTRIBUTING.md) | [Code of conduct](CODE_OF_CONDUCT.md) | [Security reports](SECURITY.md)

Licensed under the [Apache License 2.0](LICENSE).
