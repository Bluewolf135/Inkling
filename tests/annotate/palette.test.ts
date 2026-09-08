import { describe, expect, it } from 'vitest';
import { ToolState } from '../../src/annotate/toolState';
import {
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
