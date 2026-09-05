import { describe, expect, it } from 'vitest';
import { MIN_PRESSURE_SCALE, hasPressure, outlinePath, smoothedPath } from '../../src/annotate/stroke';
import type { Point } from '../../src/annotate/types';

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

// The width the outline actually has at sample `index`, measured rather
// than asserted from the formula — the ring runs down one side and back up
// the other, so a sample's two offset points sit at mirrored positions.
function outlineWidthAt(ring: Point[], sampleCount: number, index: number): number {
	const left = ring[index];
	const right = ring[2 * sampleCount - 1 - index];
	if (!left || !right) throw new Error('outline is not the expected shape');
	return distance(left, right);
}

describe('hasPressure', () => {
	it('is false for points that carry none', () => {
		expect(hasPressure([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);
	});

	it('is true as soon as one point carries a usable value', () => {
		expect(hasPressure([{ x: 0, y: 0 }, { x: 1, y: 1, p: 0.4 }])).toBe(true);
	});

	it('ignores values that are not usable numbers', () => {
		// A stroke whose pressure is NaN is a stroke with no pressure, not a
		// stroke that should be drawn with NaN-wide ink.
		expect(hasPressure([{ x: 0, y: 0, p: Number.NaN }])).toBe(false);
		expect(hasPressure([{ x: 0, y: 0, p: Number.POSITIVE_INFINITY }])).toBe(false);
	});
});

describe('smoothedPath', () => {
	it('has nothing to draw for an empty stroke', () => {
		expect(smoothedPath([])).toEqual([]);
	});

	it('draws a single point as a bare move', () => {
		expect(smoothedPath([{ x: 5, y: 5 }])).toEqual([{ kind: 'move', to: { x: 5, y: 5 } }]);
	});

	it('draws two points as a straight line — there is no curve to fit', () => {
		expect(smoothedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual([
			{ kind: 'move', to: { x: 0, y: 0 } },
			{ kind: 'line', to: { x: 10, y: 0 } },
		]);
	});

	it('puts a quadratic through each interior point', () => {
		const path = smoothedPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
		expect(path.map((segment) => segment.kind)).toEqual(['move', 'line', 'quad', 'line']);
		// The curve's control point *is* the sampled point, and it runs to
		// the midpoint of the next pair. That is what makes the scheme
		// reproducible in a PDF content stream without a second opinion
		// about tension or lookahead.
		expect(path[2]).toEqual({ kind: 'quad', control: { x: 10, y: 10 }, to: { x: 15, y: 5 } });
	});

	it('ends exactly where the pen was lifted', () => {
		// Smoothing may cut corners in the middle; it must not move the last
		// point, or a stroke would end somewhere the user did not stop.
		const points: Point[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 30 },
			{ x: 25, y: 5 },
			{ x: 40, y: 40 },
			{ x: 61, y: 7 },
		];
		const path = smoothedPath(points);
		expect(path[0]).toEqual({ kind: 'move', to: { x: 0, y: 0 } });
		expect(path[path.length - 1]).toEqual({ kind: 'line', to: { x: 61, y: 7 } });
	});

	it('produces one quadratic per interior point', () => {
		const points = Array.from({ length: 12 }, (_, index) => ({ x: index * 3, y: index % 2 === 0 ? 0 : 4 }));
		expect(smoothedPath(points).filter((segment) => segment.kind === 'quad')).toHaveLength(points.length - 2);
	});

	it('survives repeated identical samples without producing NaN', () => {
		// A stylus held still still reports moves.
		const path = smoothedPath([{ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }, { x: 9, y: 3 }]);
		for (const segment of path) {
			expect(Number.isFinite(segment.to.x)).toBe(true);
			expect(Number.isFinite(segment.to.y)).toBe(true);
			if (segment.kind === 'quad') {
				expect(Number.isFinite(segment.control.x)).toBe(true);
				expect(Number.isFinite(segment.control.y)).toBe(true);
			}
		}
	});
});

describe('outlinePath', () => {
	const straight: Point[] = [
		{ x: 0, y: 0 },
		{ x: 50, y: 0 },
		{ x: 100, y: 0 },
	];

	it('returns a closed ring with two points per sample', () => {
		const ring = outlinePath(straight, 10);
		expect(ring).toHaveLength(2 * straight.length + 1);
		expect(ring[ring.length - 1]).toEqual(ring[0]);
	});

	it('is exactly the base width where pressure is full', () => {
		const ring = outlinePath(straight.map((point) => ({ ...point, p: 1 })), 10);
		expect(outlineWidthAt(ring, straight.length, 1)).toBeCloseTo(10, 6);
	});

	it('thins to the floor where pressure is nothing, without vanishing', () => {
		// A light touch has to thin the line, not break it — an outline of
		// zero width is an invisible stroke, which reads as ink that failed
		// to record.
		const ring = outlinePath(straight.map((point) => ({ ...point, p: 0 })), 10);
		expect(outlineWidthAt(ring, straight.length, 1)).toBeCloseTo(10 * MIN_PRESSURE_SCALE, 6);
	});

	it('varies along the stroke as the pressure does', () => {
		const ring = outlinePath(
			[
				{ x: 0, y: 0, p: 1 },
				{ x: 50, y: 0, p: 0.5 },
				{ x: 100, y: 0, p: 0 },
			],
			10,
		);
		const widths = [0, 1, 2].map((index) => outlineWidthAt(ring, 3, index));
		expect(widths[0]).toBeGreaterThan(widths[1] ?? 0);
		expect(widths[1]).toBeGreaterThan(widths[2] ?? 0);
	});

	it('treats a point with no pressure as full pressure', () => {
		// So a stroke that only sometimes reported pressure does not develop
		// a hairline gap wherever the report was missing.
		const ring = outlinePath(straight, 10);
		expect(outlineWidthAt(ring, straight.length, 1)).toBeCloseTo(10, 6);
	});

	it('offsets perpendicular to the stroke', () => {
		const ring = outlinePath(straight.map((point) => ({ ...point, p: 1 })), 10);
		// A horizontal stroke's edges sit directly above and below it.
		expect(ring[1]?.x).toBeCloseTo(50, 6);
		expect(Math.abs(ring[1]?.y ?? 0)).toBeCloseTo(5, 6);
	});

	it('has nothing to draw for a stroke with no length', () => {
		expect(outlinePath([], 10)).toEqual([]);
		expect(outlinePath([{ x: 1, y: 1 }], 10)).toEqual([]);
		// Two samples at the same place have no direction to be
		// perpendicular to, and dividing by that would put NaN in the file.
		expect(outlinePath([{ x: 1, y: 1 }, { x: 1, y: 1 }], 10)).toEqual([]);
	});

	it('never emits a non-finite coordinate', () => {
		const jittery: Point[] = [
			{ x: 0, y: 0, p: 0.2 },
			{ x: 0, y: 0, p: 0.9 },
			{ x: 10, y: 0, p: 1 },
			{ x: 10, y: 0, p: 0.1 },
			{ x: 10, y: 12, p: 0.5 },
		];
		for (const point of outlinePath(jittery, 6)) {
			expect(Number.isFinite(point.x)).toBe(true);
			expect(Number.isFinite(point.y)).toBe(true);
		}
	});
});
