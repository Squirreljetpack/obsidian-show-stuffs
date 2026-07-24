import { lstat, readdir } from "fs/promises";
import type { Dirent } from "fs";
import { Plugin, PluginSettingTab, Setting, App, TFile, MarkdownPostProcessorContext, TextFileView, WorkspaceLeaf } from "obsidian";
import { EditorView, ViewUpdate, ViewPlugin, PluginValue, keymap, drawSelection, highlightActiveLine, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, openSearchPanel, closeSearchPanel, searchKeymap } from "@codemirror/search";
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
	plainTextExtensions: string;
}

const DEFAULT_SETTINGS: ShowStuffsSettings = {
	showAllFileTypes: true,
	showHiddenFiles: true,
	ignoredHiddenGlobs: "",
	renderHtmlImages: false,
	plainTextExtensions: "txt, log, conf",
};

export const VIEW_TYPE_PLAIN_TEXT = "plain-text-view";

class PlainTextView extends TextFileView {
	editorView!: EditorView;
	lineNumbersCompartment = new Compartment();
	showLineNumbers = true;
	lineWrappingCompartment = new Compartment();
	showLineWrapping = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_PLAIN_TEXT;
	}

	getIcon() {
		return "document";
	}

	async onOpen() {
		this.contentEl.empty();
		
		const container = this.contentEl.createDiv({ cls: "plain-text-container" });

		// 1. Build Editor Container
		const editorEl = container.createDiv({ cls: "plain-text-editor-element" });

		// 2. Initialize CodeMirror 6 EditorState
		const state = EditorState.create({
			doc: "",
			extensions: [
				this.lineNumbersCompartment.of(this.showLineNumbers ? lineNumbers() : []),
				this.lineWrappingCompartment.of(this.showLineWrapping ? EditorView.lineWrapping : []),
				highlightActiveLine(),
				drawSelection(),
				history(),
				search({ top: true }),
				keymap.of([
					...defaultKeymap,
					...historyKeymap,
					...searchKeymap,
				]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						this.requestSave();
					}
					// Dynamically append 'Line Numbers' and 'Line Wrap' toggle buttons to CodeMirror's native search bar
					const searchPanel = this.editorView?.dom?.querySelector(".cm-panel-search, .cm-search");
					if (searchPanel) {
						this.updateToggleButtons(searchPanel);
					}
				}),
				EditorView.theme({
					"&": {
						height: "100%",
						width: "100%",
					},
					".cm-scroller": {
						fontFamily: "var(--font-monospace)",
						fontSize: "var(--font-editor-size)",
						lineHeight: "var(--line-height-normal)",
					},
					"&.cm-focused": {
						outline: "none",
					}
				}),
			]
		});

		this.editorView = new EditorView({
			state,
			parent: editorEl,
		});

		// 3. Trigger Search Panel on Selection (mouseup for mouse drag, keyup for keyboard selection)
		const checkSelectionAndOpenSearch = () => {
			const state = this.editorView.state;
			const selection = state.selection.main;
			if (!selection.empty) {
				const selectedText = state.doc.sliceString(selection.from, selection.to);
				if (selectedText.trim().length > 0 && selectedText.indexOf("\n") === -1) {
					openSearchPanel(this.editorView);
				}
			}
		};

		this.editorView.contentDOM.addEventListener("mouseup", () => {
			setTimeout(checkSelectionAndOpenSearch, 10);
		});

		this.editorView.contentDOM.addEventListener("keyup", (e: KeyboardEvent) => {
			if (e.shiftKey) {
				setTimeout(checkSelectionAndOpenSearch, 10);
			}
		});
	}

	async onClose() {
		if (this.editorView) {
			this.editorView.destroy();
		}
		this.contentEl.empty();
	}

	getViewData() {
		return this.editorView ? this.editorView.state.doc.toString() : "";
	}

	setViewData(data: string, clear: boolean) {
		if (this.editorView) {
			const transaction = this.editorView.state.update({
				changes: { from: 0, to: this.editorView.state.doc.length, insert: data }
			});
			this.editorView.dispatch(transaction);
		}
	}

	clear() {
		if (this.editorView) {
			closeSearchPanel(this.editorView);
			const transaction = this.editorView.state.update({
				changes: { from: 0, to: this.editorView.state.doc.length, insert: "" }
			});
			this.editorView.dispatch(transaction);
		}
	}

	updateToggleButtons(searchPanel: Element) {
		let toggleBtn = searchPanel.querySelector(".plain-text-gutter-toggle") as HTMLButtonElement | null;
		if (!toggleBtn) {
			toggleBtn = document.createElement("button");
			toggleBtn.className = "cm-button plain-text-gutter-toggle";
			toggleBtn.innerText = "Line Numbers";
			toggleBtn.addEventListener("click", () => {
				this.toggleLineNumbers();
			});
			searchPanel.appendChild(toggleBtn);
		}
		toggleBtn.classList.toggle("is-active", this.showLineNumbers);

		let toggleWrapBtn = searchPanel.querySelector(".plain-text-wrap-toggle") as HTMLButtonElement | null;
		if (!toggleWrapBtn) {
			toggleWrapBtn = document.createElement("button");
			toggleWrapBtn.className = "cm-button plain-text-wrap-toggle";
			toggleWrapBtn.innerText = "Line Wrap";
			toggleWrapBtn.addEventListener("click", () => {
				this.toggleLineWrapping();
			});
			searchPanel.appendChild(toggleWrapBtn);
		}
		toggleWrapBtn.classList.toggle("is-active", this.showLineWrapping);
	}

	toggleLineNumbers() {
		this.showLineNumbers = !this.showLineNumbers;
		this.editorView.dispatch({
			effects: this.lineNumbersCompartment.reconfigure(this.showLineNumbers ? lineNumbers() : [])
		});
		const searchPanel = this.editorView?.dom?.querySelector(".cm-panel-search, .cm-search");
		if (searchPanel) {
			this.updateToggleButtons(searchPanel);
		}
	}

	toggleLineWrapping() {
		this.showLineWrapping = !this.showLineWrapping;
		this.editorView.dispatch({
			effects: this.lineWrappingCompartment.reconfigure(this.showLineWrapping ? EditorView.lineWrapping : [])
		});
		const searchPanel = this.editorView?.dom?.querySelector(".cm-panel-search, .cm-search");
		if (searchPanel) {
			this.updateToggleButtons(searchPanel);
		}
	}
}

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

		this.registerView(
			VIEW_TYPE_PLAIN_TEXT,
			(leaf) => new PlainTextView(leaf)
		);

		const plainTextExtensions = parseMultilineSetting(this.settings.plainTextExtensions);
		if (plainTextExtensions.length > 0) {
			this.registerExtensions(plainTextExtensions, VIEW_TYPE_PLAIN_TEXT);
		}

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile) {
					menu.addItem((item) => {
						item
							.setTitle("Open as plain text")
							.setIcon("document")
							.onClick(async () => {
								const leaf = this.app.workspace.getLeaf(true);
								await leaf.setViewState({
									type: VIEW_TYPE_PLAIN_TEXT,
									active: true,
									state: { file: file.path }
								});
							});
					});
				}
			})
		);

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

		new Setting(containerEl)
			.setName("Open as plain text")
			.setDesc(
				"File extensions to open directly in Obsidian as plain text (no formatting/highlighting). " +
					"Comma- or newline-separated. Requires disabling and re-enabling this plugin to apply changes.",
			)
			.addTextArea((text) => {
				text.setPlaceholder("txt, log, conf")
					.setValue(this.plugin.settings.plainTextExtensions)
					.onChange(async (value) => {
						this.plugin.settings.plainTextExtensions = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 3;
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
