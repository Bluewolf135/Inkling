import { describe, expect, it } from 'vitest';
import { InkRescueStore, RESCUE_MAX_AGE_MS, type RescueStorage } from '../../src/markdown/inkRecovery';
import { emptyInkBlock, serializeInkBlock, type InkBlockData } from '../../src/markdown/inkBlockFormat';
import type { Annotation } from '../../src/annotate/types';

// The buffer standing between a save that could not write and the re-render
// that would otherwise throw the drawing away. It used to be a Map, so it
// did not survive quitting Obsidian; it reaches localStorage now, which
// brings a hazard the Map never had — an entry can outlive the note it
// belongs to and reappear over work done on another device. The source check
// is what stops that, and it is most of what is covered here.
//
// Two steps rather than one, and the split is the point: holding is what
// every save does and has to be free, while persisting is what a *failed*
// save does and can afford a synchronous write.

// A localStorage a test can fill up, break, or watch.
class FakeStorage implements RescueStorage {
	private readonly entries = new Map<string, string>();
	private failGet = false;

	constructor(private readonly capacity = Infinity) {}

	get length(): number {
		return this.entries.size;
	}
	key(index: number): string | null {
		return Array.from(this.entries.keys())[index] ?? null;
	}
	getItem(key: string): string | null {
		if (this.failGet) throw new Error('SecurityError');
		return this.entries.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		const others = Array.from(this.entries.entries())
			.filter(([existing]) => existing !== key)
			.reduce((total, [k, v]) => total + k.length + v.length, 0);
		if (others + key.length + value.length > this.capacity) throw new Error('QuotaExceededError');
		this.entries.set(key, value);
	}
	removeItem(key: string): void {
		this.entries.delete(key);
	}

	breakReads(): void {
		this.failGet = true;
	}
	keys(): string[] {
		return Array.from(this.entries.keys());
	}
}

function stroke(x: number): Annotation {
	return {
		id: `a-${x}`,
		kind: 'stroke',
		tool: 'pen',
		color: '#1e1e1e',
		width: 2,
		points: [
			{ x, y: 0 },
			{ x: x + 10, y: 10 },
		],
	};
}

function blockWith(...annotations: Annotation[]): InkBlockData {
	return { ...emptyInkBlock(), id: 'ink-1', annotations };
}

