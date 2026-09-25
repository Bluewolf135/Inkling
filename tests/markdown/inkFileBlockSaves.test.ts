// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { emptyFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { inkFenceMarkdown } from '../../src/markdown/inkFence';
import { inkFileText } from '../harness/inkFileIO';
import { mountNote, type TestNote } from '../harness/note';

// What an ink-file block does when its file will not simply take a save: a
// sync landing mid-save, a disk that keeps failing, a file gone bad. In each
// the drawing on screen is the only copy of the user's work, and nothing the
// file says may be put over it until it has been saved.

const INK = 'Ink/Physics.ink';
const STROKE: Array<[number, number]> = [
	[100, 100],
	[150, 120],
	[200, 100],
];
const RETRY_MS = 2000;

let note: TestNote;
// Fresh per test: the rescue store is module-level. See inkFileBlockIntegration.test.ts.
let blockId = 'a';
let nextBlockId = 0;

beforeEach(() => {
	document.body.innerHTML = '';
	window.localStorage.clear();
	blockId = `saves-${++nextBlockId}`;
});

afterEach(() => {
	vi.useRealTimers();
});

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 30, y: 40 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

async function open(block: InkFileBlock): Promise<TestNote> {
	const contents = ['# Physics', '', inkFenceMarkdown({ file: INK, id: blockId, extra: [] }), ''].join('\n');
	const mounted = mountNote({ path: 'Physics.md', contents, inkFiles: { [INK]: await inkFileText({ [blockId]: block }) }, openInEditor: true });
	await mounted.settle();
	return mounted;
}

function banner(): string | null {
	return note.block(0).el.querySelector('.inkling-ink-block-banner-text')?.textContent ?? null;
}

function canvasRatio(): number {
	const canvas = note.block(0).el.querySelector('canvas');
	if (!canvas) throw new Error('no canvas mounted');
	return canvas.height / canvas.width;
}

describe('the drawing surface', () => {
	it('takes the height the ink file gives the block, even when it mounted before the file was read', async () => {
		note = await open({ ...holding(), height: 280 });
		expect(canvasRatio()).toBeCloseTo(280 / 800);
	});

	it('follows a height changed on another device', async () => {
		note = await open({ ...holding(), height: 280 });
		await note.syncInkFile(INK, await inkFileText({ [blockId]: { ...holding(), height: 600 } }));
		expect(canvasRatio()).toBeCloseTo(600 / 800);
	});
});

describe('a save retried because the file kept changing under it', () => {
	it('keeps the stroke it was saving, alongside the other side', async () => {
		note = await open(holding());
		const versions = [
			await inkFileText({ [blockId]: holding('theirs-1') }),
			await inkFileText({ [blockId]: holding('theirs-2') }),
			await inkFileText({ [blockId]: holding('theirs-3') }),
		];
		note.interceptInkWrites((path) => {
			const next = versions.shift();
			if (next) note.setInkFile(path, next);
			else note.interceptInkWrites(null);
		});

		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();
		await note.advance(RETRY_MS);
		await note.settle();

		expect(await note.inkStrokeCount(INK, blockId)).toBe(2);
	});
});

describe('a drawing held because it could not be saved', () => {
	it('survives its file coming back with a different version of the block', async () => {
		note = await open(holding());
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.deleteInkFile(INK);
		await note.flushWrites();

		await note.syncInkFile(INK, await inkFileText({ [blockId]: holding('theirs') }));
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, blockId)).toBe(2);
	});

	it('survives a change from elsewhere after every retry failed, and is saved with it', async () => {
		note = await open(holding());
		note.interceptInkWrites(() => {
			throw new Error('disk full');
		});
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();
		for (let retry = 0; retry < 3; retry++) {
			await note.advance(RETRY_MS);
			await note.settle();
		}
		note.interceptInkWrites(null);

		await note.syncInkFile(INK, await inkFileText({ [blockId]: holding('theirs') }));
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, blockId)).toBe(2);
	});
});

describe('a save that finds the ink file gone bad', () => {
	const DAMAGED = '{"version":1,"blocks":{';

	beforeEach(async () => {
		note = await open(holding());
		note.interceptInkWrites((path) => {
			note.setInkFile(path, DAMAGED);
			note.interceptInkWrites(null);
		});
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();
	});

	it('says so', () => {
		expect(banner()).toContain('could not read the ink file');
	});

	it('stops trying until the file changes', async () => {
		let attempts = 0;
		note.interceptInkWrites(() => {
			attempts += 1;
		});
		await note.advance(10_000);
		await note.settle();
		expect(attempts).toBe(0);
		expect(note.inkFile(INK)).toBe(DAMAGED);
	});

	it('saves the drawing once the file is repaired', async () => {
		await note.syncInkFile(INK, await inkFileText({ [blockId]: holding() }));
		await note.flushWrites();

		expect(banner()).toBeNull();
		expect(await note.inkStrokeCount(INK, blockId)).toBe(1);
	});
});
