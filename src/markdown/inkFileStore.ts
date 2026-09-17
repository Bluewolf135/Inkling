import { parseInkFile, readInkFileBlock, type BlockRead, type InkFileBlock, type InkFileContents } from './inkFile';

// One live ink file, shared by every block that names it.
//
// It reads the file, holds the last parse that succeeded, tells blocks when
// something they show has changed, and — see the write half below — queues
// every write to the file one after another. Everything that changes what
// the store holds runs through that one queue, reads included, so an
// external change and a save can never interleave halfway through either.
//
// Pure of Obsidian: the file is reached through InkFileIO, which the plugin
// implements over the Vault (inkFileVaultIO.ts) and the tests over a Map.

export interface InkFileIO {
	/** The file's text, or null when there is no file at `path`. */
	read(path: string): Promise<string | null>;
	/**
	 * Writes `next` only if the file still reads `expected` (null: only if it
	 * does not exist, creating it). The comparison and the write are one
	 * operation, so a change landing between them cannot be overwritten.
	 */
	replaceIf(path: string, expected: string | null, next: string): Promise<ReplaceResult>;
	/** The file's size on disk in bytes, or null when that cannot be known. */
	size(path: string): Promise<number | null>;
}

export type ReplaceResult = { written: true } | { written: false; found: string | null };

export type InkFileStatus =
	| { kind: 'loading' }
	| { kind: 'readable' }
	// No file at this path. Blocks already held are kept, not forgotten: they
	// may be the only copy there is.
	| { kind: 'absent' }
	| { kind: 'from-future'; version: number }
	// Unreadable, with no good parse held from earlier in the session.
	| { kind: 'damaged' };

export type BlockState =
	| { kind: 'decoded'; block: InkFileBlock; revision: number; strokes: string }
	| { kind: 'undecodable' }
	| { kind: 'unsupported'; codec: string }
	| { kind: 'absent' };

export type StoreChange = ReadonlySet<string> | 'all';
// `origin` is whoever caused the change — a block's own storage for its own
// save, null for anything that came from the file.
export type StoreListener = (change: StoreChange, origin: object | null) => void;

interface HeldBlock {
	read: BlockRead;
	// The block exactly as the file held it, serialized, which is how a
	// re-read tells a block that changed from one that did not without
	// decoding either.
	json: string;
	// Changes whenever the block does. See the write half: a save merges
	// whenever the revision it was based on is not the one held.
	revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class InkFileStore {
	private current: InkFileStatus = { kind: 'loading' };
	// The last parse that succeeded, blocks still raw. Null until one has.
	private contents: InkFileContents | null = null;
	private readonly held = new Map<string, HeldBlock>();
	// The file's text as last read or written; null when there was no file.
	// A save writes only over exactly this.
	private lastText: string | null = null;
	private revisions = 0;
	private readonly listeners = new Set<StoreListener>();
	private tail: Promise<unknown> = Promise.resolve();
	private loading: Promise<void> | null = null;

	constructor(
		readonly path: string,
		private readonly io: InkFileIO,
	) {}

	status(): InkFileStatus {
		return this.current;
	}

	load(): Promise<void> {
		this.loading ??= this.enqueue(() => this.readFromDisk());
		return this.loading;
	}

	/** Settles once everything queued so far has run. */
	async whenIdle(): Promise<void> {
		await this.tail;
	}

	blockState(id: string): BlockState {
		const held = this.held.get(id);
		if (!held) return { kind: 'absent' };
		if (held.read.kind !== 'decoded') return held.read;
		return { kind: 'decoded', block: held.read.block, revision: held.revision, strokes: this.strokesOf(id) };
	}

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	fileChanged(): void {
		void this.enqueue(() => this.readFromDisk());
	}

	fileDeleted(): void {
		void this.enqueue(() => this.adopt(null, null));
	}

	// The opaque stroke payload, which is what the rescue store compares a
	// held drawing against to prove the file has not moved on.
	private strokesOf(id: string): string {
		const raw = this.contents?.blocks.get(id);
		return isRecord(raw) && typeof raw.strokes === 'string' ? raw.strokes : '';
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task);
		// The queue survives a task that throws; the caller still sees it.
		this.tail = run.catch(() => undefined);
		return run;
	}

