export enum ModifierKey {
	ALT = 'AltLeft',
	CTRL = 'ControlLeft',
	SHIFT = 'ShiftLeft',
	ALT_RIGHT = 'AltRight',
	CTRL_RIGHT = 'ControlRight',
	SHIFT_RIGHT = 'ShiftRight',
}

export interface ReplaceTerm {
	replaceFrom: (oldSize: number) => string;
	replaceWith: (newSize: number) => string;
}

export interface HandleZoomParams {
	sizeMatchRegExp: RegExp;
	replaceSizeExist: ReplaceTerm;
	replaceSizeNotExist: ReplaceTerm;
}

export class ImageZoomUtil {
	public static isInTable(searchString: string, fileValue: string): boolean {
		return fileValue.search(new RegExp(`^\\|.+${escapeRegex(searchString)}.+\\|$`, 'm')) !== -1;
	}

	public static getLocalImageNameFromUri(imageUri: string): string {
		try {
			imageUri = decodeURI(imageUri);
		} catch {
			// fallback if decodeURI throws on malformed sequences
		}
		const imageNameMatch = imageUri.match(/([^/?\\#]+)(\?.*?|#.*?|)$/);
		const imageName = imageNameMatch && imageNameMatch[1] ? imageNameMatch[1] : '';

		const hasLinuxDecodingIssue = imageName.startsWith('2F');
		return hasLinuxDecodingIssue ? imageName.slice(2) : imageName;
	}

	public static getLocalImageZoomParams(imageName: string, fileText: string): HandleZoomParams {
		imageName = this.determineImageName(imageName, fileText);

		const folderName = this.getFolderNameIfExist(imageName, fileText);
		imageName = `${folderName}${imageName}`;

		const isInTable = ImageZoomUtil.isInTable(imageName, fileText);
		const sizeSeparator = isInTable ? '\\|' : '|';
		const regexSeparator = isInTable ? '\\\\\\|' : '\\|';

		const imageNamePosition = fileText.indexOf(imageName);
		const isObsidianLink = fileText.charAt(imageNamePosition - 1) === '[';

		if (isObsidianLink) {
			const imageAttributes = this.getImageAttributes(imageName, fileText);
			imageName = `${imageName}${imageAttributes}`;
			return ImageZoomUtil.generateReplaceTermForObsidianSyntax(imageName, regexSeparator, sizeSeparator);
		} else {
			return ImageZoomUtil.generateReplaceTermForMarkdownSyntax(imageName);
		}
	}

	public static getRemoteImageZoomParams(imageUri: string): HandleZoomParams {
		const cleanUri = imageUri.replace(/#width=\d+.*$/, '').split('?')[0] ?? '';
		return ImageZoomUtil.generateReplaceTermForMarkdownSyntax(cleanUri);
	}

	private static determineImageName(origImageName: string, fileText: string): string {
		const encodedImageName = encodeURI(origImageName);
		const spaceEncodedImageName = origImageName.replace(/ /g, '%20');

		const imageNameVariants = [origImageName, encodedImageName, spaceEncodedImageName];

		for (const variant of imageNameVariants) {
			if (fileText.includes(variant)) {
				return variant;
			}
		}

		throw new Error('Image not found in file');
	}

	private static getFolderNameIfExist(imageName: string, fileText: string): string {
		const index = fileText.indexOf(imageName);

		if (index === -1) {
			throw new Error('Image not found in file');
		}

		const stringBeforeFileName = fileText.substring(0, index);

		const lastOpeningBracket = stringBeforeFileName.lastIndexOf('['); // Obsidian link
		const lastOpeningParenthesis = stringBeforeFileName.lastIndexOf('('); // Markdown link
		const lastOpeningBracketOrParenthesis = Math.max(lastOpeningBracket, lastOpeningParenthesis);
		const folderName = stringBeforeFileName.substring(lastOpeningBracketOrParenthesis + 1);

		return folderName;
	}

	private static getImageAttributes(imageName: string, fileText: string): string {
		const index = fileText.indexOf(imageName);
		const stringAfterFileName = fileText.substring(index + imageName.length);
		const regExpMatchArray = stringAfterFileName.match(/([^\]]*?)\\?\|\d+]]|([^\]]*?)]]|/);

		if (regExpMatchArray) {
			if (regExpMatchArray[1]) {
				return regExpMatchArray[1];
			} else if (regExpMatchArray[2]) {
				return regExpMatchArray[2];
			}
		}

		return '';
	}

	private static generateReplaceTermForMarkdownSyntax(imageName: string): HandleZoomParams {
		const fragmentRegex = new RegExp(`${escapeRegex(imageName)}#width=(\\d+)`);
		return {
			sizeMatchRegExp: fragmentRegex,
			replaceSizeExist: {
				replaceFrom: (oldSize) => `${imageName}#width=${oldSize}`,
				replaceWith: (newSize) => `${imageName}#width=${newSize}`,
			},
			replaceSizeNotExist: {
				replaceFrom: () => `(${imageName})`,
				replaceWith: (newSize) => `(${imageName}#width=${newSize})`,
			},
		};
	}

	private static generateReplaceTermForObsidianSyntax(
		imageName: string,
		regexSeparator: string,
		sizeSeparator: string,
	): HandleZoomParams {
		const sizeMatchRegExp = new RegExp(`${escapeRegex(imageName)}${regexSeparator}(\\d+)`);

		const replaceSizeExistFrom = (oldSize: number) => `${imageName}${sizeSeparator}${oldSize}`;
		const replaceSizeExistWith = (newSize: number) => `${imageName}${sizeSeparator}${newSize}`;

		const replaceSizeNotExistsFrom = () => `${imageName}`;
		const replaceSizeNotExistsWith = (newSize: number) => `${imageName}${sizeSeparator}${newSize}`;

		return {
			sizeMatchRegExp,
			replaceSizeExist: { replaceFrom: replaceSizeExistFrom, replaceWith: replaceSizeExistWith },
			replaceSizeNotExist: { replaceFrom: replaceSizeNotExistsFrom, replaceWith: replaceSizeNotExistsWith },
		};
	}
}

export function escapeRegex(str: string): string {
	return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export function parseWidthFromString(str: string | null | undefined): number | null {
	if (!str) return null;

	const explicitMatch = str.match(/[#&?]width=(\d+)/i);
	if (explicitMatch && explicitMatch[1]) {
		const val = parseInt(explicitMatch[1], 10);
		if (val >= 10 && val <= 5000) return val;
	}

	return null;
}

