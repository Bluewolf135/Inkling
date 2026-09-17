import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { decodeStrokes } from '../../src/markdown/inkFileCodec';
import { emptyFileBlock, parseInkFile, readInkFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { InkFileStore, type BlockBase } from '../../src/markdown/inkFileStore';
import { inkFileText, memoryInkFileIO, type MemoryInkFileIO } from '../harness/inkFileIO';

// Spied on rather than replaced, so every test but one runs the real codec.
vi.mock('../../src/markdown/inkFileCodec', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/markdown/inkFileCodec')>();
	return { ...actual, decodeStrokes: vi.fn(actual.decodeStrokes) };
});

const PATH = 'Attachments/Physics.ink';

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

async function opened(blocks: Record<string, unknown>): Promise<{ io: MemoryInkFileIO; store: InkFileStore }> {
	const io = memoryInkFileIO({ [PATH]: await inkFileText(blocks) });
	const store = new InkFileStore(PATH, io);
	await store.load();
	return { io, store };
}

function baseOf(store: InkFileStore, id: string): BlockBase {
	const state = store.blockState(id);
	if (state.kind !== 'decoded') throw new Error(`block ${id} is ${state.kind}`);
	return { block: state.block, revision: state.revision };
}

async function idsOnDisk(io: MemoryInkFileIO, id: string): Promise<string[]> {
	const read = parseInkFile(io.files.get(PATH) ?? '');
	if (read.kind !== 'readable') throw new Error(`file on disk is ${read.kind}`);
	const block = await readInkFileBlock(read.contents.blocks.get(id));
	if (block.kind !== 'decoded') throw new Error(`block ${id} on disk is ${block.kind}`);
	return block.block.annotations.map((a) => a.id);
}

const writer = {};

describe('saving a block', () => {
	it('writes it to the file and moves its revision on', async () => {
		const { io, store } = await opened({ a: holding() });
		const base = baseOf(store, 'a');

		const outcome = await store.updateBlock('a', writer, holding('s1'), base);

		expect(outcome).toMatchObject({ kind: 'written', merged: false });
		expect(await idsOnDisk(io, 'a')).toEqual(['s1']);
		expect(baseOf(store, 'a').revision).not.toBe(base.revision);
	});

	it('tells other blocks, naming who saved', async () => {
		const { store } = await opened({ a: holding() });
		const heard: Array<[unknown, unknown]> = [];
		store.subscribe((change, origin) => heard.push([change, origin]));

		await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));

		expect(heard).toEqual([[new Set(['a']), writer]]);
	});

	it('lands two blocks saved in the same moment', async () => {
		const { io, store } = await opened({ a: holding(), b: holding() });

		await Promise.all([
			store.updateBlock('a', {}, holding('s1'), baseOf(store, 'a')),
			store.updateBlock('b', {}, holding('s2'), baseOf(store, 'b')),
		]);

		expect(await idsOnDisk(io, 'a')).toEqual(['s1']);
		expect(await idsOnDisk(io, 'b')).toEqual(['s2']);
	});

	it('collapses a save superseded while it was still queued', async () => {
		const { io, store } = await opened({ a: holding() });
		const base = baseOf(store, 'a');

		const first = store.updateBlock('a', writer, holding('s1'), base);
		const second = store.updateBlock('a', writer, holding('s1', 's2'), base);
		const outcomes = await Promise.all([first, second]);

		expect(io.writes).toBe(1);
		expect(outcomes[0]).toEqual(outcomes[1]);
		expect(await idsOnDisk(io, 'a')).toEqual(['s1', 's2']);
	});

	it('does not collapse two different blocks saving the same block id', async () => {
		const { io, store } = await opened({ a: holding() });
		const base = baseOf(store, 'a');

		await Promise.all([
			store.updateBlock('a', { copy: 1 }, holding('mine'), base),
			store.updateBlock('a', { copy: 2 }, holding('yours'), base),
		]);

		expect(io.writes).toBe(2);
		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['mine', 'yours']);
	});

	it('verifies the first write after opening, and only that one', async () => {
		const { io, store } = await opened({ a: holding() });
		const readsAtOpen = io.reads;

		await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));
		expect(io.reads).toBe(readsAtOpen + 1);

		await store.updateBlock('a', writer, holding('s1', 's2'), baseOf(store, 'a'));
		expect(io.reads).toBe(readsAtOpen + 1);
	});
});

