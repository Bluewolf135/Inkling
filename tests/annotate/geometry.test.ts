import { describe, expect, it } from 'vitest';
import {
	boundingBox,
	clampPointToBounds,
	clampRectToBounds,
	clampTranslation,
	distanceToSegment,
	hitTestAnnotation,
	normalizeRect,
	pointInPolygon,
	polygonEnclosesAnnotation,
	scaleAnnotation,
	translateAnnotation,
} from '../../src/annotate/geometry';
import type { Annotation, Point, StrokeAnnotation } from '../../src/annotate/types';

function stroke(points: Point[], width = 3): StrokeAnnotation {
	return { id: 'ink-test', kind: 'stroke', tool: 'pen', color: '#000000', width, points };
}

describe('distanceToSegment', () => {
	it('measures perpendicular distance to the segment body', () => {
		expect(distanceToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
	});

	it('clamps past an endpoint rather than extending the line', () => {
		expect(distanceToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
	});

	it('degrades to point distance for a zero-length segment', () => {
		expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
	});
});

describe('hitTestAnnotation', () => {
	// The tolerance floor is generous on purpose (MIN_HIT_TOLERANCE = 10),
	// because a fingertip or an imprecise pen tap has to be able to hit a
	// one-pixel line.
	it('hits a thin stroke from within the tolerance floor', () => {
		expect(hitTestAnnotation(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 9 })).toBe(true);
	});

	it('misses beyond the tolerance floor', () => {
		expect(hitTestAnnotation(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 40 })).toBe(false);
	});

	it('widens tolerance with the stroke, so a fat line is no harder to hit', () => {
		expect(hitTestAnnotation(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }], 40), { x: 50, y: 20 })).toBe(true);
	});

	it('treats a rectangle as a filled region, not just its outline', () => {
		const rect: Annotation = {
			id: 'ink-r',
			kind: 'shape',
			tool: 'rectangle',
			color: '#000000',
			width: 2,
			start: { x: 0, y: 0 },
			end: { x: 100, y: 100 },
		};
		expect(hitTestAnnotation(rect, { x: 50, y: 50 })).toBe(true);
	});
});

describe('polygonEnclosesAnnotation', () => {
	const square: Point[] = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 0, y: 100 },
	];

	it('selects a stroke fully inside the lasso', () => {
		expect(polygonEnclosesAnnotation(stroke([{ x: 10, y: 10 }, { x: 90, y: 90 }]), square)).toBe(true);
	});

	it('rejects a stroke the lasso only crosses', () => {
		expect(polygonEnclosesAnnotation(stroke([{ x: 10, y: 10 }, { x: 900, y: 90 }]), square)).toBe(false);
	});

	it('rejects an oval whose corners escape even though its endpoints do not', () => {
		// extentPoints uses all four corners of a rectangle/oval for exactly
		// this case: a lasso can surround the start/end diagonal while
		// cutting through one of the other two corners.
		const oval: Annotation = {
			id: 'ink-o',
			kind: 'shape',
			tool: 'oval',
			color: '#000000',
			width: 2,
			start: { x: 10, y: 10 },
			end: { x: 150, y: 90 },
		};
		expect(polygonEnclosesAnnotation(oval, square)).toBe(false);
	});
});

describe('pointInPolygon', () => {
	it('returns false for a degenerate polygon', () => {
		expect(pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 2, y: 2 }])).toBe(false);
	});

	it('treats the polygon as closed even when the caller did not close it', () => {
		const open: Point[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		expect(pointInPolygon({ x: 5, y: 5 }, open)).toBe(true);
		expect(pointInPolygon({ x: 15, y: 5 }, open)).toBe(false);
	});
});

describe('transforms', () => {
	it('translates every point of a stroke', () => {
		const moved = translateAnnotation(stroke([{ x: 0, y: 0 }, { x: 10, y: 10 }]), 5, -5);
		expect(moved).toMatchObject({ points: [{ x: 5, y: -5 }, { x: 15, y: 5 }] });
	});

	it('keeps a degenerate axis unscaled instead of dividing by zero', () => {
		const flat = stroke([{ x: 0, y: 50 }, { x: 10, y: 50 }]);
		const scaled = scaleAnnotation(
			flat,
			{ minX: 0, minY: 50, maxX: 10, maxY: 50 },
			{ minX: 0, minY: 50, maxX: 20, maxY: 50 },
		);
		expect(scaled).toMatchObject({ points: [{ x: 0, y: 50 }, { x: 20, y: 50 }] });
	});

	it('normalizes a rect drawn right-to-left', () => {
		expect(normalizeRect({ x: 10, y: 10 }, { x: 0, y: 0 })).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
	});

	it('bounds a stroke by its extremes', () => {
		expect(boundingBox(stroke([{ x: 5, y: 9 }, { x: 1, y: 2 }]))).toEqual({ minX: 1, minY: 2, maxX: 5, maxY: 9 });
	});
});

