import {
	App,
	Editor,
	MarkdownView,
	Notice,
	TFile,
	requestUrl,
	DataAdapter,
} from "obsidian";

/* ── MIME & Extension Mappings ─────────────────────────────── */

export const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/avif": ".avif",
	"image/bmp": ".bmp",
	"image/x-icon": ".ico",
	"image/vnd.microsoft.icon": ".ico",
	"image/tiff": ".tiff",
	"image/heic": ".heic",
	"image/heif": ".heif",
};

export const KNOWN_IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".avif",
	".bmp",
	".ico",
	".tiff",
	".tif",
	".heic",
	".heif",
]);

export interface ImageDownloadSettings {
	imageDownloadFolder: string;
	imageDownloadMaxWidth: number;
	imageDownloadMaxHeight: number;
}

/* ── Path Helpers ──────────────────────────────────────────── */

export function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function resolveImageFolder(template: string, file: TFile): string {
	const rawTpl = template.trim() || ".${noteFileName}.assets/";
	const substituted = rawTpl.replace(/\$\{noteFileName\}/g, file.basename);
	const normalized = normalizeVaultPath(substituted);

	const parentPath =
		file.parent && file.parent.path !== "/" ? file.parent.path : "";

	if (rawTpl.startsWith("./") || rawTpl.startsWith(".")) {
		return normalizeVaultPath(
			parentPath ? `${parentPath}/${normalized}` : normalized,
		);
	} else if (rawTpl.startsWith("/")) {
		return normalized;
	} else {
		return normalized;
	}
}

export function getRelativeMarkdownPath(
	fromFilePath: string,
	toFilePath: string,
): string {
	const fromParts = fromFilePath.split("/").slice(0, -1);
	const toParts = toFilePath.split("/");

	let commonLength = 0;
	while (
		commonLength < fromParts.length &&
		commonLength < toParts.length &&
		fromParts[commonLength] === toParts[commonLength]
	) {
		commonLength++;
	}

	const upCount = fromParts.length - commonLength;
	const upSteps = Array(upCount).fill("..");
	const remainingTo = toParts.slice(commonLength);

	return [...upSteps, ...remainingTo].join("/");
}

export async function ensureFolderExists(
	adapter: DataAdapter,
	folderPath: string,
): Promise<void> {
	if (!folderPath || (await adapter.exists(folderPath))) return;
	const segments = folderPath.split("/");
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		if (!(await adapter.exists(current))) {
			await adapter.mkdir(current);
		}
	}
}

export async function getAvailableFilePath(
	adapter: DataAdapter,
	folderPath: string,
	baseName: string,
	ext: string,
): Promise<{ filePath: string; fileName: string }> {
	let fileName = `${baseName}${ext}`;
	let filePath = folderPath ? `${folderPath}/${fileName}` : fileName;
	let counter = 1;
	while (await adapter.exists(filePath)) {
		fileName = `${baseName} ${counter}${ext}`;
		filePath = folderPath ? `${folderPath}/${fileName}` : fileName;
		counter++;
	}
	return { filePath, fileName };
}

/* ── Image Detection & Processing ──────────────────────────── */

export function detectImageExtensionFromBuffer(
	buffer: ArrayBuffer,
): string | null {
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 4) return null;

	// PNG: 89 50 4E 47
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return ".png";
	}
	// JPEG: FF D8 FF
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return ".jpg";
	}
	// GIF: 47 49 46 (GIF)
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return ".gif";
	}
	// WebP: RIFF .... WEBP
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return ".webp";
	}
	// BMP: 42 4D (BM)
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return ".bmp";
	}
	// SVG text check
	try {
		const head = new TextDecoder("utf-8").decode(
			bytes.subarray(0, Math.min(bytes.length, 512)),
		);
		if (
			head.includes("<svg") ||
			(head.includes("<?xml") && head.includes("<svg"))
		) {
			return ".svg";
		}
	} catch {
		// Ignore decode error
	}
	return null;
}

