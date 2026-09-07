// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountNote, type TestNote } from '../harness/note';

// Saving a block rewrites its fence, Obsidian re-renders that section, and the
// block is torn down and rebuilt about a second after the pen comes up. That
// much is by design and already worked around in three places: the tool strip
// survives it, the undo history survives it, the note's scroll position is put
// back after it.
//
// What was not handled is what the user sees. A rebuilt block is created at
// full size — the aspect ratio holds the space, so nothing reflows — but its
// canvases are attached only once an IntersectionObserver reports it visible,
// which is at least a frame later. For that window the block is correctly
// sized and completely empty, and the ink vanishes and comes back. Reported
// from a tablet, where the pixel ratio is higher and the gap is longer.
//
// The block being drawn in is the one case where that deferral buys nothing:
// it is certainly on screen, and it was mounted moments ago.

let note: TestNote;

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a block rebuilt by its own save', () => {
	beforeEach(() => {
		// Nothing reports intersection here, which is what a real observer does
		// on the frame the block is rebuilt.
		note = mountNote({ blocks: [{ id: 'ink-redraw' }], openInEditor: true, deferIntersection: true });
	});

	it('mounts a block that has never been seen only when told it is visible', () => {
		expect(note.block(0).isMounted()).toBe(false);
	});

	it('brings its canvases straight back, without waiting to be told again', async () => {
		// Draw, save, and let the save's re-render rebuild the block.
		note.block(0).reveal();
		note.block(0).openForEditing();
		note.block(0).drawStroke([
			[100, 100],
			[150, 120],
		]);
		await note.flushWrites();
		expect(note.strokeCountIn(0)).toBe(1);

		note.rerender();

		expect(note.block(0).isMounted()).toBe(true);
	});
});
