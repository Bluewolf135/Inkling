import type { Vault } from 'obsidian';
import type { InkFileIO, ReplaceResult } from './inkFileStore';

// The store's file access, over Obsidian's Vault. Through the Vault API
// rather than the adapter, so every write fires the events sync plugins and
// the store's own external-change watch depend on.

async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
	const segments = path.split('/').slice(0, -1);
	for (let depth = 1; depth <= segments.length; depth++) {
		const folder = segments.slice(0, depth).join('/');
		if (vault.getFolderByPath(folder)) continue;
		try {
			await vault.createFolder(folder);
		} catch (error) {
			// Created by something else in the meantime is fine; anything else
			// is a failure the store reports.
			if (!vault.getFolderByPath(folder)) throw error;
		}
	}
}

export function vaultInkFileIO(vault: Vault): InkFileIO {
	return {
		read: async (path) => {
			const file = vault.getFileByPath(path);
			return file ? vault.read(file) : null;
		},
		size: async (path) => (await vault.adapter.stat(path))?.size ?? null,
		replaceIf: async (path, expected, next): Promise<ReplaceResult> => {
			const file = vault.getFileByPath(path);
			if (expected === null) {
				if (file) return { written: false, found: await vault.read(file) };
				await ensureParentFolder(vault, path);
				await vault.create(path, next);
				return { written: true };
			}
			if (!file) return { written: false, found: null };

			// Read, compare and write under the vault's own lock, so nothing can
			// land between the comparison and the write.
			const mismatch: { found: string | null } = { found: null };
			await vault.process(file, (current) => {
				if (current === expected) return next;
				mismatch.found = current;
				return current;
			});
			return mismatch.found === null ? { written: true } : { written: false, found: mismatch.found };
		},
	};
}
