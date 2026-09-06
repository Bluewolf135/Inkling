import { describe, expect, it } from 'vitest';
import { SIMPLIFY_EPSILON, simplifyPoints } from '../../src/annotate/simplify';
import type { Point } from '../../src/annotate/types';

// Distance from `p` to the segment ab — the same measure simplifyPoints
// thresholds on, restated here so the tests check the guarantee rather
// than the implementation.
function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// How far the simplified polyline strays from the original points. RDP's
// guarantee is that this never exceeds epsilon, which is the whole reason
// dropping points is safe.
function maxDeviation(original: Point[], simplified: Point[]): number {
	let worst = 0;
	for (const point of original) {
		let best = Infinity;
		for (let i = 0; i < simplified.length - 1; i++) {
			const a = simplified[i];
			const b = simplified[i + 1];
			if (!a || !b) continue;
			best = Math.min(best, distanceToSegment(point, a, b));
		}
		worst = Math.max(worst, best);
	}
	return worst;
}

describe('simplifyPoints', () => {
	it('returns a stroke of two points untouched', () => {
		const points: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
		expect(simplifyPoints(points, 1)).toEqual(points);
	});

	it('returns a single point untouched', () => {
		const points: Point[] = [{ x: 3, y: 4 }];
		expect(simplifyPoints(points, 1)).toEqual(points);
	});

	it('collapses a straight run to its endpoints', () => {
		const points: Point[] = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 2, y: 0 },
			{ x: 3, y: 0 },
			{ x: 4, y: 0 },
		];
		expect(simplifyPoints(points, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
	});

	it('keeps a point that strays further than epsilon', () => {
		const points: Point[] = [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }];
		expect(simplifyPoints(points, 1)).toHaveLength(3);
	});

	it('drops a point that strays less than epsilon', () => {
		const points: Point[] = [{ x: 0, y: 0 }, { x: 5, y: 0.2 }, { x: 10, y: 0 }];
		expect(simplifyPoints(points, 1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
	});

	it('always keeps the first and last point', () => {
		const points: Point[] = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
		const simplified = simplifyPoints(points, 100);
		expect(simplified[0]).toEqual({ x: 0, y: 0 });
		expect(simplified[simplified.length - 1]).toEqual({ x: 49, y: 0 });
	});

	it('carries pressure through on the endpoints when the middle is dropped', () => {
		const points: Point[] = [
			{ x: 0, y: 0, p: 0.1 },
			{ x: 5, y: 0.05, p: 0.5 },
			{ x: 10, y: 0, p: 0.9 },
		];
		const simplified = simplifyPoints(points, 1);
		expect(simplified).toEqual([{ x: 0, y: 0, p: 0.1 }, { x: 10, y: 0, p: 0.9 }]);
	});

	it('carries pressure through on a middle point it keeps', () => {
		const points: Point[] = [
			{ x: 0, y: 0, p: 0.1 },
			{ x: 5, y: 5, p: 0.5 },
			{ x: 10, y: 0, p: 0.9 },
		];
		expect(simplifyPoints(points, 1)).toEqual(points);
	});

	it('does not mutate the points it was given', () => {
		const points: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: 0 }];
		const copy = structuredClone(points);
		simplifyPoints(points, 1);
		expect(points).toEqual(copy);
	});

	// A stroke that starts and ends in the same place makes the outer
	// segment zero-length, so perpendicular distance is undefined and has
	// to fall back to plain point distance. Circling something is a normal
	// thing to draw, so this is a real case rather than a contrived one.
	it('handles a closed loop, where the end returns to the start', () => {
		const points: Point[] = [];
		for (let i = 0; i <= 64; i++) {
			const angle = (i / 64) * Math.PI * 2;
			points.push({ x: 50 + Math.cos(angle) * 20, y: 50 + Math.sin(angle) * 20 });
		}
		const simplified = simplifyPoints(points, 0.5);
		expect(simplified.length).toBeGreaterThan(4);
		expect(simplified.length).toBeLessThan(points.length);
		expect(maxDeviation(points, simplified)).toBeLessThanOrEqual(0.5 + 1e-9);
	});

	// The point of the whole exercise: a densely sampled handwriting-like
	// stroke should lose most of its points while staying visually identical.
	it('drops most of a densely sampled stroke without straying past epsilon', () => {
		const points: Point[] = [];
		for (let i = 0; i < 600; i++) {
			const t = i / 10;
			points.push({ x: t * 2, y: 40 * Math.sin(t / 3) + 8 * Math.sin(t), p: 0.5 });
		}

		const simplified = simplifyPoints(points, SIMPLIFY_EPSILON);
		expect(simplified.length).toBeLessThan(points.length * 0.4);
		expect(maxDeviation(points, simplified)).toBeLessThanOrEqual(SIMPLIFY_EPSILON + 1e-9);
	});

	// Ten thousand samples is about ninety seconds of unbroken writing at
	// 120Hz. A recursive implementation can blow the stack on a run like
	// that; this is here to keep it iterative.
	it('handles a very long stroke without overflowing the stack', () => {
		const points: Point[] = Array.from({ length: 10_000 }, (_, i) => ({ x: i * 0.01, y: 0 }));
		expect(() => simplifyPoints(points, SIMPLIFY_EPSILON)).not.toThrow();
	});
});
