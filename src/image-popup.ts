import { ModifierKey } from "./utils/image-zoom-util.js";

/**
 * ImagePopup — full-viewport image lightbox with dimmed background,
 * keyboard navigation, scroll-to-zoom at cursor, and click-drag pan.
 *
 * Collects all <img> elements from the active markdown preview and
 * lets the user navigate between them with left/right arrows.
 */

export interface PopupViewSettings {
	widthPercent: number;
	maxWidth: number;
	heightPercent: number;
	maxHeight: number;
	upscaleImage: boolean;
	borderOuterWidth: number;
	borderMiddleWidth: number;
	borderInnerWidth: number;
	borderOuterColor: string;
	borderMiddleColor: string;
	bgOpacity: number;
}

export class ImagePopup {
	private overlayEl: HTMLElement;
	private bgEl: HTMLElement;
	private wrapperEl: HTMLElement;
	private imgEl: HTMLImageElement;
	private navHintEl: HTMLElement;

	private images: string[];
	private currentIndex: number;
	private settings: PopupViewSettings;
	private onCloseCb: () => void;

	/* zoom / pan state */
	private scale = 1;
	private panX = 0;
	private panY = 0;

	/* track retries to prevent infinite error recursion */
	private errorRetryCount = 0;

	/* drag state */
	private isDragging = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragPanX = 0;
	private dragPanY = 0;

	/* image natural size */
	private naturalW = 0;
	private naturalH = 0;

	/* display area (computed on open) */
	private displayWidth = 0;
	private displayHeight = 0;

	/** Bound handlers so we can remove them on close. */
	private boundKeyDown: (e: KeyboardEvent) => void;
	private boundWheel: (e: WheelEvent) => void;
	private boundMouseDown: (e: MouseEvent) => void;
	private boundMouseMove: (e: MouseEvent) => void;
	private boundMouseUp: (e: MouseEvent) => void;
	private boundBgClick: (e: MouseEvent) => void;

	constructor(
		images: string[],
		startIndex: number,
		settings: PopupViewSettings,
		onClose: () => void,
	) {
		this.images = images;
		this.currentIndex = Math.max(0, Math.min(startIndex, images.length - 1));
		this.settings = settings;
		this.onCloseCb = onClose;

		this.boundKeyDown = this.onKeyDown.bind(this);
		this.boundWheel = this.onWheel.bind(this);
		this.boundMouseDown = this.onMouseDown.bind(this);
		this.boundMouseMove = this.onMouseMove.bind(this);
		this.boundMouseUp = this.onMouseUp.bind(this);
		this.boundBgClick = this.onBgClick.bind(this);

		this.buildDOM();
	}

	/* ── public API ────────────────────────────────── */

	open() {
		// Validate images before proceeding
		const src = this.images[this.currentIndex];
		if (!src) {
			this.overlayEl.remove();
			this.onCloseCb();
			return;
		}
		document.body.appendChild(this.overlayEl);
		this.computeDisplayArea();
		this.listen(true);
		this.loadCurrentImage();
	}

	close() {
		this.listen(false);
		this.overlayEl.remove();
		this.onCloseCb();
	}

	/* ── DOM construction ──────────────────────────── */

