import { describe, expect, it } from 'vitest';
import { ToolState } from '../../src/annotate/toolState';
import {
	ALL_PRESET_COLORS,
	DEFAULT_COLOR,
	DEFAULT_WIDTH,
	HIGHLIGHTER_COLORS,
	HIGHLIGHTER_OPACITY,
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

// What a highlight actually shows on white paper: the layer is multiplied
// into the page at HIGHLIGHTER_OPACITY, and multiply against white leaves
// the colour itself, so the page shows (1 - a) x white + a x colour.
function composited(hex: string): [number, number, number] {
	return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((pair) => {
		const value = parseInt(pair, 16);
		return (1 - HIGHLIGHTER_OPACITY) * 255 + HIGHLIGHTER_OPACITY * value;
	}) as [number, number, number];
}

function compositedHue(hex: string): number {
	const [r, g, b] = composited(hex);
	const max = Math.max(r, g, b);
	const span = max - Math.min(r, g, b);
	if (span === 0) return 0;
	const sextant = max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
	return ((sextant * 60) % 360 + 360) % 360;
}

// How much colour the band actually carries, as against how light it is.
// The two are not the same measure and confusing them is what produced a
// yellow that was the right hue and still looked wrong.
function compositedChroma(hex: string): number {
	const channels = composited(hex);
	return Math.max(...channels) - Math.min(...channels);
}

// Three attempts, three different ways of being wrong, so these assert the
// colour the *page* ends up showing rather than the hex in the palette — the
// hex is not the thing anyone is looking at.
//
// #ffd43b (yellow-4) composited to hue 47 and was reported as orange.
// #ffe066 (yellow-3) reached hue 48: a rung of lightness is not what makes a
// gold a gold. #faf14a reached hue 57 by raising green, which is movement
// toward white, so its chroma fell to 106 from the gold's 118 and it was
// reported duller than the colour it replaced.
//
// Hence two measures, not one. A test pinning only the hex would have passed
// for all three; a test pinning only the hue would have passed for the third.
describe('the highlighter’s yellow', () => {
	it('composites to a yellow rather than to a gold', () => {
		// 47 was yellow-4, 48 was yellow-3, 60 is pure yellow.
		expect(compositedHue(defaultStyleFor('highlighter').color)).toBeGreaterThan(52);
		// And has not overshot into the greens, which begin around 75.
		expect(compositedHue(defaultStyleFor('highlighter').color)).toBeLessThan(65);
	});

	it('carries at least as much colour as the gold it replaced', () => {
		// The regression that a hue check alone let through. Composited blue
		// is 102 + 0.6 x blue, so 153 is the ceiling this multiply allows and
		// 118 is what the original gold managed; anything under that is a
		// band paler than the one people complained about.
		expect(compositedChroma(defaultStyleFor('highlighter').color)).toBeGreaterThanOrEqual(118);
	});

	it('is the swatch the highlighter opens on', () => {
		expect(defaultStyleFor('highlighter').color).toBe(HIGHLIGHTER_COLORS[0]?.value);
		expect(HIGHLIGHTER_COLORS[0]?.label).toBe('Yellow');
	});

	it('is far enough from the orange on the same strip to be a different colour', () => {
		const orange = HIGHLIGHTER_COLORS.find((c) => c.label === 'Orange')?.value ?? '';
		// The reason the orange did not have to be retired to make room: the
		// clash was between an orange and a gold calling itself yellow.
		expect(compositedHue(HIGHLIGHTER_COLORS[0]?.value ?? '') - compositedHue(orange)).toBeGreaterThan(20);
	});

	it('can still name the gold it replaced, which the vault is full of', () => {
		// Extraction names a colour from ALL_PRESET_COLORS and the settings
		// tab builds its category labels from the same list. Retired from the
		// strip but deleted from here, every highlight already drawn in it
		// would become a bare hex code in an extracted note.
		expect(ALL_PRESET_COLORS.find((c) => c.value === '#ffd43b')?.label).toBe('Gold');
		expect(paletteFor('highlighter').some((c) => c.value === '#ffd43b')).toBe(false);
	});

	it('still leaves as many tints as the pen has inks', () => {
		// The two strips stay the same length, so the toolbar does not change
		// width when the tool does and the 1-6 keys keep their meaning.
		expect(paletteFor('highlighter')).toHaveLength(PEN_COLORS.length);
	});
});