describe('a save that lands after the file changed elsewhere', () => {
	it('merges with a change it had not heard about yet', async () => {
		const { io, store } = await opened({ a: holding('shared') });
		const base = baseOf(store, 'a');
		// Changed on disk with no event: the sync landed and the vault has not
		// said so yet.
		const theirs = await inkFileText({ a: holding('shared', 'theirs') });
		io.beforeReplace = () => io.files.set(PATH, theirs);

		const outcome = await store.updateBlock('a', writer, holding('shared', 'ours'), base);

		expect(outcome).toMatchObject({ kind: 'written', merged: true });
		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['ours', 'shared', 'theirs']);
	});

	it('merges with a change it has already re-read', async () => {
		const { io, store } = await opened({ a: holding('shared') });
		const base = baseOf(store, 'a');
		io.files.set(PATH, await inkFileText({ a: holding('shared', 'theirs') }));
		store.fileChanged();
		await store.whenIdle();

		const outcome = await store.updateBlock('a', writer, holding('shared', 'ours'), base);

		expect(outcome).toMatchObject({ kind: 'written', merged: true });
		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['ours', 'shared', 'theirs']);
	});

	it('honours an erasure made here', async () => {
		const { io, store } = await opened({ a: holding('keep', 'erase') });
		const base = baseOf(store, 'a');
		io.files.set(PATH, await inkFileText({ a: holding('keep', 'erase', 'theirs') }));

		await store.updateBlock('a', writer, holding('keep'), base);

		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['keep', 'theirs']);
	});

	it('keeps a different block changed elsewhere', async () => {
		const { io, store } = await opened({ a: holding(), b: holding() });
		io.files.set(PATH, await inkFileText({ a: holding(), b: holding('theirs') }));

		await store.updateBlock('a', writer, holding('ours'), baseOf(store, 'a'));

		expect(await idsOnDisk(io, 'a')).toEqual(['ours']);
		expect(await idsOnDisk(io, 'b')).toEqual(['theirs']);
	});
});