	private notify(change: StoreChange, origin: object | null): void {
		for (const listener of [...this.listeners]) listener(change, origin);
	}

	private async readFromDisk(): Promise<void> {
		let text: string | null;
		try {
			text = await this.io.read(this.path);
		} catch (error) {
			console.error(`Inkling: could not read ${this.path}.`, error);
			// Not the same as absent: something is there. Nothing is known about
			// it, so nothing may be written over it.
			if (this.current.kind === 'loading') {
				this.current = { kind: 'damaged' };
				this.notify('all', null);
			}
			return;
		}
		await this.adopt(text, null);
	}

	// Takes on what the file says now.
	private async adopt(text: string | null, origin: object | null): Promise<void> {
		if (text === null) {
			if (this.current.kind === 'absent') return;
			this.lastText = null;
			this.current = { kind: 'absent' };
			this.notify('all', origin);
			return;
		}

		// Almost always our own write, reported back by the vault.
		if (text === this.lastText && this.current.kind !== 'loading') return;

		const read = parseInkFile(text);
		if (read.kind === 'damaged') {
			// A damaged read never displaces a good one. A file caught mid-sync
			// is partial for a moment and whole a moment later, and the session
			// goes on serving what it holds while that settles. lastText is left
			// alone, so a save made meanwhile sees the file is not what it last
			// saw and refuses rather than writing over it.
			if (this.contents && this.current.kind === 'readable') return;
			this.current = { kind: 'damaged' };
			this.notify('all', origin);
			return;
		}

		if (read.kind === 'from-future') {
			this.lastText = text;
			this.current = { kind: 'from-future', version: read.version };
			this.notify('all', origin);
			return;
		}

		const changed = new Set<string>();
		const next = new Map<string, HeldBlock>();
		for (const [id, raw] of read.contents.blocks) {
			const json = JSON.stringify(raw);
			const previous = this.held.get(id);
			if (previous && previous.json === json) {
				next.set(id, previous);
				continue;
			}
			next.set(id, { read: await readInkFileBlock(raw), json, revision: ++this.revisions });
			changed.add(id);
		}
		for (const id of this.held.keys()) {
			if (!next.has(id)) changed.add(id);
		}

		this.held.clear();
		for (const [id, block] of next) this.held.set(id, block);
		this.contents = read.contents;
		this.lastText = text;

		const wasReadable = this.current.kind === 'readable';
		this.current = { kind: 'readable' };
		if (!wasReadable) this.notify('all', origin);
		else if (changed.size > 0) this.notify(changed, origin);
	}
}

// Every store in use, so blocks naming the same file share one — which is
// what makes a copied fence show the original's ink, and what keeps two
// blocks in one note from racing each other to write the same file.
export class InkFileStores {
	private readonly entries = new Map<string, { store: InkFileStore; users: number }>();

	constructor(private readonly io: InkFileIO) {}

	acquire(path: string): InkFileStore {
		let entry = this.entries.get(path);
		if (!entry) {
			entry = { store: new InkFileStore(path, this.io), users: 0 };
			this.entries.set(path, entry);
		}
		entry.users += 1;
		return entry.store;
	}

	// A store outlives its last user until its queue is empty, so a block that
	// flushes a save as it is torn down still gets that save written.
	release(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		entry.users -= 1;
		if (entry.users > 0) return;
		void entry.store.whenIdle().then(() => {
			if (entry.users <= 0 && this.entries.get(path) === entry) this.entries.delete(path);
		});
	}

	isHeld(path: string): boolean {
		return this.entries.has(path);
	}

	fileChanged(path: string): void {
		this.entries.get(path)?.store.fileChanged();
	}

	fileDeleted(path: string): void {
		this.entries.get(path)?.store.fileDeleted();
	}

	// Until fences are rewritten on rename, a fence naming the old path is
	// naming a file that is not there.
	fileRenamed(oldPath: string, newPath: string): void {
		this.fileDeleted(oldPath);
		this.fileChanged(newPath);
	}
}
