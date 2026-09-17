import type { InkFileIO, ReplaceResult } from '../../src/markdown/inkFileStore';
import { serializeInkFile, writeInkFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';

// Ink files held in a Map, with the failures a real vault produces on demand.
//
// Every write goes through replaceIf, which is the store's only way to write,
// so a hook placed there sees exactly the moments at which a change landing
// from elsewhere matters.
export interface MemoryInkFileIO extends InkFileIO {
	files: Map<string, string>;
	/** Every call to read, including the store's verification re-read. */
	reads: number;
	/** Every write that reached a file. */
	writes: number;
	/** Runs at the start of the next replaceIf, then clears itself — a sync landing mid-save. */
	beforeReplace: ((path: string) => void) | null;
	/** Leaves only the first half of the next write on disk — the app killed mid-save. */
	truncateNextWrite: boolean;
	/** Throws from the next write. */
	failNextWrite: boolean;
}

export function memoryInkFileIO(initial: Record<string, string> = {}): MemoryInkFileIO {
	const io: MemoryInkFileIO = {
		files: new Map(Object.entries(initial)),
		reads: 0,
		writes: 0,
		beforeReplace: null,
		truncateNextWrite: false,
		failNextWrite: false,
		read: async (path) => {
			io.reads += 1;
			return io.files.get(path) ?? null;
		},
		size: async (path) => {
			const text = io.files.get(path);
			return text === undefined ? null : new TextEncoder().encode(text).length;
		},
		replaceIf: async (path, expected, next): Promise<ReplaceResult> => {
			const hook = io.beforeReplace;
			io.beforeReplace = null;
			hook?.(path);
			if (io.failNextWrite) {
				io.failNextWrite = false;
				throw new Error('disk full');
			}
			const current = io.files.get(path) ?? null;
			if (current !== expected) return { written: false, found: current };
			io.files.set(path, io.truncateNextWrite ? next.slice(0, Math.floor(next.length / 2)) : next);
			io.truncateNextWrite = false;
			io.writes += 1;
			return { written: true };
		},
	};
	return io;
}

function isFileBlock(value: unknown): value is InkFileBlock {
	return typeof value === 'object' && value !== null && Array.isArray((value as { annotations?: unknown }).annotations);
}

/** An ink file's text. An InkFileBlock is encoded; anything else is written as the raw block. */
export async function inkFileText(blocks: Record<string, unknown>, extra: Array<[string, unknown]> = []): Promise<string> {
	const raw = new Map<string, unknown>();
	for (const [id, block] of Object.entries(blocks)) {
		raw.set(id, isFileBlock(block) ? await writeInkFileBlock(undefined, block) : block);
	}
	return serializeInkFile({ extra, blocks: raw });
}
