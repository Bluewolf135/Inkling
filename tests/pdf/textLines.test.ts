import { describe, expect, it } from 'vitest';
import { groupIntoLines, quoteBetween, type PositionedBox, type TextLine } from '../../src/pdf/textLines';

function box(text: string, minX: number, maxX: number, centerY: number, height = 10): PositionedBox {
	return { text, minX, maxX, centerY, height };
}

describe('groupIntoLines', () => {
	it('has nothing to group in an empty page', () => {
		expect(groupIntoLines([])).toEqual([]);
	});

	it('gathers the runs of one visual line into one line', () => {
		// A single line of text is usually several items — one per run of
		// consistent font or style — not one item per line.
		const lines = groupIntoLines([
			box('The ', 0, 30, 100),
			box('important', 30, 90, 101),
			box(' bit', 90, 110, 99),
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.items.map((item) => item.text)).toEqual(['The ', 'important', ' bit']);
		expect(lines[0]?.minX).toBe(0);
		expect(lines[0]?.maxX).toBe(110);
	});

	it('separates lines that sit more than a fraction of a line apart', () => {
		const lines = groupIntoLines([box('first', 0, 50, 100), box('second', 0, 50, 120)]);
		expect(lines).toHaveLength(2);
	});

	it('orders lines down the page and items across it', () => {
		// PDFs emit runs in whatever order suits their content stream, which
		// for mixed styling is not reading order.
		const lines = groupIntoLines([
			box('world', 60, 110, 200),
			box('second', 0, 50, 220),
			box('hello', 0, 60, 200),
		]);
		expect(lines.map((line) => line.centerY)).toEqual([200, 220]);
		expect(lines[0]?.items.map((item) => item.text)).toEqual(['hello', 'world']);
	});

	it('takes a line’s height from its tallest item', () => {
		// A line with a big initial capital is as tall as the capital, and a
		// highlight snapped to it has to cover the whole thing.
		const lines = groupIntoLines([box('T', 0, 20, 100, 24), box('he rest', 20, 90, 100, 10)]);
		expect(lines[0]?.height).toBe(24);
	});
});

describe('quoteBetween', () => {
	const line: TextLine = {
		minX: 0,
		maxX: 300,
		centerY: 100,
		height: 12,
		items: [
			{ minX: 0, maxX: 60, text: 'Entropy' },
			{ minX: 60, maxX: 80, text: ' is ' },
			{ minX: 80, maxX: 200, text: 'not disorder' },
			{ minX: 200, maxX: 300, text: ' exactly' },
		],
	};

	it('returns the words a stroke swept over', () => {
		expect(quoteBetween(line, 0, 200)).toBe('Entropy is not disorder');
	});

	it('takes a whole item the stroke only partly covered', () => {
		// pdf.js gives an item's total width but no per-glyph positions, so
		// clipping inside one would mean assuming every character is the same
		// width — wrong for any proportional font, and it produces quotes
		// with words cut in half. Over-capturing by a word is the right way
		// to be wrong.
		expect(quoteBetween(line, 0, 100)).toBe('Entropy is not disorder');
	});

	it('returns nothing when the stroke missed the line entirely', () => {
		expect(quoteBetween(line, 500, 600)).toBe('');
	});

	it('collapses the runs of whitespace that item boundaries produce', () => {
		const spaced: TextLine = {
			minX: 0,
			maxX: 100,
			centerY: 0,
			height: 10,
			items: [
				{ minX: 0, maxX: 40, text: 'one  ' },
				{ minX: 40, maxX: 100, text: '   two' },
			],
		};
		expect(quoteBetween(spaced, 0, 100)).toBe('one two');
	});

	it('has nothing to say about a line with no items', () => {
		expect(quoteBetween({ minX: 0, maxX: 10, centerY: 0, height: 10, items: [] }, 0, 10)).toBe('');
	});

	it('picks up an item the stroke only touched the edge of', () => {
		expect(quoteBetween(line, 199, 201)).toBe('not disorder exactly');
	});
});
