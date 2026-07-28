import {
	type App,
	MarkdownView,
	type Plugin,
	type TFile,
	type WorkspaceWindow,
} from "obsidian";
import { ImageZoomUtil, ModifierKey } from "./image-zoom-util.js";

/* ── Type augmentations for internal Obsidian APIs ─────────── */

declare module "obsidian" {
	interface MarkdownPreviewView {
		renderer?: {
			sections?: Array<{
				el?: HTMLElement;
				start?: { line?: number };
				lineStart?: number;
				line?: number;
			}>;
		};
	}
}

export interface MouseWheelZoomSettingsProvider {
	persistentZoomModifier: ModifierKey | "disabled";
	mouseWheelZoomStepSize: number;
}

/**
 * Lets the user zoom an image by scrolling over it while holding a modifier
 * key. Obsidian natively renders image width from `![alt|width](target)`
 * and `![[target|width]]` syntax, so this class doesn't track or reapply
 * widths in the DOM - it only gives instant visual feedback while
 * scrolling, then persists the new width to the note. Obsidian's own
 * re-render takes over from there.
 *
 * Set the modifier to `"disabled"` to skip registering the wheel listener.
 *
 * `WheelEvent` already carries the current modifier key state
 * (altKey/ctrlKey/shiftKey), so there's no need to separately track
 * keydown/keyup - checking the wheel event itself is sufficient, and it
 * naturally means scroll is only ever intercepted while the cursor is
 * directly over an <img>, on a tick-by-tick basis, rather than via a
 * persistent "scroll disabled" state.
 */
export class MouseWheelZoomManager {
	private plugin: Plugin;
	private app: App;
	private getSettings: () => MouseWheelZoomSettingsProvider;
	private pendingSaves = new Map<Element, number>();

