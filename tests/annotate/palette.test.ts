import { describe, expect, it } from 'vitest';
import { ToolState } from '../../src/annotate/toolState';
import {
	ALL_PRESET_COLORS,
	DEFAULT_COLOR,
	DEFAULT_WIDTH,
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	defaultStyleFor,
	paletteFor,
} from '../../src/annotate/types';

describe('paletteFor', () => {
	it('offers the highlighter its own tints, not the pen’s ink colours', () => {
		const highlighter = paletteFor('highlighter').map((c) => c.value);
		const pen = paletteFor('pen').map((c) => c.value);
		expect(highlighter).not.toEqual(pen);
		expect(highlighter).toEqual(HIGHLIGHTER_COLORS.map((c) => c.value));
		expect(pen).toEqual(PEN_COLORS.map((c) => c.value));
	});

	it('includes a yellow, which the pen palette never had', () => {
		// The gap this fixes: settings.ts documents "Yellow = definition" as
		// the example colour label, for a colour nothing could produce.
		expect(paletteFor('highlighter').some((c) => c.label === 'Yellow')).toBe(true);
		expect(paletteFor('pen').some((c) => c.label === 'Yellow')).toBe(false);
	});

	it('gives shapes and the eraser the pen’s palette', () => {
		for (const tool of ['line', 'rectangle', 'oval', 'arrow', 'note', 'select', 'eraser'] as const) {
			expect(paletteFor(tool)).toBe(PEN_COLORS);
		}
	});
});

describe('defaultStyleFor', () => {
	it('starts the highlighter yellow and broad, not black and hairline', () => {
		const style = defaultStyleFor('highlighter');
		expect(style.color).toBe(HIGHLIGHTER_COLORS[0]?.value);
		expect(style.width).toBeGreaterThan(DEFAULT_WIDTH);
	});

	it('leaves the pen exactly as it was', () => {
		expect(defaultStyleFor('pen')).toEqual({ color: DEFAULT_COLOR, width: DEFAULT_WIDTH });
	});
});

describe('ToolState with per-tool defaults', () => {
	it('hands the highlighter its own default the first time it is picked', () => {
		const state = new ToolState();
		state.setTool('highlighter');
		expect(state.getColor()).toBe(defaultStyleFor('highlighter').color);
		expect(state.getWidth()).toBe(defaultStyleFor('highlighter').width);

		state.setTool('pen');
		expect(state.getColor()).toBe(DEFAULT_COLOR);
		expect(state.getWidth()).toBe(DEFAULT_WIDTH);
	});

	it('still remembers a choice made against a tool', () => {
		const state = new ToolState();
		state.setTool('highlighter');
		state.setColor('#a9e34b');
		state.setTool('pen');
		state.setTool('highlighter');
		expect(state.getColor()).toBe('#a9e34b');
	});
});

// The highlighter opened on #ffd43b, which is Open Color's yellow-4 — a gold
// rather than a yellow, and warmer still once it is multiplied into the page
// at 60%. Reported as reading orange. It now opens on yellow-3, and the
// orange that sat further along the strip is retired to make room, since a
// strip with two oranges and no yellow was the complaint.
describe('the highlighter palette after the yellow swap', () => {
	it('opens on a yellow rather than the gold it used to', () => {
		expect(defaultStyleFor('highlighter').color).toBe('#ffe066');
	});

	it('no longer offers orange on the strip', () => {
		expect(paletteFor('highlighter').some((c) => c.value === '#ffa94d')).toBe(false);
	});

	it('keeps the old default on the strip, because the vault is full of it', () => {
		// Every highlight made before today is #ffd43b. Dropping it would
		// leave no swatch that matches the marks already in the books.
		expect(paletteFor('highlighter').some((c) => c.value === '#ffd43b')).toBe(true);
	});

	it('can still name a colour it no longer offers', () => {
		// Extraction names a colour from ALL_PRESET_COLORS, and the settings
		// tab builds its category labels from the same list. A colour retired
		// from the strip that vanished from here would turn every existing
		// annotation in it into a bare hex code in the extracted note.
		expect(ALL_PRESET_COLORS.find((c) => c.value === '#ffa94d')?.label).toBe('Orange');
	});

	it('still offers as many tints as the pen has inks', () => {
		// The two strips are the same hues a rung apart, so the toolbar does
		// not change width when the tool changes.
		expect(paletteFor('highlighter')).toHaveLength(PEN_COLORS.length);
	});
});
