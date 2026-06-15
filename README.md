# Show Stuffs — Obsidian Plugin

Reveals hidden dotfiles (`.claude/`, `.gitignore`, `.env`, `.github/`, etc.), all file types, and renders local HTML images directly in Obsidian.

## Features

- **Show all file types** — Exposes files with unsupported extensions (`.json`, `.yml`, `.toml`, etc.) in the file explorer. Synced with Obsidian's native "Detect all file extensions" setting.
- **Show hidden files** — Shows files and folders whose names start with a dot, including hidden files inside subdirectories and normal files inside hidden folders.
- **Ignored hidden globs** — Filter hidden files using glob patterns (e.g. `**/node_modules/*`, `.git/`). Children of skipped paths are also skipped.
- **Render local HTML images** — Resolves and displays local images used in HTML `<img>` tags. Useful for viewing images stored in hidden folders or non-standard paths.

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
| Render local HTML images | Off | Resolve and display local images in HTML `<img>` tags. |

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
