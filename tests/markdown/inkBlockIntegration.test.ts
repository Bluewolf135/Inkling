// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountNote, type TestNote } from '../harness/note';
import { hasCapturedPointer } from '../harness/surface';
import { inkBlockMarkdown, emptyInkBlock } from '../../src/markdown/inkBlockFormat';

// The layer above the controller, which is where every bug that cost real
// work actually lived. A stroke reaching the store is already covered by
// surfaceWiring; covered here is a stroke reaching the *file* — through the
// right one of two write paths, into the right fence, and staying recoverable
// when it cannot get there at all.

let note: TestNote;

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	vi.useRealTimers();
});

const STROKE: Array<[number, number]> = [
	[100, 100],
	[150, 120],
	[200, 100],
];

describe('a note holding two ink blocks', () => {
	beforeEach(() => {
		note = mountNote({
			path: 'Physics.md',
			blocks: [{ id: 'ink-first' }, { id: 'ink-second' }],
			openInEditor: true,
		});
	});

	it('writes a stroke into the block it was drawn in', async () => {
		note.block(1).openForEditing();
		note.block(1).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(1)).toBe(1);
	});

	it("leaves the other block's fence untouched", async () => {
		const before = note.fenceBody(0);

		note.block(1).openForEditing();
		note.block(1).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.fenceBody(0)).toBe(before);
	});

	it('keeps both blocks in the note', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.blockCount()).toBe(2);
		expect(note.strokeCountIn(0)).toBe(1);
		expect(note.strokeCountIn(1)).toBe(0);
	});
});

describe('a block nobody has opened for editing', () => {
	beforeEach(() => {
		note = mountNote({ blocks: [{ id: 'ink-closed' }], openInEditor: true });
	});

	it('renders closed', () => {
		expect(note.block(0).isOpenForEditing()).toBe(false);
	});

	it('refuses ink, so a pen passing over a note leaves no stray mark', async () => {
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(0);
	});
});

describe('saving from reading view', () => {
	beforeEach(() => {
		note = mountNote({
			blocks: [{ id: 'ink-reading' }],
			openInEditor: true,
			mode: 'preview',
		});
	});

	// The bug this pins: reading view reports a markdown view like any
	// other, but an edit made through its editor is discarded. The save
	// counted itself a success and cleared the recovery entry, and the next
	// re-render took the drawing with it.
	it('lands the stroke on disk', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(1);
	});

	it('never writes through the editor at all', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.discardedEditorWrites()).toBe(0);
	});
});

describe('a note that is not open in any editor', () => {
	beforeEach(() => {
		note = mountNote({ blocks: [{ id: 'ink-closed-note' }], openInEditor: false });
	});

	it('still saves, through the vault', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(1);
	});
});

describe('when the block cannot be found in its own note', () => {
	beforeEach(() => {
		note = mountNote({ blocks: [{ id: 'ink-vanishing' }], openInEditor: true });
	});

	it('leaves the note exactly as it found it', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		// The fence is gone by the time the debounced write fires — a section
		// cut and pasted, or a sync landing mid-gesture.
		note.setContents('# Notes\n\nNothing here any more.\n');
		await note.flushWrites();

		expect(note.contents()).toBe('# Notes\n\nNothing here any more.\n');
	});

	it('tells the user rather than failing silently', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		note.setContents('# Notes\n\nNothing here any more.\n');
		await note.flushWrites();
		// Past the retries, which usually resolve a transient edit on their own.
		await note.advance(10_000);

		expect(note.notices().some((message) => message.includes('could not be saved yet'))).toBe(true);
	});
});

describe('two blocks that have never been saved', () => {
	// Byte-identical: the same empty JSON, no id in either. Their text
	// describes both, so it identifies neither, and a save that trusted it
	// would write one block's drawing into the other's fence.
	beforeEach(() => {
		const empty = inkBlockMarkdown({ ...emptyInkBlock() });
		note = mountNote({
			contents: `# Notes\n\n${empty}\n\nBetween.\n\n${empty}\n`,
			openInEditor: true,
		});
	});

	it('renders both', () => {
		expect(note.blockCount()).toBe(2);
	});

	it('refuses to write rather than guess which fence is which', async () => {
		const before = note.contents();

		note.block(1).openForEditing();
		note.block(1).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.contents()).toBe(before);
	});
});

describe('a block whose source cannot be parsed', () => {
	beforeEach(() => {
		note = mountNote({
			contents: '# Notes\n\n```inkling\n{"version":1,"annotations":[{"broken":\n```\n',
			openInEditor: true,
		});
	});

	// Opened first, deliberately. A closed block refuses ink too, so drawing
	// on a closed malformed block would pass whether or not the malformed
	// guard existed at all. The guarantee worth pinning is the stronger one:
	// the toggle cannot lift this, because what would be overwritten is
	// exactly the part we failed to understand.
	it('refuses ink even when the user opens it', async () => {
		const before = note.contents();

		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.contents()).toBe(before);
	});

	it('shows the reader a banner rather than a blank block', () => {
		expect(note.block(0).el.querySelector('.inkling-ink-block-banner')).not.toBeNull();
	});
});