// A note is a marker pinned to a spot, not a shape with extent — so it hits
// like a target, moves like a point, and deliberately does not grow.
describe('note annotations', () => {
	const note: Annotation = {
		id: 'ink-n',
		kind: 'note',
		color: '#f08c00',
		width: 3,
		at: { x: 100, y: 100 },
		note: 'check this',
	};

	it('is hit anywhere within its marker', () => {
		expect(hitTestAnnotation(note, { x: 100, y: 100 })).toBe(true);
		expect(hitTestAnnotation(note, { x: 106, y: 104 })).toBe(true);
	});

	it('is missed from well outside it', () => {
		expect(hitTestAnnotation(note, { x: 140, y: 100 })).toBe(false);
	});

	it('bounds itself around its point', () => {
		const box = boundingBox(note);
		expect((box.minX + box.maxX) / 2).toBe(100);
		expect((box.minY + box.maxY) / 2).toBe(100);
		expect(box.maxX - box.minX).toBeGreaterThan(0);
	});

	it('moves with a translate', () => {
		expect(translateAnnotation(note, 10, -20)).toMatchObject({ at: { x: 110, y: 80 } });
	});

	it('moves with a resize but does not grow with it', () => {
		// The marker is chrome at a fixed size, not geometry. Scaling it would
		// make a pin the size of a paragraph.
		const scaled = scaleAnnotation(
			note,
			{ minX: 0, minY: 0, maxX: 200, maxY: 200 },
			{ minX: 0, minY: 0, maxX: 400, maxY: 400 },
		);
		expect(scaled).toMatchObject({ at: { x: 200, y: 200 } });
		const before = boundingBox(note);
		const after = boundingBox(scaled);
		expect(after.maxX - after.minX).toBe(before.maxX - before.minX);
	});

	it('is selected by a lasso that surrounds its point', () => {
		const square = [
			{ x: 0, y: 0 },
			{ x: 200, y: 0 },
			{ x: 200, y: 200 },
			{ x: 0, y: 200 },
		];
		expect(polygonEnclosesAnnotation(note, square)).toBe(true);
	});
});

describe('clampPointToBounds', () => {
	it('returns an in-bounds point unchanged, and by identity', () => {
		const point = { x: 10, y: 20 };
		expect(clampPointToBounds(point, 800, 450)).toBe(point);
	});

	it('pulls a point back from past the right edge', () => {
		expect(clampPointToBounds({ x: 1200.7, y: 100 }, 800, 450)).toEqual({ x: 800, y: 100 });
	});

	it('pulls a point back from below the bottom edge', () => {
		expect(clampPointToBounds({ x: 100, y: 900 }, 800, 450)).toEqual({ x: 100, y: 450 });
	});

	it('pulls a negative point back to the origin', () => {
		expect(clampPointToBounds({ x: -40, y: -166.9 }, 800, 450)).toEqual({ x: 0, y: 0 });
	});

	it('clamps both axes at once', () => {
		expect(clampPointToBounds({ x: 9000, y: -5 }, 800, 450)).toEqual({ x: 800, y: 0 });
	});

	it('keeps pressure on a point it moves', () => {
		expect(clampPointToBounds({ x: 1000, y: 100, p: 0.62 }, 800, 450)).toEqual({ x: 800, y: 100, p: 0.62 });
	});

	it('leaves a point exactly on the edge alone', () => {
		const point = { x: 800, y: 450 };
		expect(clampPointToBounds(point, 800, 450)).toBe(point);
	});
});

describe('clampTranslation', () => {
	const box = { minX: 100, minY: 100, maxX: 300, maxY: 200 };

	it('leaves a move that stays inside alone', () => {
		expect(clampTranslation(box, 50, 20, 800, 450)).toEqual({ dx: 50, dy: 20 });
	});

	// The selection's own edges are what must stay on the page, not the
	// pointer — clamping the pointer instead would stop a selection short
	// whenever it was grabbed anywhere but its corner.
	it('stops a selection at the right edge rather than the pointer', () => {
		expect(clampTranslation(box, 900, 0, 800, 450).dx).toBe(500);
	});

	it('stops a selection at the left edge', () => {
		expect(clampTranslation(box, -400, 0, 800, 450).dx).toBe(-100);
	});

	it('stops a selection at the top and bottom', () => {
		expect(clampTranslation(box, 0, -400, 800, 450).dy).toBe(-100);
		expect(clampTranslation(box, 0, 900, 800, 450).dy).toBe(250);
	});

	// Nothing can keep a selection bigger than the page inside it, so the
	// rule becomes "do not make it worse" rather than an impossible one.
	it('still allows a selection larger than the page to be nudged', () => {
		const huge = { minX: -50, minY: -50, maxX: 850, maxY: 500 };
		const { dx } = clampTranslation(huge, 500, 0, 800, 450);
		expect(dx).toBeLessThanOrEqual(50);
		expect(dx).toBeGreaterThanOrEqual(-50);
	});
});

describe('clampRectToBounds', () => {
	it('leaves a rect that is already inside alone', () => {
		const rect = { minX: 10, minY: 20, maxX: 100, maxY: 200 };
		expect(clampRectToBounds(rect, 800, 450)).toEqual(rect);
	});

	it('pulls every edge back onto the page', () => {
		expect(clampRectToBounds({ minX: -30, minY: -40, maxX: 900, maxY: 600 }, 800, 450)).toEqual({
			minX: 0,
			minY: 0,
			maxX: 800,
			maxY: 450,
		});
	});

	it('leaves a rect touching the edges exactly alone', () => {
		const rect = { minX: 0, minY: 0, maxX: 800, maxY: 450 };
		expect(clampRectToBounds(rect, 800, 450)).toEqual(rect);
	});
});
