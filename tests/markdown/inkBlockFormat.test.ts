import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BLOCK_HEIGHT,
	DEFAULT_BLOCK_WIDTH,
	INK_BLOCK_VERSION,
	emptyInkBlock,
	findInkBlockById,
	findUniqueInkBlockByBody,
	parseInkBlock,
	readInkBlockId,
	serializeInkBlock,
} from '../../src/markdown/inkBlockFormat';

// Block content is untrusted: notes sync between devices, get shared, and
// can be hand-edited. Nothing here may throw — a throw would take the whole
// note's render down with it.
describe('parseInkBlock', () => {
	it('treats empty source as an empty block, not as damage', () => {
		expect(parseInkBlock('   \n ')).toEqual({ data: emptyInkBlock(), malformed: false });
	});

	it('flags unparseable JSON as malformed', () => {
		expect(parseInkBlock('{not json')).toEqual({ data: emptyInkBlock(), malformed: true });
	});

	it('flags a non-object payload as malformed', () => {
		// The array case matters most: it parses, and `typeof [] === 'object'`,
		// so a naive shape check waves it through as an empty block — and the
		// next edit then overwrites whatever was really in there.
		expect(parseInkBlock('[1, 2, 3]').malformed).toBe(true);
		expect(parseInkBlock('"hello"').malformed).toBe(true);
		expect(parseInkBlock('null').malformed).toBe(true);
		expect(parseInkBlock('42').malformed).toBe(true);
	});

	it('round-trips a valid block', () => {
		const source = serializeInkBlock({
			version: INK_BLOCK_VERSION,
			width: 400,
			height: 200,
			annotations: [
				{
					id: 'ink-1',
					kind: 'stroke',
					tool: 'pen',
					color: '#000000',
					width: 3,
					points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
				},
			],
		});
		const { data, malformed } = parseInkBlock(source);
		expect(malformed).toBe(false);
		expect(data.width).toBe(400);
		expect(data.annotations).toHaveLength(1);
	});

	it('drops a bad annotation, keeps the good ones, and says so', () => {
		const source = JSON.stringify({
			version: 1,
			width: 400,
			height: 200,
			annotations: [
				{ id: 'ink-1', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
				{ id: 'ink-2', kind: 'stroke', tool: 'notatool', color: '#000000', width: 3, points: [{ x: 1, y: 2 }] },
			],
		});
		const { data, malformed } = parseInkBlock(source);
		expect(data.annotations).toHaveLength(1);
		expect(malformed).toBe(true);
	});

	it('rejects a stroke with one unusable point rather than bending it', () => {
		const source = JSON.stringify({
			annotations: [
				{ id: 'ink-1', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 1, y: 2 }, { x: 'NaN', y: 4 }] },
			],
		});
		expect(parseInkBlock(source).data.annotations).toHaveLength(0);
	});

	it('falls back to default dimensions for nonsense ones', () => {
		const { data } = parseInkBlock(JSON.stringify({ width: -5, height: 'tall', annotations: [] }));
		expect(data.width).toBe(DEFAULT_BLOCK_WIDTH);
		expect(data.height).toBe(DEFAULT_BLOCK_HEIGHT);
	});

	it('flags a block written by a future version so it is not overwritten', () => {
		const { malformed } = parseInkBlock(JSON.stringify({ version: INK_BLOCK_VERSION + 1, annotations: [] }));
		expect(malformed).toBe(true);
	});

	it('carries a block id through a round trip', () => {
		const source = serializeInkBlock({ ...emptyInkBlock(), id: 'ink-block-7' });
		expect(parseInkBlock(source).data.id).toBe('ink-block-7');
	});

	it('leaves the id undefined for a block written before ids existed', () => {
		expect(parseInkBlock(JSON.stringify({ width: 400, height: 200, annotations: [] })).data.id).toBeUndefined();
		expect(parseInkBlock(JSON.stringify({ id: 42, annotations: [] })).data.id).toBeUndefined();
		expect(parseInkBlock(JSON.stringify({ id: '', annotations: [] })).data.id).toBeUndefined();
	});

	it('survives hostile input without throwing', () => {
		for (const source of [
			'{"annotations": {"0": {}}}',
			'{"annotations": [null, 1, "x", []]}',
			'{"__proto__": {"x": 1}}',
			'{"width": {"valueOf": 1}}',
		]) {
			expect(() => parseInkBlock(source)).not.toThrow();
		}
	});
});

