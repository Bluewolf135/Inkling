import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BLOCK_HEIGHT,
	DEFAULT_BLOCK_WIDTH,
	INK_BLOCK_VERSION,
	emptyInkBlock,
	parseInkBlock,
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
