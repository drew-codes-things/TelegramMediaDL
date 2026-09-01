<div align="center">

# Telegram Web Media Downloader

**A single-file browser userscript for Telegram Web (K) - download photos and videos one by one, in batches, or via a chat-wide scan-and-pick list, even in restricted "no-forwards" chats. Also re-enables copying text from protected messages.**

[![Tampermonkey](https://img.shields.io/badge/tampermonkey-compatible-00485B?style=flat-square)](https://www.tampermonkey.net/)
[![Violentmonkey](https://img.shields.io/badge/violentmonkey-compatible-6C4EB6?style=flat-square)](https://violentmonkey.github.io/)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

</div>

---

## Overview

`telegramDL_userscript.js` is a Tampermonkey/Violentmonkey userscript for [Telegram Web](https://web.telegram.org/). "Restrict saving / no-forwards" is a cosmetic UI flag - the media is already decrypted and present in the page, and the app's own download routine (`appDownloadManager.downloadToDisc()`) is still callable. The script hands it the in-memory media object directly, the same call the native download button makes, so files stream through the Service Worker (large files included) with correct names. WebK exposes the page-global managers this relies on; WebA does not, so the script redirects there automatically, preserving the open chat.

## Features

| Feature | Description |
|---|---|
| **Single Download** | Adds a "Download" item to the right-click context menu on any media bubble in a restricted chat |
| **Batch Download** | Adds a button to the selection bar - downloads every selected photo/video sequentially, which keeps large files (500 MB+) reliable |
| **Scan & Pick** | A floating "Scan" button finds every media message currently loaded in the chat, verifies each one resolves to real media, and shows a checklist (captions included, all checked by default) to download whatever you keep checked |
| **Copy Text** | Re-enables `Ctrl+C` / text selection inside restricted bubbles, which Telegram blocks by default |

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`telegramDL_userscript.js`](telegramDL_userscript.js) in this repo and click **Raw**.
3. Your userscript manager should prompt to install it automatically. If not, copy the file's contents into a new script in the manager's dashboard.
4. Visit [web.telegram.org](https://web.telegram.org/) - a restricted chat's bubbles will now have a right-click Download item, a selection-bar Download button, and a floating Scan button.

## Notes on downloads staying sequential

Batch and scan-and-pick downloads run one file at a time on purpose. Firing several `downloadToDisc()` calls at once doesn't produce real parallel transfers - Telegram's own download manager queues them internally - and concurrent Service-Worker hand-offs are what cause large files to fall back to an unreliable in-memory blob path.

## Disclaimer

This script bypasses Telegram's "restrict saving" / no-forwards UI flag. Using it may violate the terms of whatever chat, channel, or bot you use it in. It is provided for personal/educational use only, as-is, with no warranty. This project is not affiliated with or endorsed by Telegram.

## Get the Code

Clone with git:

```bash
git clone https://github.com/drew-codes-things/TelegramMediaDL.git
```

Or with the [GitHub CLI](https://cli.github.com/):

```bash
gh repo clone drew-codes-things/TelegramMediaDL
```

## License

MIT - made by [Drew](https://github.com/drew-codes-things)

---
