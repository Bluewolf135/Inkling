import { parseInkBlock, serializeInkBlock, type InkBlockData } from './inkBlockFormat';

// Ink that was drawn but could not be written to the note, kept somewhere it
// survives quitting Obsidian.
//
// This began as a Map on the module, which held a drawing across the
// re-render that would otherwise throw it away — the failure that actually
// cost work twice. It did not hold one across a quit, and a crash is exactly
// when a save is most likely to have failed.
//
// localStorage rather than the plugin's data.json, deliberately. data.json
// syncs, and this vault replicates through Self-hosted LiveSync: a recovery
// buffer that syncs can produce conflicts on the very thing that exists to
// survive them. A crash buffer is not content and has no business leaving
// the device that made it.
//
// Holding and persisting are separate for a reason worth stating. Every save
// holds, and holding has to be free: it keeps a reference to the block's own
// data, serializes nothing, and touches no storage. Only a save that failed
// persists, because localStorage is synchronous and a densely drawn block is
// most of a megabyte of JSON — writing that on every save would put a disk
// write on the main thread once a second while the pen is still moving,
// which is the exact cost Phases E and F were spent removing.

// Namespaced so a sweep can tell our entries from everything else sharing
// the origin — which, in Obsidian, is every other plugin.
export const RESCUE_PREFIX = 'inkling:unsaved:';

// After this long an entry is not a rescue, it is an ambush: a drawing from
// a fortnight ago reappearing over a block someone has since worked on.
export const RESCUE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// The slice of the Storage interface this needs, so tests can supply one and
// so a platform without localStorage is a missing object rather than a crash.
export interface RescueStorage {
	readonly length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

// The block's source as it stood in the file when the drawing was held.
//
// The whole reason an entry can be trusted is that it is *newer than the
// file* — the file is what the failed save was trying to update. Across a
// quit that stops being true for free: sync can bring back a different
// version of the note from another device, and adopting a stale entry over it
// would overwrite work with a drawing from before it. Comparing the source is
// how an entry proves the file has not moved on.
interface HeldRescue {
	savedAt: number;
	source: string;
	data: InkBlockData;
}

interface StoredRescue {
	savedAt: number;
	source: string;
	// Through the block format's own encoder, so there is one definition of
	// what a stored block looks like, and so anything this cannot parse back
	// is discarded rather than restored half-read.
	block: string;
}

function rescueKey(notePath: string, blockId: string): string {
	return `${RESCUE_PREFIX}${notePath}::${blockId}`;
}

function readStored(raw: string): StoredRescue | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
	const entry = parsed as Record<string, unknown>;
	if (typeof entry.savedAt !== 'number' || !Number.isFinite(entry.savedAt)) return undefined;
	if (typeof entry.source !== 'string' || typeof entry.block !== 'string') return undefined;
	return { savedAt: entry.savedAt, source: entry.source, block: entry.block };
}

export class InkRescueStore {
	// Everything this session is holding. Read before storage, because within
	// a session it is the newer of the two by construction — and because a
	// storage that refused the write has nothing to offer anyway.
	private readonly memory = new Map<string, HeldRescue>();

	constructor(
		private readonly storage: RescueStorage | null,
		private readonly now: () => number = Date.now,
	) {}

	// Called before every write, so that every path which can end without
	// writing — a note closed mid-debounce, a fence that has moved, a vault
	// error — leaves the drawing somewhere rather than only on screen.
	hold(notePath: string, blockId: string, data: InkBlockData, source: string): void {
		this.memory.set(rescueKey(notePath, blockId), { savedAt: this.now(), source: source.trim(), data });
	}

	// Called when a write has actually failed, which is the only point at
	// which surviving a quit is worth a synchronous disk write.
	persist(notePath: string, blockId: string): void {
		const key = rescueKey(notePath, blockId);
		const held = this.memory.get(key);
		if (!held || !this.storage) return;
		const payload = JSON.stringify({
			savedAt: held.savedAt,
			source: held.source,
			block: serializeInkBlock(held.data),
		} satisfies StoredRescue);
		if (this.trySet(key, payload)) return;

		// Full. The newest drawing is the one most likely to be wanted back,
		// so make room for it rather than refusing it — oldest first, and only
		// ever out of our own entries.
		for (const victim of this.ourKeysOldestFirst()) {
			if (victim === key) continue;
			this.drop(victim);
			if (this.trySet(key, payload)) return;
		}
	}