	private buildDOM() {
		this.overlayEl = document.createElement("div");
		this.overlayEl.className = "show-stuffs-popup";
		Object.assign(this.overlayEl.style, {
			position: "fixed",
			inset: "0",
			zIndex: "999999",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			pointerEvents: "none",
		});

		this.bgEl = document.createElement("div");
		this.bgEl.className = "show-stuffs-popup-bg";
		Object.assign(this.bgEl.style, {
			position: "absolute",
			inset: "0",
			background: `rgba(0,0,0,${this.settings.bgOpacity / 100})`,
			cursor: "pointer",
			pointerEvents: "auto",
		});
		this.bgEl.addEventListener("click", this.boundBgClick);
		this.overlayEl.appendChild(this.bgEl);

		this.imgEl = document.createElement("img");
		this.imgEl.className = "show-stuffs-popup-img";
		Object.assign(this.imgEl.style, {
			display: "block",
			pointerEvents: "none",
		});

		this.wrapperEl = document.createElement("div");
		this.wrapperEl.className = "show-stuffs-popup-wrapper";
		this.wrapperEl.style.cssText = `
			position: relative;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
			pointer-events: auto;
			cursor: grab;
			user-select: none;
			transform-origin: 0 0;
		`;

		const hasOuterBlack = this.settings.borderOuterWidth > 0;
		const hasMiddleWhite = this.settings.borderMiddleWidth > 0;
		const hasInnerBlack = this.settings.borderInnerWidth > 0;

		// Structure: wrapperEl > outerBlack div > middleWhite div > innerBlack div > imgEl
		// Layers from outside to inside: black → white → black
		// Each layer is border-box so borders expand inward.

		if (hasOuterBlack || hasMiddleWhite || hasInnerBlack) {
			const outerBlack = document.createElement("div");
			outerBlack.className = "show-stuffs-popup-outer-black";
			outerBlack.style.boxSizing = "border-box";
			outerBlack.style.border = `${this.settings.borderOuterWidth}px solid ${this.settings.borderOuterColor}`;
			outerBlack.style.display = "flex";
			outerBlack.style.alignItems = "center";
			outerBlack.style.justifyContent = "center";

			if (hasMiddleWhite) {
				const middleWhite = document.createElement("div");
				middleWhite.className = "show-stuffs-popup-middle-white";
				middleWhite.style.boxSizing = "border-box";
				middleWhite.style.border = `${this.settings.borderMiddleWidth}px solid ${this.settings.borderMiddleColor}`;
				middleWhite.style.display = "flex";
				middleWhite.style.alignItems = "center";
				middleWhite.style.justifyContent = "center";

				if (hasInnerBlack) {
					const innerBlack = document.createElement("div");
					innerBlack.className = "show-stuffs-popup-inner-black";
					innerBlack.style.boxSizing = "border-box";
					innerBlack.style.border = `${this.settings.borderInnerWidth}px solid ${this.settings.borderOuterColor}`;
					innerBlack.appendChild(this.imgEl);
					middleWhite.appendChild(innerBlack);
				} else {
					middleWhite.appendChild(this.imgEl);
				}

				outerBlack.appendChild(middleWhite);
			} else if (hasInnerBlack) {
				const innerBlack = document.createElement("div");
				innerBlack.className = "show-stuffs-popup-inner-black";
				innerBlack.style.boxSizing = "border-box";
				innerBlack.style.border = `${this.settings.borderInnerWidth}px solid ${this.settings.borderOuterColor}`;
				innerBlack.appendChild(this.imgEl);
				outerBlack.appendChild(innerBlack);
			} else {
				outerBlack.appendChild(this.imgEl);
			}

			this.wrapperEl.appendChild(outerBlack);
		} else {
			this.wrapperEl.appendChild(this.imgEl);
		}
		this.overlayEl.appendChild(this.wrapperEl);

		this.navHintEl = document.createElement("div");
		this.navHintEl.className = "show-stuffs-popup-nav-hint";
		Object.assign(this.navHintEl.style, {
			position: "absolute",
			bottom: "24px",
			left: "50%",
			transform: "translateX(-50%)",
			color: "#ccc",
			fontSize: "13px",
			fontFamily: "sans-serif",
			background: "rgba(0,0,0,0.5)",
			padding: "4px 12px",
			borderRadius: "4px",
			pointerEvents: "none",
			opacity: "0.7",
		});
		this.overlayEl.appendChild(this.navHintEl);

		this.updateNavHint();
	}

	private listen(attach: boolean) {
		const op = attach ? "addEventListener" : "removeEventListener";
		document[op]("keydown", this.boundKeyDown);
		this.wrapperEl[op]("wheel", this.boundWheel, {
			passive: false,
		} as AddEventListenerOptions);
		this.wrapperEl[op]("mousedown", this.boundMouseDown);
		document[op]("mousemove", this.boundMouseMove);
		document[op]("mouseup", this.boundMouseUp);
	}

	/* ── display area calculation ──────────────────── */

	private computeDisplayArea() {
		const vpw = window.innerWidth;
		const vph = window.innerHeight;

		this.displayWidth = vpw * (this.settings.widthPercent / 100);
		if (
			this.settings.maxWidth > 0 &&
			this.displayWidth > this.settings.maxWidth
		) {
			this.displayWidth = this.settings.maxWidth;
		}

		this.displayHeight = vph * (this.settings.heightPercent / 100);
		if (
			this.settings.maxHeight > 0 &&
			this.displayHeight > this.settings.maxHeight
		) {
			this.displayHeight = this.settings.maxHeight;
		}
	}

