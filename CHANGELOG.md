# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-06-13

### Changed
- **Plugin Rename**: Renamed the plugin from "Show Hidden Files" to **"Show Stuffs"**.
- **Description Update**: Updated plugin description to highlight local HTML image rendering capability.
- **Internal Refactoring**: Renamed internal classes and types to match the new plugin name.

## [1.3.0] - 2026-06-13

### Changed
- **Default Behavior**: "Show hidden files" and "Show all file types" are now enabled by default upon plugin activation.
- **Improved Reversion**: Display toggles are now fully reverted to their previous state when the plugin is deactivated.

## [1.2.0] - 2026-06-13

### Added
- **Picomatch Integration**: Switched to `picomatch` for robust, industry-standard glob matching.
- **Improved Exclusions**: Better support for directory-level exclusions (e.g. excluding `.git` now correctly hides all its children).
- **Default Exclusions**: Added `.trash` to the default ignored list.

### Changed
- **Performance Optimization**: Optimized path matching using a precompiled matcher, significantly reducing overhead during vault scans.
- **Dependency Cleanup**: Drastically reduced project footprint by removing 200+ redundant transient dependencies and modernizing the linting configuration.
- **Removed Migration Code**: Simplified internal settings loading by removing legacy migration logic.

## [1.1.0] - 2026-06-13

### Added
- **Nested Hidden Files Support**: Hidden files and folders inside subdirectories are now correctly discovered and shown.
- **Ignored Hidden Globs**: Support for glob patterns (e.g., `**/node_modules/*`, `.git/**`) to filter hidden files. One pattern per line.
- **Dynamic Config Ignoring**: The vault's configuration folder (e.g., `.obsidian`) is now part of the default ignored globs and can be unhidden by the user.
- **Recursive Scanning**: Improved startup discovery of hidden files deep in the vault structure.

### Changed
- **Consolidated Settings**: Replaced "Ignored Hidden Paths" with the more powerful "Ignored Hidden Globs" setting.
- Improved path normalization for better cross-platform compatibility.
- Settings tab UI updated with more descriptive labels and placeholder examples.

## [1.0.3] - 2026-04-15

### Fixed
- Passed full Obsidian ESLint audit for better code quality and security.
- Improved error handling in file discovery.
