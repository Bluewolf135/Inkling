import { describe, expect, it } from 'vitest';
import {
	BEGIN_MARKER,
	END_MARKER,
	mergeIntoNote,
	renderExtraction,
	type ExtractedAnnotation,
} from '../../src/extract/extractFormat';

const LABELS: Record<string, string> = {
	'#1e1e1e': 'Ink',
	'#e03131': 'Red',
	'#f08c00': 'Orange',
};

function annotation(overrides: Partial<ExtractedAnnotation> = {}): ExtractedAnnotation {
	return {
		id: 'ink-1',
		pageNumber: 1,
		color: '#e03131',
		quote: 'a quoted line',
		note: '',
		foreign: false,
		top: 700,
		...overrides,
	};
}

describe('renderExtraction', () => {
	it('groups by page, ascending', () => {
		const output = renderExtraction(
			'book.pdf',
			[annotation({ id: 'ink-b', pageNumber: 42 }), annotation({ id: 'ink-a', pageNumber: 7 })],
			LABELS,
		);
		expect(output.indexOf('### Page 7')).toBeLessThan(output.indexOf('### Page 42'));
	});

	it('orders a page from its top down', () => {
		// PDF y grows upward, so the top of the page is the largest value.
		const output = renderExtraction(
			'book.pdf',
			[
				annotation({ id: 'ink-low', quote: 'near the bottom', top: 100 }),
				annotation({ id: 'ink-high', quote: 'near the top', top: 700 }),
			],
			LABELS,
		);
		expect(output.indexOf('near the top')).toBeLessThan(output.indexOf('near the bottom'));
	});

	it('links to the page and carries a block reference', () => {
		const output = renderExtraction('books/physics.pdf', [annotation({ id: 'ink-xyz', pageNumber: 42 })], LABELS);
		expect(output).toContain('[[books/physics.pdf#page=42]] ^ink-xyz');
	});

	it('names a colour it knows and shows the hex of one it does not', () => {
		// A custom colour is still a category, just an unnamed one — dropping
		// it or lumping it in with a known one would lose the distinction the
		// user was making.
		const output = renderExtraction(
			'book.pdf',
			[annotation({ id: 'ink-a', color: '#e03131' }), annotation({ id: 'ink-b', color: '#123456' })],
			LABELS,
		);
		expect(output).toContain('· Red —');
		expect(output).toContain('· #123456 —');
	});

	it('matches a colour whatever case it was written in', () => {
		expect(renderExtraction('book.pdf', [annotation({ color: '#E03131' })], LABELS)).toContain('· Red —');
	});

	it('labels an annotation another tool wrote', () => {
		const output = renderExtraction('book.pdf', [annotation({ foreign: true })], LABELS);
		expect(output).toContain('external');
	});

	it('renders a quote with no note, a note with no quote, and both', () => {
		const output = renderExtraction(
			'book.pdf',
			[
				annotation({ id: 'ink-q', quote: 'just a quote', note: '', top: 900 }),
				annotation({ id: 'ink-n', quote: '', note: 'just a note', top: 800 }),
				annotation({ id: 'ink-b', quote: 'a quote', note: 'and a thought', top: 700 }),
			],
			LABELS,
		);
		expect(output).toContain('> just a quote');
		expect(output).toContain('just a note');
		expect(output).toContain('> a quote');
		expect(output).toContain('and a thought');
	});

	it('says so rather than producing an empty region', () => {
		const output = renderExtraction('book.pdf', [], LABELS);
		expect(output).toContain(BEGIN_MARKER);
		expect(output).toContain(END_MARKER);
		expect(output).toMatch(/No annotations/);
	});

	it('cannot have its structure broken by the text it quotes', () => {
		// The text comes out of a PDF other software can write to, so a quote
		// containing the end marker would truncate the region and orphan
		// everything after it.
		const output = renderExtraction(
			'book.pdf',
			[annotation({ quote: `sneaky ${END_MARKER} text`, note: `and ${BEGIN_MARKER}` })],
			LABELS,
		);
		// One of each, both ours.
		expect(output.split(BEGIN_MARKER)).toHaveLength(2);
		expect(output.split(END_MARKER)).toHaveLength(2);
	});

	it('flattens a quote that spans several lines onto one', () => {
		expect(renderExtraction('book.pdf', [annotation({ quote: 'first\nsecond\n\nthird' })], LABELS)).toContain(
			'> first second third',
		);
	});
});

describe('mergeIntoNote', () => {
	const generated = renderExtraction('book.pdf', [annotation()], LABELS);

	it('appends a whole region to a note that has none', () => {
		const merged = mergeIntoNote('# My reading notes\n\nSome thoughts.\n', generated);
		expect(merged).toContain('# My reading notes');
		expect(merged).toContain('Some thoughts.');
		expect(merged).toContain(BEGIN_MARKER);
	});

	it('creates the note from nothing when there is nothing', () => {
		expect(mergeIntoNote('', generated).trim()).toBe(generated.trim());
	});

	it('preserves text before and after the region byte for byte', () => {
		const before = '# Heading\n\nMy own words above.\n\n';
		const after = '\n\n## My conclusions\n\nWritten by hand.\n';
		const first = `${before}${generated}${after}`;

		const second = renderExtraction('book.pdf', [annotation({ id: 'ink-2', quote: 'something new' })], LABELS);
		const merged = mergeIntoNote(first, second);

		expect(merged.startsWith(before)).toBe(true);
		expect(merged.endsWith(after)).toBe(true);
		expect(merged).toContain('something new');
		expect(merged).not.toContain('a quoted line');
	});

	it('treats a truncated previous run as the region rather than adding a second', () => {
		// A begin with no end. Appending instead would stack a new region
		// below the broken one, and do it again on every run.
		const truncated = `Intro.\n\n${BEGIN_MARKER}\n\n### Page 1\n- half-written`;
		const merged = mergeIntoNote(truncated, generated);
		expect(merged.split(BEGIN_MARKER)).toHaveLength(2);
		expect(merged).toContain('Intro.');
		expect(merged).toContain(END_MARKER);
		expect(merged).not.toContain('half-written');
	});

	it('is idempotent — the whole design turns on this', () => {
		const base = '# Notes\n\nIntro paragraph.\n';
		const once = mergeIntoNote(base, generated);
		const twice = mergeIntoNote(once, generated);
		expect(twice).toBe(once);

		const thrice = mergeIntoNote(twice, generated);
		expect(thrice).toBe(twice);
	});

	it('produces a byte-identical region from the same annotations in any order', () => {
		// Two runs of the same book must not differ just because the PDF
		// listed its annotations differently.
		const a = annotation({ id: 'ink-a', top: 500 });
		const b = annotation({ id: 'ink-b', top: 500 });
		expect(renderExtraction('book.pdf', [a, b], LABELS)).toBe(renderExtraction('book.pdf', [b, a], LABELS));
	});
});
