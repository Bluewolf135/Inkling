// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { emptyFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { InkFileStore, InkFileStores, type StoreChange } from '../../src/markdown/inkFileStore';
import { inkFileText, memoryInkFileIO } from '../harness/inkFileIO';

const PATH = 'Attachments/Physics.ink';

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

function record(store: InkFileStore): StoreChange[] {
	const changes: StoreChange[] = [];
	store.subscribe((change) => changes.push(change));
	return changes;
}

describe('opening an ink file', () => {
	it('reports a file that does not exist as absent', async () => {
		const store = new InkFileStore(PATH, memoryInkFileIO());
		await store.load();
		expect(store.status()).toEqual({ kind: 'absent' });
		expect(store.blockState('a')).toEqual({ kind: 'absent' });
	});

	it('decodes each block and says which it could not', async () => {
		const io = memoryInkFileIO({
			[PATH]: await inkFileText({
				good: holding('s1'),
				broken: { width: 800, height: 450, strokes: '%%%%' },
				foreign: { width: 800, height: 450, strokes: 'AAAA', codec: 'zstd' },
			}),
		});
		const store = new InkFileStore(PATH, io);
		await store.load();

		expect(store.status()).toEqual({ kind: 'readable' });
		const good = store.blockState('good');
		expect(good.kind === 'decoded' && good.block.annotations.map((a) => a.id)).toEqual(['s1']);
		expect(good.kind === 'decoded' && good.strokes.length).toBeGreaterThan(0);
		expect(store.blockState('broken')).toEqual({ kind: 'undecodable' });
		expect(store.blockState('foreign')).toEqual({ kind: 'unsupported', codec: 'zstd' });
		expect(store.blockState('elsewhere')).toEqual({ kind: 'absent' });
	});

	it('reports a file from a newer version as that, not as damage', async () => {
		const store = new InkFileStore(PATH, memoryInkFileIO({ [PATH]: '{"version":7,"blocks":{}}' }));
		await store.load();
		expect(store.status()).toEqual({ kind: 'from-future', version: 7 });
	});

	it('reports a file it cannot parse as damaged', async () => {
		const store = new InkFileStore(PATH, memoryInkFileIO({ [PATH]: '{"version":1,"blocks":{"a": {' }));
		await store.load();
		expect(store.status()).toEqual({ kind: 'damaged' });
	});

	it('loads once however many blocks ask', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding() }) });
		const store = new InkFileStore(PATH, io);
		await Promise.all([store.load(), store.load(), store.load()]);
		expect(io.reads).toBe(1);
	});
});

describe('a change made elsewhere', () => {
	it('re-reads only the blocks that changed, and says which', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1'), b: holding('s2') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const before = store.blockState('a');
		const changes = record(store);

		io.files.set(PATH, await inkFileText({ a: holding('s1'), b: holding('s2', 's3') }));
		store.fileChanged();
		await store.whenIdle();

		expect(changes).toEqual([new Set(['b'])]);
		expect(store.blockState('a')).toEqual(before);
		const b = store.blockState('b');
		expect(b.kind === 'decoded' && b.block.annotations).toHaveLength(2);
	});

	it('says nothing when the file holds what it already had', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		store.fileChanged();
		await store.whenIdle();

		expect(changes).toEqual([]);
	});

	it('reports a block that disappeared from the file', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1'), b: holding() }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		io.files.set(PATH, await inkFileText({ a: holding('s1') }));
		store.fileChanged();
		await store.whenIdle();

		expect(changes).toEqual([new Set(['b'])]);
		expect(store.blockState('b')).toEqual({ kind: 'absent' });
	});

	// A sync caught mid-write leaves a partial file on disk for a moment. What
	// the session already holds is the better copy, and nothing should stop.
	it('does not let a damaged read displace a good one', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		io.files.set(PATH, '{"version":1,"blocks":{"a":');
		store.fileChanged();
		await store.whenIdle();

		expect(store.status()).toEqual({ kind: 'readable' });
		expect(store.blockState('a').kind).toBe('decoded');
		expect(changes).toEqual([]);
	});

	it('goes absent when the file is deleted', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		io.files.delete(PATH);
		store.fileDeleted();
		await store.whenIdle();

		expect(store.status()).toEqual({ kind: 'absent' });
		expect(changes).toEqual(['all']);
	});
});

describe('sharing stores', () => {
	it('hands every block naming a file the same store', () => {
		const stores = new InkFileStores(memoryInkFileIO());
		expect(stores.acquire(PATH)).toBe(stores.acquire(PATH));
	});

	it('lets a store go once nothing uses it and its queue is empty', async () => {
		const stores = new InkFileStores(memoryInkFileIO());
		const store = stores.acquire(PATH);
		stores.acquire(PATH);
		stores.release(PATH);
		await store.whenIdle();
		expect(stores.isHeld(PATH)).toBe(true);

		stores.release(PATH);
		await store.whenIdle();
		await Promise.resolve();
		expect(stores.isHeld(PATH)).toBe(false);
	});

	it('routes a change to the store for that path only', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding() }), 'Other.ink': await inkFileText({}) });
		const stores = new InkFileStores(io);
		const store = stores.acquire(PATH);
		await store.load();
		const readsBefore = io.reads;

		stores.fileChanged('Other.ink');
		await store.whenIdle();
		expect(io.reads).toBe(readsBefore);

		stores.fileChanged(PATH);
		await store.whenIdle();
		expect(io.reads).toBe(readsBefore + 1);
	});

	// Phase 4 rewrites the fences. Until then a renamed file is, to a fence
	// naming its old path, a missing one.
	it('treats a renamed file as gone from its old path', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding() }) });
		const stores = new InkFileStores(io);
		const store = stores.acquire(PATH);
		await store.load();

		stores.fileRenamed(PATH, 'Attachments/Renamed.ink');
		await store.whenIdle();
		expect(store.status()).toEqual({ kind: 'absent' });
	});
});

// A read that throws is not the file saying anything: on a phone it is most
// often a file still being fetched, or locked for a moment by sync.
describe('a file that could not be read when opened', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	async function openedFailingOnce(): Promise<InkFileStore> {
		vi.useFakeTimers();
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const files = io.files;
		let failures = 1;
		io.read = async (path) => {
			if (failures > 0) {
				failures -= 1;
				throw new Error('file is locked');
			}
			return files.get(path) ?? null;
		};
		const store = new InkFileStore(PATH, io);
		await store.load();
		return store;
	}

	it('is refused at first', async () => {
		const store = await openedFailingOnce();
		expect(store.status()).toEqual({ kind: 'damaged' });
	});

	it('is read again without waiting for the file to change', async () => {
		const store = await openedFailingOnce();
		const changes = record(store);

		await vi.advanceTimersByTimeAsync(10_000);
		await store.whenIdle();

		expect(store.status()).toEqual({ kind: 'readable' });
		expect(store.blockState('a').kind).toBe('decoded');
		expect(changes).toContain('all');
	});
});
