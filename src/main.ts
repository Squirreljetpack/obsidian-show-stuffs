import { lstat, readdir } from "fs/promises";
import type { Dirent } from "fs";
import { Plugin, PluginSettingTab, Setting, App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { EditorView, ViewUpdate, ViewPlugin, PluginValue } from "@codemirror/view";
import picomatch from "picomatch";

/* ── Type augmentations for internal Obsidian APIs ─────────── */

declare module "obsidian" {
	interface Vault {
		getConfig(key: string): unknown;
		setConfig(key: string, value: unknown): void;
	}
}

/** Internal adapter methods that exist at runtime but aren't typed. */
interface PrivateAdapter {
	_exists(fullPath: string, path: string): Promise<boolean>;
	getFullPath(path: string): string;
	getFullRealPath(realPath: string): string;
	getRealPath(path: string): string;
	listRecursive(path: string): Promise<void>;
	reconcileDeletion(realPath: string, path: string): Promise<void>;
	reconcileFileInternal?(realPath: string, path: string): Promise<void>;
	reconcileFolderCreation(realPath: string, path: string): Promise<void>;
}

/* ── Utilities ─────────────────────────────────────────────── */

function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitVaultPath(path: string): string[] {
	const normalizedPath = normalizeVaultPath(path);
	return normalizedPath ? normalizedPath.split("/") : [];
}

function parseMultilineSetting(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((v) => v.trim())
		.filter((v) => v.length > 0 && !v.startsWith("#"));
}

/** Check if any segment of a path is a dotfile/dotfolder (excluding vault config dir and .trash). */
function isHiddenPath(path: string): boolean {
	// A path is considered hidden if any of its segments start with a dot.
	// We use a regex to avoid redundant path splitting.
	return /(?:^|\/)\.[^/]/.test(path);
}

/**
 * Efficiently matches paths against a set of glob patterns using picomatch.
 */
class ExclusionMatcher {
	private matcher: (path: string) => boolean;

	constructor(globs: string[]) {
		// Transform globs to handle both exact matches and child paths
		const transformedGlobs = globs.flatMap((glob) => {
			const isAnchored =
			  glob.startsWith("/") ||
			  glob.startsWith("\\") ||
			  glob.slice(0, -1).includes("/") ||
			  glob.slice(0, -1).includes("\\");
			  
			// "support" windows style paths
			const pattern = normalizeVaultPath(glob).trim();
			if (!pattern) return [];
			
			const base = isAnchored ? pattern : `**/${pattern}`;
			// Match the path itself and any children
			return [base, `${base}/**`];
		});

		this.matcher = picomatch(transformedGlobs, {
			dot: true,
			nocase: true,
		});
	}

	public matches(path: string): boolean {
		return this.matcher(path);
	}
}

/* ── Settings ──────────────────────────────────────────────── */

interface ShowStuffsSettings {
	showAllFileTypes: boolean;
	showHiddenFiles: boolean;
	ignoredHiddenGlobs: string;
	renderHtmlImages: boolean;
}

const DEFAULT_SETTINGS: ShowStuffsSettings = {
	showAllFileTypes: true,
	showHiddenFiles: true,
	ignoredHiddenGlobs: "",
	renderHtmlImages: false,
};

/* ── Live Preview Plugin ────────────────────────────────────── */

class HtmlImagePluginValue implements PluginValue {
	constructor(private view: EditorView, private plugin: ShowStuffsPlugin) {
		this.updateImages();
	}

	update(update: ViewUpdate) {
		if (update.docChanged) {
			this.updateImages();
		}
	}

	private updateImages() {
		if (!this.plugin.settings.renderHtmlImages) return;
		const activeFile = this.plugin.app.workspace.getActiveFile();
		if (activeFile) {
			this.plugin.processHtmlImages(this.view.dom, activeFile.path);
		}
	}
}

/* ── Plugin ────────────────────────────────────────────────── */

export default class ShowStuffsPlugin extends Plugin {
	settings!: ShowStuffsSettings;
	private matcher!: ExclusionMatcher;
	private previousShowUnsupportedFiles = false;
	private originalReconcileDeletion:
		| PrivateAdapter["reconcileDeletion"]
		| null = null;
	private originalI18nT: ((...args: unknown[]) => string) | null = null;
	private hiddenPaths = new Set<string>();
	private hiddenFilesRefreshTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		this.previousShowUnsupportedFiles =
			(this.app.vault.getConfig("showUnsupportedFiles") as boolean) ??
			false;

		if (this.settings.showAllFileTypes) {
			this.applyShowAllFileTypes();
		}

		this.app.workspace.onLayoutReady(async () => {
			this.updateMatcher();
			if (this.settings.showHiddenFiles) {
				this.patchAdapter();
				this.suppressDotfileWarning();
				await this.refreshHiddenFiles();
			}
		});

		this.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
			if (this.settings.renderHtmlImages) {
				this.processHtmlImages(element, context.sourcePath);
			}
		});

		this.registerEditorExtension(
			ViewPlugin.define((view) => new HtmlImagePluginValue(view, this))
		);

		this.addSettingTab(new ShowStuffsSettingTab(this.app, this));
	}

	onunload() {
		this.clearHiddenFilesRefreshTimer();
		void this.restoreAdapter();
		this.restoreDotfileWarning();
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.previousShowUnsupportedFiles,
		);
	}

	/* ── html image rendering ──────────────────────────────── */

	/**
	 * Logic inspired by lcl-obsidian-html-local-img-plugin
	 * @see https://github.com/csdjk/lcl-obsidian-html-local-img-plugin
	 */
	processHtmlImages(element: HTMLElement, sourcePath: string) {
		const targetLinks = Array.from(element.getElementsByTagName("img"));
		for (const link of targetLinks) {
			if (!link.src || link.src.startsWith("http") || link.src.startsWith("data:")) {
				continue;
			}

			// Obsidian internal protocol cleaning
			const cleanLink = link.src
				.replace("app://obsidian.md/", "")
				.replace("capacitor://localhost/", "");

			const imageFile = this.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(cleanLink), sourcePath);
			if (imageFile instanceof TFile) {
				const activePath = this.app.vault.getResourcePath(imageFile);
				link.src = activePath;
			}
		}
	}

	/* ── settings persistence ──────────────────────────────── */

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<ShowStuffsSettings> | null;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});

		if (!this.settings.ignoredHiddenGlobs && !loaded?.ignoredHiddenGlobs) {
			this.settings.ignoredHiddenGlobs = [
				"/.git*",
				".hg",
				".svn",
				".DS_Store",
				"/.trash",
				this.app.vault.configDir,
			].join("\n");
		}

		this.updateMatcher();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	public updateMatcher() {
		this.matcher = new ExclusionMatcher(
			parseMultilineSetting(this.settings.ignoredHiddenGlobs),
		);
	}

	/* ── show all file types ───────────────────────────────── */

	applyShowAllFileTypes() {
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.settings.showAllFileTypes,
		);
	}

	/* ── show hidden files — adapter monkey-patch ──────────── */

	private adapter(): PrivateAdapter {
		return this.app.vault.adapter as unknown as PrivateAdapter;
	}

	private shouldSkipPath(path: string): boolean {
		// Expects already normalized path
		return this.matcher.matches(path);
	}

	private shouldRevealHiddenPath(path: string): boolean {
		// Expects already normalized path
		return isHiddenPath(path) && !this.shouldSkipPath(path);
	}

	private patchAdapter() {
		const adapter = this.adapter();

		if (this.originalReconcileDeletion) return; // already patched
		this.originalReconcileDeletion =
			adapter.reconcileDeletion.bind(adapter);

		const origReconcileDeletion = this.originalReconcileDeletion;

		adapter.reconcileDeletion = async (realPath: string, path: string) => {
			const normalizedPath = normalizeVaultPath(path);
			if (
				this.settings.showHiddenFiles &&
				this.shouldRevealHiddenPath(normalizedPath)
			) {
				// File exists on disk — re-register it instead of deleting
				const fullPath = adapter.getFullPath(normalizedPath);
				if (await adapter._exists(fullPath, normalizedPath)) {
					await this.showPath(normalizedPath);
					return;
				}
				this.hiddenPaths.delete(normalizedPath);
			}
			return origReconcileDeletion(realPath, path);
		};
	}

	private async restoreAdapter(): Promise<void> {
		if (this.originalReconcileDeletion) {
			const adapter = this.adapter();
			adapter.reconcileDeletion = this.originalReconcileDeletion;
			this.originalReconcileDeletion = null;

			// Hide all files we previously revealed
			for (const path of this.trackedHiddenPathsByDepthDesc()) {
				await adapter.reconcileDeletion(adapter.getRealPath(path), path);
			}
			this.hiddenPaths.clear();
		}
	}

	/** Re-register a dotfile/dotfolder with the vault. */
	private async showPath(path: string, isFolder?: boolean): Promise<void> {
		const normalizedPath = normalizeVaultPath(path);
		if (!this.shouldRevealHiddenPath(normalizedPath)) return;

		const adapter = this.adapter();
		const realPath = adapter.getRealPath(normalizedPath);
		const shouldCreateFolder =
			isFolder ?? (await this.pathIsDirectory(normalizedPath));

		if (shouldCreateFolder) {
			await adapter.reconcileFolderCreation(realPath, normalizedPath);
			this.hiddenPaths.add(normalizedPath);
			return;
		}

		if (!adapter.reconcileFileInternal) return;

		await adapter.reconcileFileInternal(realPath, normalizedPath);
		this.hiddenPaths.add(normalizedPath);
	}

	/** Hide a previously shown dotfile. */
	private async hideFile(path: string): Promise<void> {
		const normalizedPath = normalizeVaultPath(path);
		const adapter = this.adapter();
		if (this.originalReconcileDeletion) {
			await this.originalReconcileDeletion(
				adapter.getRealPath(normalizedPath),
				normalizedPath,
			);
		}
	}

	private async pathIsDirectory(path: string): Promise<boolean> {
		try {
			const stat = await lstat(this.adapter().getFullPath(path));
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	private trackedHiddenPathsByDepthDesc(): string[] {
		return Array.from(this.hiddenPaths).sort(
			(left, right) =>
				splitVaultPath(right).length - splitVaultPath(left).length,
		);
	}

	private async hideSkippedTrackedPaths(): Promise<void> {
		for (const path of this.trackedHiddenPathsByDepthDesc()) {
			if (!this.shouldRevealHiddenPath(path)) {
				await this.hideFile(path);
				this.hiddenPaths.delete(path);
			}
		}
	}

	private async revealHiddenPathsFromDisk(folderPath: string): Promise<void> {
		let entries: Dirent[];

		try {
			entries = await readdir(this.adapter().getFullPath(folderPath), {
				withFileTypes: true,
			});
		} catch {
			return;
		}

		for (const entry of entries) {
			const path = normalizeVaultPath(
				folderPath ? `${folderPath}/${entry.name}` : entry.name,
			);

			if (!path || this.shouldSkipPath(path)) continue;

			const isDirectory = entry.isDirectory();

			if (this.shouldRevealHiddenPath(path)) {
				await this.showPath(path, isDirectory);
			}

			if (isDirectory) {
				await this.revealHiddenPathsFromDisk(path);
			}
		}
	}

	/** Trigger a full vault refresh and directly discover nested hidden paths. */
	private async refreshHiddenFiles(): Promise<void> {
		await this.hideSkippedTrackedPaths();
		await this.adapter().listRecursive("");
		await this.revealHiddenPathsFromDisk("");
		await this.hideSkippedTrackedPaths();
	}

	/** Enable hidden files — patch + rescan. */
	async enableHiddenFiles(): Promise<void> {
		this.patchAdapter();
		this.suppressDotfileWarning();
		await this.refreshHiddenFiles();
	}

	/** Disable hidden files — hide all revealed files + restore. */
	async disableHiddenFiles(): Promise<void> {
		this.clearHiddenFilesRefreshTimer();
		// Hide all currently visible dotfiles before restoring
		for (const path of this.trackedHiddenPathsByDepthDesc()) {
			await this.hideFile(path);
		}
		this.hiddenPaths.clear();
		await this.restoreAdapter();
		this.restoreDotfileWarning();
	}

	scheduleHiddenFilesRefresh(): void {
		if (!this.settings.showHiddenFiles) return;

		this.clearHiddenFilesRefreshTimer();
		this.hiddenFilesRefreshTimer = window.setTimeout(() => {
			this.hiddenFilesRefreshTimer = null;
			void this.refreshHiddenFiles();
		}, 500);
	}

	private clearHiddenFilesRefreshTimer(): void {
		if (this.hiddenFilesRefreshTimer === null) return;

		window.clearTimeout(this.hiddenFilesRefreshTimer);
		this.hiddenFilesRefreshTimer = null;
	}

	/* ── suppress the "bad dotfile" warning ────────────────── */

	private suppressDotfileWarning() {
		const win = window as unknown as {
			i18next?: { t: (...args: unknown[]) => string };
		};
		if (!win.i18next || this.originalI18nT) return;

		this.originalI18nT = win.i18next.t.bind(win.i18next);
		const origT = this.originalI18nT;

		win.i18next.t = function (...args: unknown[]): string {
			if (args[0] === "plugins.file-explorer.msg-bad-dotfile") {
				return "";
			}
			return origT(...args);
		};
	}

	private restoreDotfileWarning() {
		if (this.originalI18nT) {
			const win = window as unknown as {
				i18next?: { t: (...args: unknown[]) => string };
			};
			if (win.i18next) {
				win.i18next.t = this.originalI18nT;
			}
			this.originalI18nT = null;
		}
	}
}

/* ── Settings tab ──────────────────────────────────────────── */

class ShowStuffsSettingTab extends PluginSettingTab {
	plugin: ShowStuffsPlugin;

	constructor(app: App, plugin: ShowStuffsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Show all file types")
			.setDesc(
				"Show files with unsupported extensions in the file explorer. " +
					'Synced with Obsidian\'s native "Detect all file extensions" setting.',
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showAllFileTypes).onChange(async (value) => {
					this.plugin.settings.showAllFileTypes = value;
					await this.plugin.saveSettings();
					this.plugin.applyShowAllFileTypes();
				});
			});

		new Setting(containerEl)
			.setName("Show hidden files")
			.setDesc(
				"Show files and folders whose names start with a dot, including nested hidden paths.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHiddenFiles)
					.onChange(async (value) => {
						this.plugin.settings.showHiddenFiles = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.enableHiddenFiles();
						} else {
							await this.plugin.disableHiddenFiles();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Ignored hidden globs")
			.setDesc(
				"Filter hidden files using glob patterns (e.g. **/node_modules/*, .git/**). One pattern per line. Names without separators match any path segment.",
			)
			.addTextArea((text) => {
				text.setPlaceholder(
					`.git*\n.DS_Store\n${this.app.vault.configDir}\n**/node_modules/*`,
				)
					.setValue(this.plugin.settings.ignoredHiddenGlobs)
					.onChange(async (value) => {
						this.plugin.settings.ignoredHiddenGlobs = value;
						await this.plugin.saveSettings();
						this.plugin.updateMatcher();
						this.plugin.scheduleHiddenFilesRefresh();
					});
				text.inputEl.rows = 6;
			});

		containerEl.createEl("h3", { text: "Experimental" });

		new Setting(containerEl)
			.setName("Render local HTML images")
			.setDesc(
				"Attempt to resolve and display local images used in HTML <img> tags. Useful for viewing images in hidden folders or non-standard paths.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.renderHtmlImages)
					.onChange(async (value) => {
						this.plugin.settings.renderHtmlImages = value;
						await this.plugin.saveSettings();
						// Refresh active view if possible
						this.app.workspace.requestSaveLayout();
					})
			);
	}
}