describe('the drawing surface', () => {
	beforeEach(() => {
		note = mountNote({ blocks: [{ id: 'ink-capture' }], openInEditor: true });
	});

	// jsdom has no pointer capture, so this went untested for as long as the
	// harness simply tolerated its absence — which meant every test ran the
	// degraded path and the captured one, the only one a tablet ever uses,
	// ran nowhere.
	it('captures the pointer for the duration of a stroke', () => {
		const block = note.block(0);
		block.openForEditing();
		const overlay = block.el.querySelectorAll('canvas')[1];
		if (!overlay) throw new Error('no overlay canvas');

		block.pointer('pointerdown', 100, 100);
		expect(hasCapturedPointer(overlay)).toBe(true);

		block.pointer('pointerup', 120, 110);
		expect(hasCapturedPointer(overlay)).toBe(false);
	});
});

describe('the cost of a save', () => {
	beforeEach(() => {
		note = mountNote({ blocks: [{ id: 'ink-cost' }], openInEditor: true });
	});

	// Not a micro-optimisation for its own sake. Stored JSON wraps at 120
	// characters, which took the largest note in the vault from 409 lines to
	// 7,788 — and a save that reads the document a line at a time pays a tree
	// lookup and a string slice for every one of them, on the main thread,
	// while the pen is still moving.
	it('reads the note in one call rather than line by line', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(1);
		expect(note.getLineCalls()).toBe(0);
	});
});

describe('a drawing held back by a failed save', () => {
	// A note and a block id of its own per test. The rescue buffer outlives
	// any one block by design — that is the whole point of it — so it also
	// outlives any one test, and two tests sharing an id share an entry.
	function heldIn(id: string): TestNote {
		const held = mountNote({ path: `${id}.md`, blocks: [{ id }], openInEditor: true });
		held.block(0).openForEditing();
		held.block(0).drawStroke(STROKE);
		// The block is gone from the note by the time the debounced write
		// fires, so the drawing is held rather than written — which is the
		// whole reason the rescue buffer exists.
		held.setContents('# Notes\n\nNothing here any more.\n');
		return held;
	}

	function blockHolding(id: string, strokes: number): string {
		const annotations = Array.from({ length: strokes }, (_, index) => ({
			id: `elsewhere-${index}`,
			kind: 'stroke' as const,
			tool: 'pen' as const,
			color: '#1e1e1e',
			width: 2,
			points: [
				{ x: index, y: 0 },
				{ x: index + 10, y: 10 },
			],
		}));
		return inkBlockMarkdown({ ...emptyInkBlock(), id, annotations });
	}

	it('keeps the drawing somewhere that survives quitting Obsidian', async () => {
		note = heldIn('ink-persisted');
		await note.flushWrites();

		expect(Object.keys(window.localStorage).some((key) => key.startsWith('inkling:unsaved:'))).toBe(true);
	});

	it('puts itself back when the block comes back unchanged', async () => {
		note = heldIn('ink-restored');
		await note.flushWrites();
		// Past the retries, so that no pending write survives on the old
		// view: tearing one down flushes it, and a test that left one
		// scheduled would be watching that write rather than the rescue.
		await note.advance(10_000);

		note.setContents(`# Notes\n\n${blockHolding('ink-restored', 0)}\n`);
		note.rerender();
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(1);
	});

	it('stands aside for a version of the block that arrived since', async () => {
		note = heldIn('ink-superseded');
		await note.flushWrites();
		await note.advance(10_000);

		// Sync brings the block back carrying work done on another device. The
		// held drawing is older than that, however recently it was drawn here,
		// and writing it would overwrite two strokes with one.
		note.setContents(`# Notes\n\n${blockHolding('ink-superseded', 2)}\n`);
		note.rerender();
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(2);
	});
});

describe('a save that lands after the file moved on', () => {
	// Tearing a block down flushes its pending write, and a block is often
	// torn down *because* the note changed — a sync landing inside the
	// debounce is exactly that. The flush used to overwrite whatever the
	// fence held by then, so the other device's strokes went silently.
	function blockWithStrokes(id: string, count: number): string {
		const annotations = Array.from({ length: count }, (_, index) => ({
			id: `theirs-${index}`,
			kind: 'stroke' as const,
			tool: 'pen' as const,
			color: '#1e1e1e',
			width: 2,
			points: [
				{ x: index, y: 0 },
				{ x: index + 10, y: 10 },
			],
		}));
		return inkBlockMarkdown({ ...emptyInkBlock(), id, annotations });
	}

	it('keeps the strokes from both devices', async () => {
		note = mountNote({ path: 'merge.md', blocks: [{ id: 'ink-merge' }], openInEditor: true });
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);

		// Sync lands a version of the block carrying a stroke drawn elsewhere,
		// while this view still has an unwritten one of its own.
		note.setContents(`# Notes\n\n${blockWithStrokes('ink-merge', 1)}\n`);
		note.unmount();
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(2);
	});

	it('does not write over a block it cannot read', async () => {
		note = mountNote({ path: 'unreadable.md', blocks: [{ id: 'ink-unreadable-merge' }], openInEditor: true });
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);

		// Nothing to merge into. Refusing is the same call the damage banner
		// makes, and the drawing is held rather than written over the wreck.
		const broken = ['# Notes', '', '```inkling', '{"version":2,"id":"ink-unreadable-merge","width":800,"height":450,"annotations":[{oops', '```', ''].join(String.fromCharCode(10));
		note.setContents(broken);
		note.unmount();
		await note.flushWrites();

		expect(note.contents()).toBe(broken);
	});
});