	constructor(
		plugin: Plugin,
		getSettings: () => MouseWheelZoomSettingsProvider,
	) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.getSettings = getSettings;
	}

	public setup() {
		if (this.getSettings().persistentZoomModifier === "disabled") return;

		this.plugin.registerEvent(
			this.app.workspace.on("window-open", (newWindow: WorkspaceWindow) => {
				this.registerEvents(newWindow.win);
			}),
		);
		this.registerEvents(window);
	}

	public onunload() {
		this.clearAllPendingSaves();
	}

	private registerEvents(currentWindow: Window) {
		const doc = currentWindow.document;
		const settings = this.getSettings();

		this.plugin.registerDomEvent(
			doc,
			"wheel",
			(evt: WheelEvent) => {
				const target = evt.target as Element;
				if (!target || target.nodeName !== "IMG") return;

				const modifierPressed = this.isKeyDown(
					evt,
					settings.persistentZoomModifier as ModifierKey,
				);
				if (!modifierPressed) return;

				// Disable scroll zooming when the active view is in Editing Mode (Source / Live Preview)
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.getMode() === "source") return;

				// Only intercept scroll for this specific tick, over this specific
				// image - normal page/pane scrolling is untouched everywhere else.
				evt.preventDefault();
				this.handleZoom(evt, target as HTMLImageElement);
			},
			{ passive: false, capture: true },
		);
	}

	private isKeyDown(evt: WheelEvent, modifier: ModifierKey): boolean {
		switch (modifier) {
			case ModifierKey.ALT:
			case ModifierKey.ALT_RIGHT:
				return evt.altKey;
			case ModifierKey.CTRL:
			case ModifierKey.CTRL_RIGHT:
				return evt.ctrlKey;
			case ModifierKey.SHIFT:
			case ModifierKey.SHIFT_RIGHT:
				return evt.shiftKey;
			default:
				return false;
		}
	}

	private handleZoom(evt: WheelEvent, img: HTMLImageElement) {
		const settings = this.getSettings();
		const currentWidth = img.getBoundingClientRect().width || img.clientWidth;

		let newWidth = currentWidth;
		if (evt.deltaY < 0) {
			newWidth = Math.round(currentWidth + settings.mouseWheelZoomStepSize);
		} else if (
			evt.deltaY > 0 &&
			currentWidth > settings.mouseWheelZoomStepSize
		) {
			newWidth = Math.round(
				Math.max(20, currentWidth - settings.mouseWheelZoomStepSize),
			);
		}

		// Instant visual feedback while scrolling. Obsidian will take over
		// rendering the correct width once the saved markdown is re-parsed.
		img.style.setProperty("width", `${newWidth}px`, "important");

		this.scheduleSave(img, newWidth);
	}

	private scheduleSave(img: HTMLImageElement, width: number) {
		const existing = this.pendingSaves.get(img);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}

		const timeoutId = window.setTimeout(() => {
			this.pendingSaves.delete(img);
			void this.saveWidthToDisk(img, width);
		}, 300);
		this.pendingSaves.set(img, timeoutId);
	}

	private clearAllPendingSaves() {
		for (const timeoutId of this.pendingSaves.values()) {
			window.clearTimeout(timeoutId);
		}
		this.pendingSaves.clear();
	}

	private async saveWidthToDisk(img: HTMLImageElement, width: number) {
		const file = this.getActivePaneWithImage(img);
		if (!file) return;

		const rawImageName = ImageZoomUtil.getLocalImageNameFromUri(
			img.getAttribute("src") ?? "",
		);
		if (!rawImageName) return;

		let imageName = rawImageName;
		try {
			imageName = decodeURIComponent(rawImageName);
		} catch {
			// ignore
		}

		await this.app.vault.process(file, (text) => {
			const ordinal = this.getImageOrdinal(img, rawImageName, text);
			return this.setImageWidthInText(text, imageName, width, ordinal);
		});
	}

	/**
	 * Use renderer.sections (from the active MarkdownView's previewMode)
	 * to find the source line at which the target DOM section starts,
	 * then find the regex occurrence for this image whose byte offset
	 * in the source text corresponds to that line.
	 *
	 * This avoids ordinal counting (DOM position ≠ text position when
	 * split panes create duplicate DOM nodes for the same occurrence).
	 */
	private getImageOrdinal(
		img: HTMLImageElement,
		rawImageName: string,
		text: string,
	): number {
		const targetLine = this.getSectionLine(img);
		if (targetLine !== null) {
			return this.occurrenceIndexForLine(text, rawImageName, targetLine);
		}

		// Renderer sections unavailable (e.g. not in a MarkdownView
		// preview). Fall back to 0 and the caller's disambiguation
		// logic will pick the first occurrence — a safe default
		// since the user is always scrolling ON a specific image.
		return 0;
	}

	/**
	 * Return the source line covered by the preview section
	 * that contains `target`, using Obsidian's internal
	 * renderer.sections structure.
	 */
	private getSectionLine(target: HTMLElement): number | null {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			if (
				leaf.view instanceof MarkdownView &&
				leaf.view.containerEl.contains(target)
			) {
				const preview = leaf.view.previewMode;
				const sections = preview?.renderer?.sections;
				if (!Array.isArray(sections)) continue;
				for (const section of sections) {
					if (section?.el?.contains(target)) {
						return (
							section.start?.line ?? section.lineStart ?? section.line ?? null
						);
					}
				}
				break; // image belongs to one leaf only
			}
		}
		return null;
	}

	/**
	 * Find the index of the regex match (for this image in `text`)
	 * whose source position sits on or just before `targetLine`.
	 * This gives a reliable mapping from source position to
	 * occurrence index without relying on DOM image counts.
	 */
	private occurrenceIndexForLine(
		text: string,
		imageName: string,
		targetLine: number,
	): number {
		const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
		let match: RegExpExecArray | null;
		let bestIndex = 0;
		let bestLine = -1;
		let i = 0;

		while ((match = mdRegex.exec(text)) !== null) {
			const urlPath = match[2] ?? "";
			if (!urlPath || !this.referencesImage(urlPath, imageName)) {
				i++;
				continue;
			}

			const lineOfMatch = this.lineAtOffset(text, match.index);
			if (lineOfMatch <= targetLine && lineOfMatch > bestLine) {
				bestLine = lineOfMatch;
				bestIndex = i;
			}
			i++;
		}

		// Also check wiki-style embeds
		const wikiRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		while ((match = wikiRegex.exec(text)) !== null) {
			const target = match[1] ?? "";
			if (!target || !this.referencesImage(target, imageName)) {
				i++;
				continue;
			}

			const lineOfMatch = this.lineAtOffset(text, match.index);
			if (lineOfMatch <= targetLine && lineOfMatch > bestLine) {
				bestLine = lineOfMatch;
				bestIndex = i;
			}
			i++;
		}

		return bestIndex;
	}

	/**
	 * Return the 0-based line number for a byte offset in `text`.
	 */
	private lineAtOffset(text: string, offset: number): number {
		let line = 0;
		const end = Math.min(offset, text.length);
		for (let i = 0; i < end; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	/**
	 * Rewrites the width for the image reference at `ordinal`
	 * embeds `![[target|width]]`. Any existing size suffix is replaced; if
	 * none exists, one is appended.
	 */
	private setImageWidthInText(
		text: string,
		imageName: string,
		width: number,
		ordinal: number,
	): string {
		type Replacement = { start: number; end: number; text: string };
		const replacements: Replacement[] = [];

		const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
		let match: RegExpExecArray | null;
		while ((match = mdImageRegex.exec(text)) !== null) {
			const fullMatch = match[0];
			const altText = match[1] ?? "";
			const urlPath = match[2] ?? "";
			if (!urlPath || !this.referencesImage(urlPath, imageName)) continue;

			const pipeIndex = altText.indexOf("|");
			const baseAlt = pipeIndex === -1 ? altText : altText.slice(0, pipeIndex);
			const newAlt = baseAlt ? `${baseAlt}|${width}` : `${width}`;

			replacements.push({
				start: match.index,
				end: match.index + fullMatch.length,
				text: `![${newAlt}](${urlPath})`,
			});
		}

		const wikiImageRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		while ((match = wikiImageRegex.exec(text)) !== null) {
			const fullMatch = match[0];
			const target = match[1] ?? "";
			if (!target || !this.referencesImage(target, imageName)) continue;

			replacements.push({
				start: match.index,
				end: match.index + fullMatch.length,
				text: `![[${target}|${width}]]`,
			});
		}

		if (replacements.length === 0) return text;

		replacements.sort((a, b) => a.start - b.start);
		const index = ordinal >= 0 && ordinal < replacements.length ? ordinal : 0;
		const chosen = replacements[index];
		if (!chosen) return text;

		return text.slice(0, chosen.start) + chosen.text + text.slice(chosen.end);
	}

	private referencesImage(pathOrTarget: string, imageName: string): boolean {
		if (pathOrTarget.includes(imageName)) return true;
		try {
			return decodeURIComponent(pathOrTarget).includes(imageName);
		} catch {
			return false;
		}
	}

	private getActivePaneWithImage(imageElement: Element): TFile | null {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			if (
				leaf.view instanceof MarkdownView &&
				leaf.view.containerEl.contains(imageElement)
			) {
				return leaf.view.file;
			}
		}
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
	}
}