// The guard that stops one ink block being saved over another. A note full
// of blocks is a note full of identical-looking ```inkling fences, so a
// save that only checks the fence's *shape* will happily overwrite the
// wrong one when Obsidian reports the wrong line range — which is how a
// drawing from one block ended up duplicated in the block below it.
describe('readInkBlockId', () => {
	it('reads the id out of a serialized block', () => {
		expect(readInkBlockId(serializeInkBlock({ ...emptyInkBlock(), id: 'ink-abc' }))).toBe('ink-abc');
	});

	it('tells two different blocks apart', () => {
		const a = serializeInkBlock({ ...emptyInkBlock(), id: 'ink-a' });
		const b = serializeInkBlock({ ...emptyInkBlock(), id: 'ink-b' });
		expect(readInkBlockId(a)).not.toBe(readInkBlockId(b));
	});

	it('returns null rather than a guess for anything it cannot read', () => {
		// Null is "can't confirm", which the caller must treat as "don't
		// write" — never as a match.
		expect(readInkBlockId('')).toBeNull();
		expect(readInkBlockId('{not json')).toBeNull();
		expect(readInkBlockId('[{"id":"ink-a"}]')).toBeNull();
		expect(readInkBlockId(JSON.stringify({ annotations: [] }))).toBeNull();
		expect(readInkBlockId(JSON.stringify({ id: 12 }))).toBeNull();
	});

	it('tolerates the surrounding whitespace a hand-edited fence can have', () => {
		expect(readInkBlockId(`\n  ${serializeInkBlock({ ...emptyInkBlock(), id: 'ink-x' })}  \n`)).toBe('ink-x');
	});
});

// Obsidian's getSectionInfo cannot be trusted to say where a block is when
// a note holds several — it hands one block the line range of another.
// Finding the block that actually carries our id answers the question
// directly instead of trusting a report of it.
describe('findInkBlockById', () => {
	const block = (id: string) => serializeInkBlock({ ...emptyInkBlock(), id });

	function note(...blocks: string[]): string[] {
		const lines = ['# Physics', '', 'Some prose.', ''];
		for (const body of blocks) lines.push('```inkling', body, '```', '');
		lines.push('More prose.');
		return lines;
	}

	it('finds the only block in a note', () => {
		expect(findInkBlockById(note(block('ink-a')), 'ink-a')).toEqual({ lineStart: 4, lineEnd: 6 });
	});

	it('finds the right block among several', () => {
		const lines = note(block('ink-a'), block('ink-b'), block('ink-c'));
		const second = findInkBlockById(lines, 'ink-b');
		expect(second).not.toBeNull();
		expect(readInkBlockId(lines[(second?.lineStart ?? 0) + 1] ?? '')).toBe('ink-b');
	});

	it('returns null for a block that is not there', () => {
		// "Do not write anywhere" — never "write wherever you were told".
		expect(findInkBlockById(note(block('ink-a')), 'ink-b')).toBeNull();
		expect(findInkBlockById([], 'ink-a')).toBeNull();
		expect(findInkBlockById(note(block('ink-a')), '')).toBeNull();
	});

	it('ignores a block with no id, rather than guessing it is the one', () => {
		const lines = note(JSON.stringify({ width: 800, height: 450, annotations: [] }), block('ink-b'));
		const found = findInkBlockById(lines, 'ink-b');
		expect(readInkBlockId(lines[(found?.lineStart ?? 0) + 1] ?? '')).toBe('ink-b');
	});

	it('is not confused by other kinds of code block around it', () => {
		const lines = ['```js', 'const x = 1;', '```', '', '```inkling', block('ink-a'), '```'];
		expect(findInkBlockById(lines, 'ink-a')).toEqual({ lineStart: 4, lineEnd: 6 });
	});

	it('gives up on an unterminated fence rather than running to the end of the note', () => {
		const lines = ['```inkling', block('ink-a')];
		expect(findInkBlockById(lines, 'ink-a')).toBeNull();
	});

	it('finds a block whose body was hand-wrapped across lines', () => {
		const lines = ['```inkling', '{', '  "id": "ink-a",', '  "annotations": []', '}', '```'];
		expect(findInkBlockById(lines, 'ink-a')).toEqual({ lineStart: 0, lineEnd: 5 });
	});
});