describe('InkRescueStore', () => {
	it('gives back a drawing it is holding', () => {
		const store = new InkRescueStore(new FakeStorage());
		const source = serializeInkBlock(blockWith());

		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);

		expect(store.get('Note.md', 'ink-1', source)?.annotations).toHaveLength(1);
	});

	it('writes nothing to storage until a save has actually failed', () => {
		// Every save holds; only a failed one persists. A block can carry a
		// megabyte of stroke JSON and localStorage is synchronous, so writing
		// on every save would put that on the main thread once a second while
		// the pen is still moving.
		const storage = new FakeStorage();
		const store = new InkRescueStore(storage);

		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), serializeInkBlock(blockWith()));

		expect(storage.keys()).toHaveLength(0);
	});

	it('gives back a persisted drawing in a later session', () => {
		const storage = new FakeStorage();
		const data = blockWith(stroke(1), stroke(2));
		const source = serializeInkBlock(blockWith(stroke(1)));

		const first = new InkRescueStore(storage);
		first.hold('Note.md', 'ink-1', data, source);
		first.persist('Note.md', 'ink-1');

		// A different store entirely: the first is gone, as it would be after
		// quitting Obsidian.
		expect(new InkRescueStore(storage).get('Note.md', 'ink-1', source)?.annotations).toHaveLength(2);
	});

	it('discards a drawing whose block has changed since it was held', () => {
		const store = new InkRescueStore(new FakeStorage());
		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), serializeInkBlock(blockWith()));

		// What sync brought back from another device is not what the failed
		// save was working from, so the held drawing is not newer than the file.
		const elsewhere = serializeInkBlock(blockWith(stroke(9)));

		expect(store.get('Note.md', 'ink-1', elsewhere)).toBeUndefined();
	});

	it('discards a persisted drawing whose block has changed since', () => {
		const storage = new FakeStorage();
		const first = new InkRescueStore(storage);
		first.hold('Note.md', 'ink-1', blockWith(stroke(1)), serializeInkBlock(blockWith()));
		first.persist('Note.md', 'ink-1');

		const elsewhere = serializeInkBlock(blockWith(stroke(9)));

		expect(new InkRescueStore(storage).get('Note.md', 'ink-1', elsewhere)).toBeUndefined();
	});

	it('forgets a discarded drawing rather than offering it again', () => {
		const storage = new FakeStorage();
		const store = new InkRescueStore(storage);
		const source = serializeInkBlock(blockWith());
		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		store.persist('Note.md', 'ink-1');

		store.get('Note.md', 'ink-1', serializeInkBlock(blockWith(stroke(9))));

		expect(store.get('Note.md', 'ink-1', source)).toBeUndefined();
		expect(storage.keys()).toHaveLength(0);
	});

	it('discards a drawing older than the expiry window', () => {
		const storage = new FakeStorage();
		let now = 1_000_000;
		const source = serializeInkBlock(blockWith());
		const first = new InkRescueStore(storage, () => now);
		first.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		first.persist('Note.md', 'ink-1');

		now += RESCUE_MAX_AGE_MS + 1;

		expect(new InkRescueStore(storage, () => now).get('Note.md', 'ink-1', source)).toBeUndefined();
	});

	it('keeps two blocks in one note apart', () => {
		const store = new InkRescueStore(new FakeStorage());
		const source = serializeInkBlock(blockWith());
		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		store.hold('Note.md', 'ink-2', blockWith(stroke(2), stroke(3)), source);

		expect(store.get('Note.md', 'ink-1', source)?.annotations).toHaveLength(1);
		expect(store.get('Note.md', 'ink-2', source)?.annotations).toHaveLength(2);
	});

	it('keeps the same block id in two notes apart', () => {
		const store = new InkRescueStore(new FakeStorage());
		const source = serializeInkBlock(blockWith());
		store.hold('A.md', 'ink-1', blockWith(stroke(1)), source);

		expect(store.get('B.md', 'ink-1', source)).toBeUndefined();
	});

	it('drops an entry once its block has saved', () => {
		const storage = new FakeStorage();
		const store = new InkRescueStore(storage);
		const source = serializeInkBlock(blockWith());
		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		store.persist('Note.md', 'ink-1');

		store.forget('Note.md', 'ink-1');

		expect(store.get('Note.md', 'ink-1', source)).toBeUndefined();
		expect(storage.keys()).toHaveLength(0);
	});

	it('still holds the drawing for this session when storage refuses to write', () => {
		// A private window, or a quota nothing will fit in. Losing the
		// across-a-quit guarantee is acceptable; losing the drawing is not.
		const store = new InkRescueStore(new FakeStorage(0));
		const source = serializeInkBlock(blockWith());

		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		store.persist('Note.md', 'ink-1');

		expect(store.get('Note.md', 'ink-1', source)?.annotations).toHaveLength(1);
	});

	it('survives a storage that throws on every read', () => {
		const storage = new FakeStorage();
		const store = new InkRescueStore(storage);
		const source = serializeInkBlock(blockWith());
		storage.breakReads();

		expect(() => store.get('Note.md', 'ink-1', source)).not.toThrow();
		expect(store.get('Note.md', 'ink-1', source)).toBeUndefined();
	});

	it('works with no storage at all', () => {
		const store = new InkRescueStore(null);
		const source = serializeInkBlock(blockWith());
		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		store.persist('Note.md', 'ink-1');

		expect(store.get('Note.md', 'ink-1', source)?.annotations).toHaveLength(1);
	});

	it('evicts the oldest entry to make room for a new one', () => {
		// Ink blocks are large and localStorage is small, so a full store has
		// to lose the least recent drawing rather than refuse the newest.
		const oldest = blockWith(stroke(1));
		const source = serializeInkBlock(blockWith());
		const oneEntry = JSON.stringify({ savedAt: 0, source, block: serializeInkBlock(oldest) }).length + 60;
		const storage = new FakeStorage(oneEntry * 2);
		let now = 1_000;
		const store = new InkRescueStore(storage, () => now);

		const keep = (id: string, data: InkBlockData): void => {
			store.hold('Note.md', id, data, source);
			store.persist('Note.md', id);
			now += 1_000;
		};
		keep('ink-1', oldest);
		keep('ink-2', blockWith(stroke(2)));
		keep('ink-3', blockWith(stroke(3)));

		expect(new InkRescueStore(storage, () => now).get('Note.md', 'ink-1', source)).toBeUndefined();
		expect(new InkRescueStore(storage, () => now).get('Note.md', 'ink-3', source)?.annotations).toHaveLength(1);
	});

	it('sweeps expired entries out of storage without being asked for them', () => {
		// An entry for a block nobody opens again is never read, so no read can
		// ever expire it. Without a sweep it holds its bytes forever.
		const storage = new FakeStorage();
		let now = 1_000_000;
		const source = serializeInkBlock(blockWith());
		const stale = new InkRescueStore(storage, () => now);
		stale.hold('Gone.md', 'ink-old', blockWith(stroke(1)), source);
		stale.persist('Gone.md', 'ink-old');

		now += RESCUE_MAX_AGE_MS + 1;
		const fresh = new InkRescueStore(storage, () => now);
		fresh.hold('Live.md', 'ink-new', blockWith(stroke(2)), source);
		fresh.persist('Live.md', 'ink-new');

		new InkRescueStore(storage, () => now).purgeExpired();

		expect(storage.keys()).toHaveLength(1);
		expect(new InkRescueStore(storage, () => now).get('Live.md', 'ink-new', source)?.annotations).toHaveLength(1);
	});

	it('leaves entries belonging to anything else alone', () => {
		const storage = new FakeStorage();
		storage.setItem('some-other-plugin', 'not ours');
		const store = new InkRescueStore(storage, () => 1);
		store.hold('Note.md', 'ink-1', blockWith(stroke(1)), serializeInkBlock(blockWith()));
		store.persist('Note.md', 'ink-1');

		store.purgeExpired();

		expect(storage.getItem('some-other-plugin')).toBe('not ours');
	});

	it('discards an entry it can no longer read', () => {
		// Left by a previous session: hand-edited, half-written by a crash, or
		// from a format this build does not know.
		const storage = new FakeStorage();
		const source = serializeInkBlock(blockWith());
		const first = new InkRescueStore(storage);
		first.hold('Note.md', 'ink-1', blockWith(stroke(1)), source);
		first.persist('Note.md', 'ink-1');
		storage.setItem(storage.keys()[0] ?? '', '{ this is not json');

		expect(new InkRescueStore(storage).get('Note.md', 'ink-1', source)).toBeUndefined();
	});
});
