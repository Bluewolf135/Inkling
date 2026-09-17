import { INK_BLOCK_LANGUAGE } from './inkBlockFormat';

// The three lines a block leaves in the note once its ink lives in a file.
//
//     ```inkling
//     file: Attachments/Newton's Laws of Motion Exercises.ink
//     id: 2b
//     ```
//
// `file` is explicit rather than derived from the note's name, so a fence
// means the same thing wherever it is pasted: a copied block shares the
// original's ink, which is what was asked for.

export interface InkFence {
	file: string;
	id: string;
	// Every other non-blank line, trimmed, in order. Kept rather than parsed,
	// so a line a later version adds survives this version rewriting the fence.
	extra: string[];
}

export type InkFenceDamage = 'missing-file' | 'missing-id' | 'not-a-vault-path' | 'duplicate-key';

export type InkFenceRead = { kind: 'fence'; fence: InkFence } | { kind: 'damaged'; reason: InkFenceDamage };

// A line that opens with a key. Anchored, and linear in the line.
const KEY_LINE = /^[A-Za-z][A-Za-z0-9_-]*\s*:/;

// Which format a fence holds, decided by its content. JSON — anything opening
// with a brace, and an empty fence, which has always meant an empty in-note
// block — is the old format; a body opening with a `key:` line is the new
// one. Anything else goes to the old format's parser, which already knows how
// to show a block it cannot read.
export function isInkFileFence(source: string): boolean {
	const trimmed = source.trim();
	if (!trimmed || trimmed.startsWith('{')) return false;
	return KEY_LINE.test(trimmed);
}

// A path inside the vault, as the Vault API names one. Anything absolute,
// anything climbing out, and anything hidden is refused: Obsidian's Vault API
// does not see paths beginning with a dot at all, and ink that silently stops
// syncing is the worst failure available.
export function isVaultPath(path: string): boolean {
	if (!path || path !== path.trim()) return false;
	if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
	return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'));
}

export function parseInkFence(source: string): InkFenceRead {
	let file: string | undefined;
	let id: string | undefined;
	const extra: string[] = [];

	for (const raw of source.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const colon = line.indexOf(':');
		const key = colon > 0 ? line.slice(0, colon).trim() : '';
		const value = colon > 0 ? line.slice(colon + 1).trim() : '';

		if (key === 'file' || key === 'id') {
			// Two answers to where the ink is is no answer. Refusing is what
			// stops a save guessing between them.
			if ((key === 'file' ? file : id) !== undefined) return { kind: 'damaged', reason: 'duplicate-key' };
			if (key === 'file') file = value;
			else id = value;
			continue;
		}
		extra.push(line);
	}

	if (!file) return { kind: 'damaged', reason: 'missing-file' };
	if (!id) return { kind: 'damaged', reason: 'missing-id' };
	if (!isVaultPath(file)) return { kind: 'damaged', reason: 'not-a-vault-path' };
	return { kind: 'fence', fence: { file, id, extra } };
}

export function serializeInkFence(fence: InkFence): string {
	return [`file: ${fence.file}`, `id: ${fence.id}`, ...fence.extra].join('\n');
}

export function inkFenceMarkdown(fence: InkFence): string {
	return `\`\`\`${INK_BLOCK_LANGUAGE}\n${serializeInkFence(fence)}\n\`\`\``;
}
