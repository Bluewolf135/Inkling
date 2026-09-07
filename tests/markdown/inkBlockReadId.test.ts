import { describe, expect, it } from 'vitest';
import { findInkBlockById, readInkBlockId, serializeInkBlock } from '../../src/markdown/inkBlockFormat';
import type { InkBlockData } from '../../src/markdown/inkBlockFormat';
import type { Annotation } from '../../src/annotate/types';

// readInkBlockId is called once per block in the note, every time a block
// saves, because that is how a save confirms the fence it is about to
// overwrite is its own. It ran a full JSON.parse to read one short string
// sitting at the front of the body — 4.92 ms per save on the largest note in
// the vault, almost all of it spent parsing stroke data nobody asked for.
//
// It now reads the id off the front when the block is shaped the way this
// plugin writes them, and falls back to parsing for anything else. The
// fallback is what keeps it correct: the fast path is an optimisation for a
// known shape, never an assumption about one.

function block(id: string | undefined, annotations: Annotation[] = []): InkBlockData {
	return { version: 2, ...(id ? { id } : {}), width: 800, height: 450, annotations };
}

const bigStroke: Annotation = {
	id: 'ink-s',
	kind: 'stroke',
	tool: 'pen',
	color: '#1e1e1e',
	width: 3,
	points: Array.from({ length: 3000 }, (_, i) => ({ x: i * 0.5, y: i * 0.25, p: 0.5 })),
};

describe('readInkBlockId', () => {
	it('reads the id this plugin writes', () => {
		expect(readInkBlockId(serializeInkBlock(block('ink-abc123')))).toBe('ink-abc123');
	});

	it('reads it from a block big enough to be wrapped over many lines', () => {
		const source = serializeInkBlock(block('ink-big', [bigStroke]));

		expect(source.split('\n').length).toBeGreaterThan(10);
		expect(readInkBlockId(source)).toBe('ink-big');
	});

	it('returns null for a block with no id', () => {
		expect(readInkBlockId(serializeInkBlock(block(undefined)))).toBeNull();
	});

	it('returns null for unparseable source', () => {
		expect(readInkBlockId('{not json')).toBeNull();
		expect(readInkBlockId('')).toBeNull();
	});

	it('returns null for a non-object payload', () => {
		expect(readInkBlockId('[1,2,3]')).toBeNull();
		expect(readInkBlockId('"a string"')).toBeNull();
		expect(readInkBlockId('null')).toBeNull();
	});

	// Everything below is a shape this plugin does not write, so it exercises
	// the fallback. Each must give the same answer a full parse would.
	it('still reads an id when the keys are in another order', () => {
		expect(readInkBlockId('{"id":"ink-first","version":2,"width":800}')).toBe('ink-first');
		expect(readInkBlockId('{"width":800,"version":2,"id":"ink-late"}')).toBe('ink-late');
	});

	it('handles whitespace a hand-edit might leave', () => {
		expect(readInkBlockId('  {\n  "version" : 2 ,\n  "id" : "ink-spaced" ,\n "width": 800 }')).toBe('ink-spaced');
	});

	it('is not fooled by an id-shaped string somewhere else in the block', () => {
		const source = JSON.stringify({
			version: 2,
			width: 800,
			height: 450,
			annotations: [{ id: 'ink-inner', kind: 'stroke', tool: 'pen', color: '#000', width: 1, points: [1, 2] }],
		});

		// The block itself has no id — the one inside an annotation is not it.
		expect(readInkBlockId(source)).toBeNull();
	});

	it('rejects an id that is not a non-empty string', () => {
		expect(readInkBlockId('{"version":2,"id":"","width":800}')).toBeNull();
		expect(readInkBlockId('{"version":2,"id":42,"width":800}')).toBeNull();
		expect(readInkBlockId('{"version":2,"id":null,"width":800}')).toBeNull();
	});

	it('agrees with a full parse when the id carries an escape', () => {
		const source = JSON.stringify({ version: 2, id: 'ink-a"b\\c', width: 800 });

		expect(readInkBlockId(source)).toBe('ink-a"b\\c');
	});

	// A hand-edited block with two top-level ids is deliberately out of
	// contract: JSON says the last wins, the fast path reads the first, and
	// telling them apart would mean scanning the whole body — which is the
	// cost the fast path exists to remove.
	//
	// What has to hold is the safety property, not agreement. A save looks
	// for a fence whose id equals its own, and its own id came from a full
	// parse. So on a block like this the two disagree, the save finds
	// nothing, and it refuses — which keeps the ink. What must never happen
	// is an id read that belongs to some *other* block.
	it('never reports an id the block does not contain', () => {
		const source = '{"version":2,"id":"ink-one","width":800,"id":"ink-two"}';
		const read = readInkBlockId(source);

		expect(['ink-one', 'ink-two']).toContain(read);
	});
});

describe('locating a block this module did not write', () => {
	// findInkBlockById reads the id off the first few lines of a block, which
	// only works for the shape serializeInkBlock produces. Everything else has
	// to fall back to the whole body, and a hand-edited or third-party block
	// must still be found — losing it would mean refusing to save a block the
	// user can plainly see.
	it('finds one whose keys are in another order', () => {
		const odd = '{"id":"ink-handmade","version":2,"width":800,"height":450,"annotations":[]}';
		const note = `# Notes\n\n\`\`\`inkling\n${odd}\n\`\`\`\n`;

		expect(findInkBlockById(note.split('\n'), 'ink-handmade')).toEqual({ lineStart: 2, lineEnd: 4 });
	});

	it('finds one whose id needs an escape', () => {
		const escaped = JSON.stringify({ version: 2, id: 'ink-a"b', width: 800, height: 450, annotations: [] });
		const note = `# Notes\n\n\`\`\`inkling\n${escaped}\n\`\`\`\n`;

		expect(findInkBlockById(note.split('\n'), 'ink-a"b')).toEqual({ lineStart: 2, lineEnd: 4 });
	});

	it('finds one whose head is pushed past the first few lines', () => {
		// Pretty-printed by hand: the id is well below where the fast read
		// looks, so only the fallback can find it.
		const pretty = JSON.stringify({ version: 2, id: 'ink-pretty', width: 800, height: 450, annotations: [] }, null, 4);
		const note = `# Notes\n\n\`\`\`inkling\n${pretty}\n\`\`\`\n`;
		const lines = note.split('\n');

		expect(findInkBlockById(lines, 'ink-pretty')).not.toBeNull();
	});
});
