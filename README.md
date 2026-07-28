# Show Stuffs — Obsidian Plugin

Reveals hidden dotfiles (`.claude/`, `.gitignore`, `.env`, `.github/`, etc.), all file types, renders local HTML images, and opens specific plain text files directly in Obsidian.

## Features

- **Show all file types** — Exposes files with unsupported extensions (`.json`, `.yml`, `.toml`, etc.) in the file explorer. Synced with Obsidian's native "Detect all file extensions" setting.
- **Show hidden files** — Shows files and folders whose names start with a dot, including hidden files inside subdirectories and normal files inside hidden folders.
- **Ignored hidden globs** — Filter hidden files using glob patterns (e.g. `**/node_modules/*`, `.git/`). Children of skipped paths are also skipped.
- **Render local HTML images** — Resolves and displays local images used in HTML `<img>` tags. Useful for viewing images stored in hidden folders or non-standard paths.
- **Open as plain text** — Right click to open plain text files directly in Obsidian.
- **Mousewheel image zoom** — Resize images dynamically by scrolling over them while holding a modifier key. Set the modifier to "Disabled" to skip the scroll listener.
- **Image popup** — Click an image to open it in a fullscreen popup with a dimmed background. Navigate between images with left/right arrow keys. Scroll to zoom at cursor, click-drag to pan. Includes display area sizing, upscale control, background opacity, and configurable borders.

> **Note:** Enabling this plugin exposes sensitive dotfiles (`.env`, `.git-credentials`, etc.) in the Obsidian file explorer, making them viewable, editable, and deletable. Make sure you understand what these files are before modifying them.

## Installation

### From Community Plugins (not available)

1. Open **Settings → Community plugins → Browse**
2. Search for **Show Stuffs**
3. Click **Install**, then **Enable**

### BRAT

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) with the repo URL:

```
Squirreljetpack/obsidian-show-stuffs
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show all file types | **On** | Toggle unsupported file extensions in the explorer. Mirrors Obsidian's native "Detect all file extensions" option. |
| Show hidden files | **On** | Toggle dotfiles and dotfolders in the explorer, including nested hidden paths. |
| Ignored hidden globs | `/.git*`, `.hg`, `.svn`, `.DS_Store`, `/.trash`, `.obsidian` | Filter hidden files using glob patterns (e.g. `**/node_modules/*`, `.git/**`). One pattern per line. Names without separators match any path segment. |
| Open as plain text | `txt`, `log`, `conf` | File extensions to open directly in Obsidian as plain text (no formatting/highlighting). Comma- or newline-separated. Requires disabling and re-enabling this plugin to apply changes. |
| Render local HTML images | Off | Resolve and display local images in HTML `<img>` tags. |
| Persistent zoom modifier | Alt | Modifier key to hold while scrolling over an image to resize and persist the change. Set to "Disabled" to skip the scroll listener. |
| Popup click modifier | None | Modifier key to hold while clicking an image to open it in a popup viewer. "None" means clicking without any modifier opens the popup. "Disabled" means the click listener is not registered. |
| Popup display width | 90% | Display area width as a percentage of the viewport. |
| Popup max width | 0 (uncapped) | Maximum display area width in pixels. 0 means uncapped. |
| Popup display height | 90% | Display area height as a percentage of the viewport. |
| Popup max height | 0 (uncapped) | Maximum display area height in pixels. 0 means uncapped. |
| Upscale image | On | If enabled, images smaller than the display area are scaled up until they hit the display area limit. |
| Outer border width | 2 | Width of the outer border layer in pixels. |
| Border width | 3 | Width of the middle border layer in pixels. 0 to disable. |
| Inner border width | 2 | Width of the inner border layer in pixels. |
| Outer border color | `#10082D` | Hex color for the outer and inner border layers. |
| Border color | `#BFBAB5` | Hex color for the middle border layer. Replaces the white border. |
| Background opacity | 50% | Opacity of the dimmed background behind the popup image. |
| Zoom step size | 10 | Step value by which the size of the image should be increased or decreased. |

Examples for **Ignored hidden globs**:

```text
.git*
.DS_Store
.obsidian
.trash
**/node_modules/*
Research/.env
**/temp*
```

## Building from source

```bash
git clone https://github.com/Squirreljetpack/obsidian-show-stuffs.git
cd obsidian-show-stuffs
npm install
npm run build
```

This produces `main.js` in the project root. Copy it along with `manifest.json` into your vault's plugin folder to test.

For development with hot-reload:

```bash
npm run dev
```

## Acknowledgments

- This plugin was originally created by [witi42](https://github.com/witi42/obsidian-show-hidden-files).
- Local HTML image rendering logic is based on [lcl-obsidian-html-local-img-plugin](https://github.com/csdjk/lcl-obsidian-html-local-img-plugin) by [csdjk](https://github.com/csdjk).

## How it works

- **Show all file types** uses Obsidian's internal `vault.setConfig('showUnsupportedFiles', …)` API to toggle the native setting programmatically.
- **Show hidden files** intercepts the vault adapter's `reconcileDeletion` method — when Obsidian tries to hide a dotfile, the plugin re-registers it instead. The plugin also scans the vault filesystem recursively so hidden paths inside subdirectories are discovered on startup.
- **Ignored hidden globs** are checked before registration. Ignored folders are not scanned, so large folders such as `.git` stay out of the file explorer.
- **Render local HTML images** uses a markdown post-processor and an editor extension to intercept `<img>` tags, resolving their `src` paths to internal Obsidian resource URLs.
- On disable, both settings are restored to their previous values and all revealed dotfiles are hidden again.

## Compatibility

- **Desktop only** — relies on Node.js filesystem APIs for dotfile discovery.
- Requires Obsidian **v0.15.0+**.

## License

[MIT](LICENSE)
