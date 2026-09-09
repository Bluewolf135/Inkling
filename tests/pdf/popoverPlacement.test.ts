import { describe, expect, it } from 'vitest';
import { placeWithin } from '../../src/pdf/popoverPlacement';

// A note's editor is a child of the page placeholder, and that placeholder
// sets `overflow: hidden` so a zoomed page cannot spill over the ones around
// it. Anything positioned near an edge is therefore cut off rather than
// merely inconvenient — measured in the running app, a note tapped at 97% of
// the page width put 251px of a 280px popover outside the box, taking the
// Save button with it. There was no way to save that note at all.

const BOX = { width: 1000, height: 800 };
const POPOVER = { width: 280, height: 160 };
const MARGIN = 8;

function place(x: number, y: number) {
	return placeWithin({ x, y }, POPOVER, BOX, MARGIN);
}

describe('placeWithin', () => {
	it('leaves a popover with room to spare where it was asked for', () => {
		expect(place(100, 200)).toEqual({ x: 100, y: 200 });
	});

	it('pulls a popover back inside the right edge', () => {
		// 970 + 280 would end at 1250, which is 250 past the box.
		expect(place(970, 200).x).toBe(BOX.width - POPOVER.width - MARGIN);
	});

	it('pulls a popover back inside the bottom edge', () => {
		expect(place(100, 780).y).toBe(BOX.height - POPOVER.height - MARGIN);
	});

	it('keeps the whole popover visible in the corner where both edges bite', () => {
		const at = place(995, 795);

		expect(at.x + POPOVER.width + MARGIN).toBeLessThanOrEqual(BOX.width);
		expect(at.y + POPOVER.height + MARGIN).toBeLessThanOrEqual(BOX.height);
	});

	it('never pushes a popover off the near edge to satisfy the far one', () => {
		// A popover wider than the page it sits on. Clamping to the right edge
		// alone would give a negative left, hiding the text and the buttons
		// off the other side — worse than the problem being solved.
		const wide = { width: 2000, height: 160 };

		const at = placeWithin({ x: 500, y: 100 }, wide, BOX, MARGIN);

		expect(at.x).toBe(0);
	});

	it('does the same vertically for a popover taller than the page', () => {
		const tall = { width: 280, height: 2000 };

		expect(placeWithin({ x: 100, y: 400 }, tall, BOX, MARGIN).y).toBe(0);
	});

	it('brings a negative point back to the origin', () => {
		// A tap mapped through a scale can land slightly outside the box.
		expect(place(-30, -12)).toEqual({ x: 0, y: 0 });
	});

	it('treats a popover that has not been measured yet as taking no room', () => {
		// offsetWidth is 0 before layout. Clamping against that must not move
		// the popover somewhere arbitrary — it should stay where it was asked
		// for and be corrected once it has a size.
		const at = placeWithin({ x: 400, y: 300 }, { width: 0, height: 0 }, BOX, MARGIN);

		expect(at).toEqual({ x: 400, y: 300 });
	});
});