	private fitSize(
		naturalW: number,
		naturalH: number,
	): { w: number; h: number } {
		const scale = Math.min(
			this.displayWidth / naturalW,
			this.displayHeight / naturalH,
		);
		let finalScale = scale;
		if (!this.settings.upscaleImage && finalScale > 1) {
			finalScale = 1;
		}
		return { w: naturalW * finalScale, h: naturalH * finalScale };
	}

	/* ── image loading & navigation ────────────────── */

	private loadCurrentImage() {
		const src = this.images[this.currentIndex];
		if (!src) {
			// All images were tried and none loaded
			this.close();
			return;
		}

		// Reset zoom/pan for new image
		this.scale = 1;
		this.panX = 0;
		this.panY = 0;
		this.errorRetryCount = 0;

		const tempImg = new window.Image();
		tempImg.onload = () => {
			this.naturalW = tempImg.naturalWidth;
			this.naturalH = tempImg.naturalHeight;

			const fitted = this.fitSize(this.naturalW, this.naturalH);
			this.imgEl.style.width = `${fitted.w}px`;
			this.imgEl.style.height = `${fitted.h}px`;
			this.imgEl.src = src;

			// Size wrapperEl to fit the image + all border layers.
			// Each border-layer uses border-box sizing so its border
			// expands inward; wrapperEl must be big enough so that
			// overflow:hidden doesn't clip the borders.
			const totalBorderWidth =
				this.settings.borderOuterWidth +
				this.settings.borderMiddleWidth +
				this.settings.borderInnerWidth;
			this.wrapperEl.style.width = `${fitted.w + 2 * totalBorderWidth}px`;
			this.wrapperEl.style.height = `${fitted.h + 2 * totalBorderWidth}px`;

			this.applyTransform();
			this.updateNavHint();
		};
		tempImg.onerror = () => {
			this.errorRetryCount++;
			// Limit retries to prevent infinite loop if all images fail
			if (this.errorRetryCount >= this.images.length) {
				this.close();
				return;
			}
			// On error, try next image
			this.navigateTo(1);
		};
		tempImg.src = src;
	}

	private navigateTo(direction: 1 | -1) {
		const len = this.images.length;
		if (len <= 1) return;
		this.currentIndex = (this.currentIndex + direction + len) % len;
		this.loadCurrentImage();
	}

	private updateNavHint() {
		const len = this.images.length;
		if (len > 1) {
			this.navHintEl.textContent = `${this.currentIndex + 1} / ${len}`;
			this.navHintEl.style.display = "";
		} else {
			this.navHintEl.style.display = "none";
		}
	}

	/* ── transform (zoom & pan) ────────────────────── */

	private applyTransform() {
		this.wrapperEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
	}

	/* ── event handlers ────────────────────────────── */

	private onKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			this.close();
			return;
		}
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			this.navigateTo(-1);
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			this.navigateTo(1);
		}
	}

	private onWheel(e: WheelEvent) {
		e.preventDefault();

		const rect = this.wrapperEl.getBoundingClientRect();
		const cursorX = e.clientX - rect.left;
		const cursorY = e.clientY - rect.top;

		const delta = -e.deltaY * 0.002;
		const newScale = Math.max(0.1, this.scale * (1 + delta));

		// Adjust pan so cursor position stays fixed on the image
		this.panX = cursorX - (cursorX - this.panX) * (newScale / this.scale);
		this.panY = cursorY - (cursorY - this.panY) * (newScale / this.scale);

		this.scale = newScale;
		this.applyTransform();
	}

	private onMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		if (this.scale <= 1.01) return; // only drag when zoomed in
		this.isDragging = true;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		this.dragPanX = this.panX;
		this.dragPanY = this.panY;
		this.wrapperEl.style.cursor = "grabbing";
		e.preventDefault();
	}

	private onMouseMove(e: MouseEvent) {
		if (!this.isDragging) return;
		this.panX = this.dragPanX + (e.clientX - this.dragStartX);
		this.panY = this.dragPanY + (e.clientY - this.dragStartY);
		this.applyTransform();
	}

	private onMouseUp(_e: MouseEvent) {
		if (!this.isDragging) return;
		this.isDragging = false;
		this.wrapperEl.style.cursor = this.scale > 1.01 ? "grab" : "grab";
	}

	private onBgClick(_e: MouseEvent) {
		this.close();
	}
}

/**
 * Check whether a MouseEvent has the requested modifier key pressed.
 */
export function isModifierPressed(
	evt: MouseEvent,
	modifier: ModifierKey | "none",
): boolean {
	if (modifier === "none") return true;
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