describe('refusing', () => {
	it.each([
		['from a newer version', '{"version":9,"blocks":{}}'],
		['damaged', '{"version":1,"blocks":{'],
	])('never writes a file %s', async (_label, text) => {
		const io = memoryInkFileIO({ [PATH]: text });
		const store = new InkFileStore(PATH, io);
		await store.load();

		const outcome = await store.updateBlock('a', writer, holding('s1'), { block: holding(), revision: 0 });

		expect(outcome).toEqual({ kind: 'refused', reason: 'not-writable' });
		expect(io.files.get(PATH)).toBe(text);
	});

	it('never creates a file a save expected to find', async () => {
		const io = memoryInkFileIO();
		const store = new InkFileStore(PATH, io);
		await store.load();

		const outcome = await store.updateBlock('a', writer, holding('s1'), { block: holding(), revision: 0 });

		expect(outcome).toEqual({ kind: 'refused', reason: 'not-writable' });
		expect(io.files.has(PATH)).toBe(false);
	});

	it('refuses a block the file does not hold', async () => {
		const { store } = await opened({ a: holding() });
		expect(await store.updateBlock('b', writer, holding('s1'), { block: holding(), revision: 0 })).toEqual({
			kind: 'refused',
			reason: 'block-absent',
		});
	});

	it('refuses a block it could not decode', async () => {
		const { io, store } = await opened({ a: { width: 800, height: 450, strokes: '%%%%' } });
		const before = io.files.get(PATH);
		expect(await store.updateBlock('a', writer, holding('s1'), { block: holding(), revision: 0 })).toEqual({
			kind: 'refused',
			reason: 'block-unreadable',
		});
		expect(io.files.get(PATH)).toBe(before);
	});

	it('refuses a file that went bad on disk since it was read', async () => {
		const { io, store } = await opened({ a: holding() });
		io.files.set(PATH, '{"version":1,"blocks":{"a":');

		const outcome = await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));

		expect(outcome).toEqual({ kind: 'refused', reason: 'not-writable' });
		expect(io.files.get(PATH)).toBe('{"version":1,"blocks":{"a":');
	});

	it('refuses a block whose encoding does not decode back to what was encoded', async () => {
		const { io, store } = await opened({ a: holding() });
		const before = io.files.get(PATH);
		vi.mocked(decodeStrokes).mockResolvedValueOnce({ kind: 'decoded', annotations: [] });

		const outcome = await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));

		expect(outcome).toEqual({ kind: 'refused', reason: 'encoding-mismatch' });
		expect(io.files.get(PATH)).toBe(before);
	});

	it('reports a write that failed and leaves the file as it was', async () => {
		const { io, store } = await opened({ a: holding() });
		const before = io.files.get(PATH);
		io.failNextWrite = true;

		expect(await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'))).toEqual({ kind: 'refused', reason: 'failed' });
		expect(io.files.get(PATH)).toBe(before);
	});

	// The failure a backgrounded app on mobile is killed into.
	it('notices a write cut short, and will not write over what it left', async () => {
		const { io, store } = await opened({ a: holding() });
		io.truncateNextWrite = true;

		expect(await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'))).toEqual({ kind: 'refused', reason: 'failed' });
		const truncated = io.files.get(PATH);

		expect(await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'))).toEqual({
			kind: 'refused',
			reason: 'not-writable',
		});
		expect(io.files.get(PATH)).toBe(truncated);
	});

	// A caption is the one part of the file that can hold something other than
	// ASCII, and a size compared in characters would call every such save cut
	// short.
	it('does not mistake a caption with an accent for a write cut short', async () => {
		const { store } = await opened({ a: holding() });
		const outcome = await store.updateBlock('a', writer, { ...holding('s1'), caption: 'réaction normale' }, baseOf(store, 'a'));
		expect(outcome.kind).toBe('written');
	});
});

describe('carrying through', () => {
	it('keeps every block and key it could not read when another block is saved', async () => {
		const undecodable = { width: 800, height: 450, strokes: 'bm90IGRlZmxhdGU=' };
		const unsupported = { width: 800, height: 450, strokes: 'AAAA', codec: 'zstd' };
		const io = memoryInkFileIO({
			[PATH]: await inkFileText({ edited: holding(), undecodable, unsupported }, [['device', 'tablet']]),
		});
		const store = new InkFileStore(PATH, io);
		await store.load();

		await store.updateBlock('edited', writer, holding('s1'), baseOf(store, 'edited'));

		const text = io.files.get(PATH) ?? '';
		expect(text).toContain(`"undecodable": ${JSON.stringify(undecodable)}`);
		expect(text).toContain(`"unsupported": ${JSON.stringify(unsupported)}`);
		expect(text).toContain('"device": "tablet"');
	});
});

describe('creating a block', () => {
	it('creates the file for the first block', async () => {
		const io = memoryInkFileIO();
		const store = new InkFileStore(PATH, io);
		await store.load();

		expect(await store.createBlock('a', emptyFileBlock())).toMatchObject({ kind: 'written' });
		expect(store.status()).toEqual({ kind: 'readable' });
		expect(await idsOnDisk(io, 'a')).toEqual([]);
	});

	it('adds to a file that exists', async () => {
		const { io, store } = await opened({ a: holding('s1') });
		await store.createBlock('b', emptyFileBlock());
		expect(await idsOnDisk(io, 'a')).toEqual(['s1']);
		expect(await idsOnDisk(io, 'b')).toEqual([]);
	});

	it('refuses an id the file already holds', async () => {
		const { store } = await opened({ a: holding('s1') });
		expect(await store.createBlock('a', emptyFileBlock())).toEqual({ kind: 'refused', reason: 'block-exists' });
	});

	it('refuses a file it cannot read', async () => {
		const io = memoryInkFileIO({ [PATH]: '{"version":1,"blocks":{' });
		const store = new InkFileStore(PATH, io);
		await store.load();
		expect(await store.createBlock('a', emptyFileBlock())).toEqual({ kind: 'refused', reason: 'not-writable' });
	});
});
