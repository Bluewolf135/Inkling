import { INK_FILE_EXTENSION } from './inkFile';

// Where a new block's ink file is created. Creation only: changing the
// setting never moves a file that exists, and nothing here is consulted for a
// block already inserted, whose fence names its file outright.

export type InkFileLocation = 'attachments' | 'beside-note' | 'folder';
export const INK_FILE_LOCATIONS: readonly InkFileLocation[] = ['attachments', 'beside-note', 'folder'];

// One file per note, by convention and not by rule: two notes of the same
// name sharing an attachment folder share an ink file, and that works,
// because block ids are unique and nothing in the file says which note it
// belongs to.
export function inkFileName(notePath: string): string {
	const name = notePath.split('/').pop() ?? notePath;
	return `${name.replace(/\.md$/i, '')}.${INK_FILE_EXTENSION}`;
}

export function joinVaultPath(folder: string, name: string): string {
	const trimmed = folder.replace(/^\/+/, '').replace(/\/+$/, '');
	return trimmed ? `${trimmed}/${name}` : name;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * `attachmentFolderFor` is Obsidian's `fileManager.getNewFileParent(notePath,
 * fileName).path`, which answers with the attachment folder when given a
 * file name that is not a note.
 */
export function inkFilePathFor(
	notePath: string,
	location: InkFileLocation,
	folder: string,
	attachmentFolderFor: (notePath: string, fileName: string) => string,
): string {
	const name = inkFileName(notePath);
	switch (location) {
		case 'beside-note':
			return joinVaultPath(parentOf(notePath), name);
		case 'folder':
			return joinVaultPath(folder, name);
		case 'attachments':
			return joinVaultPath(attachmentFolderFor(notePath, name), name);
	}
}
