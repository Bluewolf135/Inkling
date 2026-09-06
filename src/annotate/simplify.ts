import { Point } from './types';

// How far the simplified stroke is allowed to stray from the samples it
// replaces, in the surface's own units.
//
// A block is stored 800 units wide and shown at around 700 CSS pixels, so
// half a unit is under half a pixel — below the size of the thing drawing
// it, and well below anything a person can see. On a canvas backed at
// higher resolution (see MAX_SURFACE_SCALE in src/markdown/inkBlock.ts) a
// surface unit is smaller still, so this only ever gets more conservative,
// never less.
//
// Why this is worth doing at all: a 120Hz stylus reports about 600 samples
// in a five-second stroke and every one of them used to be kept, written
// to the file, parsed back, and walked on every redraw. Most of them sit
// almost exactly where their neighbours already imply. Dropping those
// costs nothing visible and takes the majority of the points with it.
export const SIMPLIFY_EPSILON = 0.5;

// Distance from `p` to the segment ab.
//
// The zero-length case is not defensive: a stroke that ends where it
// started — circling a word, which people do constantly — makes the very
// first segment RDP examines a point rather than a line, and perpendicular
// distance to it is undefined. Falling back to plain distance is what makes
// a closed loop simplify correctly instead of collapsing.
function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

	// Clamped, so a point beyond either end measures to the endpoint rather
	// than to the infinite line the segment lies on.
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Ramer–Douglas–Peucker: drops every sample that sits within `epsilon` of
// the line its surviving neighbours already describe.
//
// Points are returned by reference, not copied, so whatever pressure a
// surviving sample carried comes with it untouched. Simplification runs on
// position alone — pressure varies smoothly enough along a stroke that
// interpolating it across a dropped run is indistinguishable from having
// kept it, and a pressure-aware distance metric would be a lot of
// machinery for a difference nobody can see.
//
// Written iteratively rather than as the usual recursion. Ninety seconds of
// unbroken writing at 120Hz is ten thousand samples, and the recursive form
// nests once per retained point in the worst case — a stack overflow in the
// middle of committing someone's handwriting is not an acceptable way to
// find that out.
export function simplifyPoints(points: Point[], epsilon: number): Point[] {
	if (points.length < 3) return points;

	const keep = new Array<boolean>(points.length).fill(false);
	keep[0] = true;
	keep[points.length - 1] = true;

	const ranges: Array<[number, number]> = [[0, points.length - 1]];
	while (ranges.length > 0) {
		const range = ranges.pop();
		if (!range) break;
		const [start, end] = range;

		const from = points[start];
		const to = points[end];
		if (!from || !to) continue;

		let farthest = -1;
		let farthestDistance = 0;
		for (let index = start + 1; index < end; index++) {
			const point = points[index];
			if (!point) continue;
			const distance = distanceToSegment(point, from, to);
			if (distance > farthestDistance) {
				farthestDistance = distance;
				farthest = index;
			}
		}

		// Everything between start and end is within epsilon of the straight
		// line between them, so the whole run is already described by its two
		// ends and none of it needs keeping.
		if (farthest < 0 || farthestDistance <= epsilon) continue;

		keep[farthest] = true;
		ranges.push([start, farthest], [farthest, end]);
	}

	const simplified: Point[] = [];
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		if (keep[index] && point) simplified.push(point);
	}
	return simplified;
}