export function getImageFileNameAndExt(
	urlStr: string,
	contentType: string,
	buffer: ArrayBuffer,
): { baseName: string; ext: string } | null {
	let ext = "";
	const cleanMime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	if (cleanMime && MIME_TO_EXT[cleanMime]) {
		ext = MIME_TO_EXT[cleanMime];
	}

	let urlPath = "";
	try {
		const parsedUrl = new URL(urlStr);
		urlPath = parsedUrl.pathname;
	} catch {
		urlPath = "";
	}

	const rawFileName = urlPath
		? decodeURIComponent(urlPath.split("/").pop() || "")
		: "";
	let baseName = "";
	let urlExt = "";

	if (rawFileName) {
		const lastDotIndex = rawFileName.lastIndexOf(".");
		if (lastDotIndex > 0) {
			const potentialExt = rawFileName.slice(lastDotIndex).toLowerCase();
			if (KNOWN_IMAGE_EXTENSIONS.has(potentialExt)) {
				urlExt = potentialExt;
				baseName = rawFileName.slice(0, lastDotIndex);
			} else {
				baseName = rawFileName;
			}
		} else {
			baseName = rawFileName;
		}
	}

	if (!ext && urlExt) {
		ext = urlExt;
	}

	if (!ext) {
		const detected = detectImageExtensionFromBuffer(buffer);
		if (detected) {
			ext = detected;
		}
	}

	if (!ext && cleanMime.startsWith("image/")) {
		const subtype = cleanMime.slice(6);
		if (subtype && /^[a-z0-9]+$/.test(subtype)) {
			ext = `.${subtype}`;
		}
	}

	if (!ext) {
		return null;
	}

	baseName = baseName.replace(/[/\\?%*:|"<>]/g, "-").trim();
	if (!baseName) {
		baseName = `image-${Date.now()}`;
	}

	return { baseName, ext };
}

export async function resizeImageIfNeeded(
	buffer: ArrayBuffer,
	mimeType: string,
	maxWidth: number,
	maxHeight: number,
): Promise<ArrayBuffer> {
	if (maxWidth <= 0 && maxHeight <= 0) {
		return buffer;
	}

	const cleanMime = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
	const resizableMimes = new Set([
		"image/png",
		"image/jpeg",
		"image/jpg",
		"image/webp",
		"image/bmp",
	]);

	if (!resizableMimes.has(cleanMime)) {
		return buffer;
	}

	const blob = new Blob([buffer], { type: cleanMime });
	let bitmap: ImageBitmap | null = null;
	let objectUrl = "";

	try {
		let width = 0;
		let height = 0;
		let source: CanvasImageSource;

		if (typeof createImageBitmap === "function") {
			bitmap = await createImageBitmap(blob);
			width = bitmap.width;
			height = bitmap.height;
			source = bitmap;
		} else {
			objectUrl = URL.createObjectURL(blob);
			const img = new Image();
			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = () =>
					reject(new Error("Failed to load image for resizing"));
				img.src = objectUrl;
			});
			width = img.naturalWidth || img.width;
			height = img.naturalHeight || img.height;
			source = img;
		}

		let scale = 1;
		if (maxWidth > 0 && width > maxWidth) {
			scale = Math.min(scale, maxWidth / width);
		}
		if (maxHeight > 0 && height > maxHeight) {
			scale = Math.min(scale, maxHeight / height);
		}

		if (scale >= 1) {
			return buffer;
		}

		const targetWidth = Math.round(width * scale);
		const targetHeight = Math.round(height * scale);

		const canvas = document.createElement("canvas");
		canvas.width = targetWidth;
		canvas.height = targetHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return buffer;
		}

		ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

		const exportMime = cleanMime === "image/jpg" ? "image/jpeg" : cleanMime;
		const quality =
			exportMime === "image/jpeg" || exportMime === "image/webp"
				? 0.92
				: undefined;

		const resizedBlob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((b) => resolve(b), exportMime, quality);
		});

		if (!resizedBlob) {
			return buffer;
		}

		return await resizedBlob.arrayBuffer();
	} catch {
		return buffer;
	} finally {
		if (bitmap) {
			bitmap.close();
		}
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
		}
	}
}

/* ── High-Level Action ─────────────────────────────────────── */

export async function downloadAndEmbedClipboardImage(
	app: App,
	editor: Editor,
	view: MarkdownView,
	settings: ImageDownloadSettings,
): Promise<void> {
	const file = view.file ?? app.workspace.getActiveFile();
	if (!file) {
		new Notice("No active note found.");
		return;
	}

	let clipboardText = "";
	try {
		clipboardText = (await navigator.clipboard.readText()).trim();
	} catch {
		new Notice("Failed to read clipboard.");
		return;
	}

	if (!clipboardText) {
		new Notice("Clipboard is empty.");
		return;
	}

	if (
		!clipboardText.startsWith("http://") &&
		!clipboardText.startsWith("https://")
	) {
		new Notice("Clipboard does not contain an HTTP or HTTPS URL.");
		return;
	}

	try {
		new URL(clipboardText);
	} catch {
		new Notice("Clipboard does not contain a valid URL.");
		return;
	}

	new Notice("Downloading image from clipboard URL...");

	let response;
	try {
		response = await requestUrl({ url: clipboardText });
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		new Notice(`Failed to download image: ${errorMsg}`);
		return;
	}

	if (response.status < 200 || response.status >= 300) {
		new Notice(`Failed to download image: HTTP status ${response.status}`);
		return;
	}

	const contentType =
		Object.entries(response.headers).find(
			([k]) => k.toLowerCase() === "content-type",
		)?.[1] || "";

	const fileInfo = getImageFileNameAndExt(
		clipboardText,
		contentType,
		response.arrayBuffer,
	);

	if (!fileInfo) {
		new Notice("The downloaded content does not appear to be an image.");
		return;
	}

	const folderPath = resolveImageFolder(settings.imageDownloadFolder, file);
	const adapter = app.vault.adapter;

	try {
		await ensureFolderExists(adapter, folderPath);

		const { filePath, fileName } = await getAvailableFilePath(
			adapter,
			folderPath,
			fileInfo.baseName,
			fileInfo.ext,
		);

		let effectiveMime =
			(contentType.split(";")[0] ?? "").trim().toLowerCase();
		if (!effectiveMime || effectiveMime === "application/octet-stream") {
			if (fileInfo.ext === ".png") effectiveMime = "image/png";
			else if (fileInfo.ext === ".jpg" || fileInfo.ext === ".jpeg")
				effectiveMime = "image/jpeg";
			else if (fileInfo.ext === ".webp") effectiveMime = "image/webp";
			else if (fileInfo.ext === ".bmp") effectiveMime = "image/bmp";
			else if (fileInfo.ext === ".gif") effectiveMime = "image/gif";
		}

		const finalBuffer = await resizeImageIfNeeded(
			response.arrayBuffer,
			effectiveMime,
			settings.imageDownloadMaxWidth,
			settings.imageDownloadMaxHeight,
		);

		await adapter.writeBinary(filePath, finalBuffer);

		const relPath = getRelativeMarkdownPath(file.path, filePath);
		const formattedPath = encodeURI(relPath).replace(/#/g, "%23");
		const markdownEmbed = `![${fileName}](${formattedPath})`;

		editor.replaceSelection(markdownEmbed);
		new Notice(`Image saved and embedded: ${fileName}`);
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		new Notice(`Failed to save image: ${errorMsg}`);
	}
}