	// The drawing held for this block, if it is still safe to adopt.
	//
	// `source` is the block's body as it stands in the file right now.
	// Everything here is a reason to say no; there is no path that returns
	// ink of uncertain provenance.
	get(notePath: string, blockId: string, source: string): InkBlockData | undefined {
		const key = rescueKey(notePath, blockId);
		const held = this.memory.get(key) ?? this.loadHeld(key);
		if (!held) return undefined;

		if (this.now() - held.savedAt > RESCUE_MAX_AGE_MS) return this.reject(key);
		if (held.source !== source.trim()) return this.reject(key);
		return held.data;
	}

	forget(notePath: string, blockId: string): void {
		this.drop(rescueKey(notePath, blockId));
	}

	// An entry for a block nobody opens again is never read, so no read can
	// ever expire it, and it holds its bytes until the browser's storage is
	// cleared. Ink blocks are large and localStorage is not, so the sweep is
	// what keeps those two facts from meeting.
	purgeExpired(): void {
		for (const key of this.ourKeys()) {
			const held = this.loadHeld(key);
			if (!held || this.now() - held.savedAt > RESCUE_MAX_AGE_MS) this.drop(key);
		}
	}

	private reject(key: string): undefined {
		this.drop(key);
		return undefined;
	}

	private drop(key: string): void {
		this.memory.delete(key);
		if (!this.storage) return;
		try {
			this.storage.removeItem(key);
		} catch {
			// Nothing useful to do, and nothing depends on it: the held copy
			// is gone, which is what the caller asked for.
		}
	}

	private loadHeld(key: string): HeldRescue | undefined {
		if (!this.storage) return undefined;
		let raw: string | null;
		try {
			raw = this.storage.getItem(key);
		} catch {
			return undefined;
		}
		if (raw === null) return undefined;
		const stored = readStored(raw);
		if (!stored) return undefined;

		// Parsed rather than trusted: an entry this build cannot fully read is
		// exactly the kind that would restore a drawing half-read, and the
		// block format's own refusal to guess is the right one to borrow.
		const { data, malformed } = parseInkBlock(stored.block);
		if (malformed) return undefined;
		return { savedAt: stored.savedAt, source: stored.source, data };
	}

	private trySet(key: string, payload: string): boolean {
		if (!this.storage) return false;
		try {
			this.storage.setItem(key, payload);
			return true;
		} catch {
			return false;
		}
	}

	private ourKeys(): string[] {
		if (!this.storage) return [];
		const keys: string[] = [];
		try {
			// Snapshotted before anything is removed: the index-based Storage
			// API renumbers as entries go, so deleting while walking it skips.
			for (let index = 0; index < this.storage.length; index++) {
				const key = this.storage.key(index);
				if (key !== null && key.startsWith(RESCUE_PREFIX)) keys.push(key);
			}
		} catch {
			return keys;
		}
		return keys;
	}

	private ourKeysOldestFirst(): string[] {
		return this.ourKeys()
			.map((key) => ({ key, savedAt: this.loadHeld(key)?.savedAt ?? 0 }))
			.sort((a, b) => a.savedAt - b.savedAt)
			.map((entry) => entry.key);
	}
}

// localStorage, when there is one to have. Reaching for it can itself throw —
// a browser set to block site data does not merely return null — so even that
// is guarded, and a failure degrades to the in-memory behaviour this replaced
// rather than to no recovery at all.
//
// Raw localStorage rather than App#saveLocalStorage, which lint prefers and
// which scopes its keys per vault. Two reasons. It is `@since 1.8.7` and this
// plugin's minAppVersion is 1.4.4, so it cannot be relied on; and it offers
// no way to enumerate keys, which purgeExpired needs — an entry is swept
// precisely because nothing will ever ask for it by name. The per-vault
// scoping it would buy is worth little here anyway: an entry is keyed by a
// random block id, so two vaults colliding would need the same random id.
export function browserRescueStorage(): RescueStorage | null {
	try {
		return window.localStorage ?? null;
	} catch {
		return null;
	}
}
