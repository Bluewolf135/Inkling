import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { storedAnnotation } from '../../src/markdown/inkBlockFormat';
import { decodeStrokes, encodeStrokes, fromBase64, toBase64 } from '../../src/markdown/inkFileCodec';

// The codec is the only code that sees inside `strokes`. Everything above it
// treats the string as opaque, so what this has to get right is small and
// absolute: what goes in comes out, and anything that does not come out
// cleanly says so rather than inflating into plausible nonsense.

afterEach(() => {
	vi.unstubAllGlobals();
});

function pressureStroke(id: string): Annotation {
	return {
		id,
		kind: 'stroke',
		tool: 'pen',
		color: '#1e1e1e',
		width: 2,
		points: [
			{ x: 10, y: 20, p: 0.5 },
			{ x: 30.5, y: 40, p: 0.75 },
			{ x: 50, y: 60 },
		],
	};
}

function shape(id: string): Annotation {
	return { id, kind: 'shape', tool: 'oval', color: '#e03131', width: 3, start: { x: 1, y: 2 }, end: { x: 100, y: 80 } };
}

// A page of handwriting shaped the way real ink is: long strokes of nearby
// points at a tenth of a unit, which is what the compression ratio in the
// spec was measured on. Deterministic, so the size assertion cannot flake.
function handwriting(strokes: number, pointsPerStroke: number): Annotation[] {
	const annotations: Annotation[] = [];
	for (let s = 0; s < strokes; s++) {
		const points = [];
		for (let p = 0; p < pointsPerStroke; p++) {
			points.push({
				x: Math.round((40 + s * 7 + p * 1.3 + Math.sin(p / 3) * 4) * 10) / 10,
				y: Math.round((60 + (s % 12) * 30 + Math.cos(p / 4) * 6) * 10) / 10,
				p: Math.round((0.4 + 0.3 * Math.sin(p / 5)) * 100) / 100,
			});
		}
		annotations.push({ id: `ink-${s}`, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points });
	}
	return annotations;
}

function written(annotations: readonly Annotation[]): string {
	return JSON.stringify(annotations.map(storedAnnotation));
}

describe('base64', () => {
	it('round-trips every byte value, across the chunk boundary', () => {
		const bytes = new Uint8Array(70_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
		expect(fromBase64(toBase64(bytes))).toEqual(bytes);
	});

	it('refuses text that is not base64', () => {
		expect(fromBase64('not base64!')).toBeNull();
		expect(fromBase64('abc')).toBeNull();
		expect(fromBase64('ab{}')).toBeNull();
	});
});

describe('encoding and decoding strokes', () => {
	it('round-trips a stroke with pressure and a shape', async () => {
		const annotations = [pressureStroke('a'), shape('b')];
		const { strokes, codec } = await encodeStrokes(annotations);
		expect(codec).toBe('deflate');

		const decoded = await decodeStrokes(strokes, undefined);
		expect(decoded.kind).toBe('decoded');
		if (decoded.kind !== 'decoded') return;
		expect(decoded.annotations.map(storedAnnotation)).toEqual(annotations.map(storedAnnotation));
	});

	it('round-trips an empty block to a payload that is not empty', async () => {
		const { strokes } = await encodeStrokes([]);
		expect(strokes.length).toBeGreaterThan(0);
		expect(await decodeStrokes(strokes, undefined)).toEqual({ kind: 'decoded', annotations: [] });
	});

	it('stores a page of handwriting in well under half the bytes of its JSON', async () => {
		const annotations = handwriting(120, 150);
		const { strokes } = await encodeStrokes(annotations);
		expect(strokes.length).toBeLessThan(written(annotations).length * 0.5);
	});

	it('falls back to uncompressed base64 where the platform cannot deflate', async () => {
		vi.stubGlobal('CompressionStream', undefined);
		vi.stubGlobal('DecompressionStream', undefined);

		const annotations = [pressureStroke('a')];
		const { strokes, codec } = await encodeStrokes(annotations);
		expect(codec).toBe('none');

		const decoded = await decodeStrokes(strokes, 'none');
		expect(decoded.kind).toBe('decoded');
	});

	it('reports a deflated block as unsupported, not broken, where the platform cannot inflate', async () => {
		const { strokes } = await encodeStrokes([pressureStroke('a')]);
		vi.stubGlobal('DecompressionStream', undefined);

		expect(await decodeStrokes(strokes, undefined)).toEqual({ kind: 'unsupported', codec: 'deflate' });
	});

	it('reports a codec it has never heard of as unsupported', async () => {
		expect(await decodeStrokes('AAAA', 'zstd')).toEqual({ kind: 'unsupported', codec: 'zstd' });
	});

	it('refuses a block whose Adler-32 trailer does not match', async () => {
		const { strokes } = await encodeStrokes([pressureStroke('a')]);
		const bytes = fromBase64(strokes);
		if (!bytes) throw new Error('encoder produced invalid base64');
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;

		expect(await decodeStrokes(toBase64(bytes), undefined)).toEqual({ kind: 'undecodable' });
	});

	it('refuses a payload that is not base64, or not a string', async () => {
		expect(await decodeStrokes('%%%%', undefined)).toEqual({ kind: 'undecodable' });
		expect(await decodeStrokes(42, undefined)).toEqual({ kind: 'undecodable' });
		expect(await decodeStrokes('', undefined)).toEqual({ kind: 'undecodable' });
	});

	it('refuses a payload holding any annotation it cannot read, rather than keeping the rest', async () => {
		const json = JSON.stringify([storedAnnotation(pressureStroke('a')), { id: 'b', kind: 'stroke', tool: 'nope' }]);
		const strokes = toBase64(new TextEncoder().encode(json));
		expect(await decodeStrokes(strokes, 'none')).toEqual({ kind: 'undecodable' });
	});
});