describe('stroke fidelity through a block', () => {
	it('keeps pressure through a round trip', () => {
		// It used to be written and never read back, so a block saved a
		// tapered stroke and redrew it flat about a second later, when its
		// own save re-rendered it.
		const source = serializeInkBlock({
			...emptyInkBlock(),
			annotations: [
				{
					id: 'ink-1',
					kind: 'stroke',
					tool: 'pen',
					color: '#000000',
					width: 3,
					points: [{ x: 1, y: 2, p: 0.25 }, { x: 3, y: 4, p: 1 }],
				},
			],
		});

		const [read] = parseInkBlock(source).data.annotations;
		const points = read?.kind === 'stroke' ? read.points : [];
		expect(points[0]?.p).toBeCloseTo(0.25, 2);
		expect(points[1]?.p).toBe(1);
	});

	it('leaves a pressureless point pressureless', () => {
		const source = serializeInkBlock({
			...emptyInkBlock(),
			annotations: [
				{ id: 'ink-1', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
			],
		});
		const [read] = parseInkBlock(source).data.annotations;
		const points = read?.kind === 'stroke' ? read.points : [];
		for (const point of points) expect(point.p).toBeUndefined();
	});

	it('drops a pressure outside the range a stylus can report', () => {
		// Inventing a pressure is worse than having none.
		const source = JSON.stringify({
			annotations: [
				{
					id: 'ink-1',
					kind: 'stroke',
					tool: 'pen',
					color: '#000000',
					width: 3,
					points: [{ x: 1, y: 2, p: 4 }, { x: 3, y: 4, p: -1 }],
				},
			],
		});
		const [read] = parseInkBlock(source).data.annotations;
		const points = read?.kind === 'stroke' ? read.points : [];
		expect(points).toHaveLength(2);
		for (const point of points) expect(point.p).toBeUndefined();
	});

	it('writes coordinates at a sane precision instead of full float', () => {
		// JSON.stringify writes "123.45678901234567" by default, for a
		// coordinate whose last twelve digits nobody can see. With every
		// stylus sample now captured, that is the bulk of the note.
		const points = Array.from({ length: 200 }, (_, index) => ({
			x: 100 + Math.sin(index / 9) * 137.4213456789,
			y: 200 + Math.cos(index / 7) * 88.72311234,
			p: 0.4 + Math.sin(index / 30) * 0.3,
		}));
		const block = {
			...emptyInkBlock(),
			annotations: [{ id: 'ink-1', kind: 'stroke' as const, tool: 'pen' as const, color: '#000000', width: 3, points }],
		};

		const serialized = serializeInkBlock(block);
		expect(serialized).not.toMatch(/\d\.\d{3,}/);
		// Comfortably under half of what full precision costs.
		expect(serialized.length).toBeLessThan(JSON.stringify(block).length * 0.6);
	});

	it('rounds only what it writes, never the live annotations', () => {
		// Rounding in place would move ink under the pen, by a fraction of a
		// pixel, on every save.
		const point = { x: 1.23456789, y: 2.3456789 };
		const block = {
			...emptyInkBlock(),
			annotations: [{ id: 'ink-1', kind: 'stroke' as const, tool: 'pen' as const, color: '#000000', width: 3, points: [point, { x: 5, y: 6 }] }],
		};
		serializeInkBlock(block);
		expect(point.x).toBe(1.23456789);
	});

	it('still recovers a shape it rounded', () => {
		const source = serializeInkBlock({
			...emptyInkBlock(),
			annotations: [
				{
					id: 'ink-1',
					kind: 'shape',
					tool: 'rectangle',
					color: '#000000',
					width: 2,
					start: { x: 10.987654, y: 20.123456 },
					end: { x: 100.5, y: 200.5 },
				},
			],
		});
		const [read] = parseInkBlock(source).data.annotations;
		expect(read?.kind).toBe('shape');
		if (read?.kind === 'shape') {
			expect(read.start.x).toBeCloseTo(11, 0);
			expect(read.end.x).toBe(100.5);
		}
	});
});

describe('findUniqueInkBlockByBody', () => {
	const empty = '{"version":1,"width":800,"height":450,"annotations":[]}';
	const drawn = '{"version":1,"width":800,"height":450,"annotations":[{"id":"s","kind":"stroke","tool":"pen","color":"#1e1e1e","width":3,"points":[{"x":1,"y":2},{"x":3,"y":4}]}]}';

	function note(...bodies: string[]): string[] {
		return bodies.flatMap((b) => ['```inkling', b, '```', '']);
	}

	it('finds the one fence carrying that text', () => {
		expect(findUniqueInkBlockByBody(note(empty, drawn), drawn)).toEqual({ lineStart: 4, lineEnd: 6 });
	});

	// The bug this exists for. Two ink blocks that have never been drawn in
	// are byte-identical, so text cannot tell them apart — and the save that
	// trusted it wrote one block's drawing into the other, which read as the
	// first block's work vanishing.
	it('refuses when two fences carry the same text', () => {
		expect(findUniqueInkBlockByBody(note(empty, empty), empty)).toBeNull();
	});

	it('refuses when three fences carry the same text', () => {
		expect(findUniqueInkBlockByBody(note(empty, empty, empty), empty)).toBeNull();
	});

	it('refuses when no fence carries it', () => {
		expect(findUniqueInkBlockByBody(note(empty), drawn)).toBeNull();
	});

	it('ignores leading and trailing whitespace, the way the caller stores it', () => {
		expect(findUniqueInkBlockByBody(['```inkling', `  ${drawn}  `, '```'], drawn)).toEqual({ lineStart: 0, lineEnd: 2 });
	});

	it('does not treat a fence of another language as an ink block', () => {
		expect(findUniqueInkBlockByBody(['```js', drawn, '```'], drawn)).toBeNull();
	});
});
