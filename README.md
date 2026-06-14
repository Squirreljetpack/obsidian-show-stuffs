# Show Hidden Files — Obsidian Plugin

Reveals hidden dotfiles (`.claude/`, `.gitignore`, `.env`, `.github/`, etc.) and all file types directly in the Obsidian file explorer.

## Features

- **Show all file types** — Exposes files with unsupported extensions (`.json`, `.yml`, `.toml`, etc.) in the file explorer. Synced with Obsidian's native "Detect all file extensions" setting.
- **Show hidden files** — Shows files and folders whose names start with a dot, including hidden files inside subdirectories and normal files inside hidden folders.
- **Ignored hidden globs** — Filter hidden files using glob patterns (e.g. `**/node_modules/*`, `.git/**`). Skip noisy or sensitive entries by exact name or pattern.

The display toggles are **enabled by default** when the plugin is activated and **fully reverted** when the plugin is disabled.

> **Note:** Enabling this plugin exposes sensitive dotfiles (`.env`, `.git-credentials`, etc.) in the Obsidian file explorer, making them viewable, editable, and deletable. Make sure you understand what these files are before modifying them.

## Installation

### From Community Plugins (not available)

1. Open **Settings → Community plugins → Browse**
2. Search for **Show Hidden Files**
3. Click **Install**, then **Enable**

### BRAT

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) with the repo URL:

```
Squirreljetpack/obsidian-show-hidden-files
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show all file types | On | Toggle unsupported file extensions in the explorer. Mirrors Obsidian's native "Detect all file extensions" option. |
| Show hidden files | On | Toggle dotfiles and dotfolders in the explorer, including nested hidden paths. `.trash` is always excluded. |
| Ignored hidden globs | `.git*`, `.hg`, `.svn`, `.DS_Store`, `.obsidian` | Filter hidden files using glob patterns (e.g. `**/node_modules/*`, `.git/**`). One pattern per line. Names without separators match any path segment. |

Examples for **Ignored hidden globs**:

```text
.git*
.DS_Store
.obsidian
**/node_modules/*
Research/.env
**/temp*
```

## Building from source

```bash
git clone https://github.com/Squirreljetpack/obsidian-show-hidden-files.git
cd obsidian-show-hidden-files
npm install
npm run build
```

This produces `main.js` in the project root. Copy it along with `manifest.json` into your vault's plugin folder to test.

For development with hot-reload:

```bash
npm run dev
```

## Acknowledgments

This plugin was originally created by [witi42](https://github.com/witi42/obsidian-show-hidden-files).

## How it works

- **Show all file types** uses Obsidian's internal `vault.setConfig('showUnsupportedFiles', …)` API to toggle the native setting programmatically.
- **Show hidden files** intercepts the vault adapter's `reconcileDeletion` method — when Obsidian tries to hide a dotfile, the plugin re-registers it instead. The plugin also scans the vault filesystem recursively so hidden paths inside subdirectories are discovered on startup.
- **Ignored hidden globs** are checked before registration. Ignored folders are not scanned, so large folders such as `.git` stay out of the file explorer.
- On disable, both settings are restored to their previous values and all revealed dotfiles are hidden again.

## Compatibility

- **Desktop only** — relies on Node.js filesystem APIs for dotfile discovery.
- Requires Obsidian **v0.15.0+**.

## License

[MIT](LICENSE)
