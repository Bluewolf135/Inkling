import { Point, ShapeToolType } from './types';

// Turning a rough stroke into a clean shape.
//
// Pure, and deliberately conservative: the cost of a false negative is that
// nothing happens, which is what the user was going to get anyway. The cost
// of a false positive is a word of handwriting silently replaced by a
// rectangle, which is destructive and baffling. Every threshold here is set
// to fail toward doing nothing.

export interface RecognizedShape {
	tool: ShapeToolType;
	start: Point;
	end: Point;
}

// A stroke that deviates from its own chord by less than this fraction of
// the chord's length is a line. Generous, because a line drawn freehand by
// someone resting on their wrist bows noticeably.
const LINE_STRAIGHTNESS = 0.08;

// Endpoints closer than this fraction of the total path length count as
// having met, so the stroke is a closed loop.
const CLOSURE_RATIO = 0.15;

// How much the distance from the centroid may vary, relative to its mean,
// for a closed loop to be a circle rather than a box.
//
// Measured against the *normalised* loop (see radialVariance), where the
// figure is judged on shape alone and not on how wide it happens to be:
// any ellipse runs 0.016 and any rectangle 0.115, whatever its aspect. The
// threshold sits between them, nearer the ellipse, because a box misread as
// a circle is the more visible mistake. A hand wobbling +-10px inside a
// palm-sized loop moves an ellipse to about 0.04 and a box to about 0.125,
// so the gap survives a real hand.
const OVAL_RADIAL_VARIANCE = 0.07;

// How far a closed loop’s path length may sit either side of its
// bounding box’s perimeter. A circle runs about 0.79 of it and a square
// exactly 1.0, while a scribble — which doubles back over itself — runs
// far higher. Without this, anything that happens to start and end near
// the same place is a rectangle, which is how a scribbled-out word gets
// silently replaced by a box.
const MIN_PERIMETER_RATIO = 0.6;
const MAX_PERIMETER_RATIO = 1.35;

// A stroke needs this many samples before its shape means anything. Below
// it, direction estimates are noise.
const MIN_SAMPLES = 8;

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points: Point[]): number {
	let total = 0;
	for (let index = 1; index < points.length; index++) {
		const previous = points[index - 1];
		const current = points[index];
		if (previous && current) total += distance(previous, current);
	}
	return total;
}

function perpendicularDistance(point: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) return distance(point, a);
	return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

function bounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// How nearly a closed loop's samples all sit the same distance from its
// centre. Low for a circle, high for a rectangle, whose corners are much
// further out than its edge midpoints.
//
// Measured on the loop squashed into a unit box first, which is the whole
// trick. Raw, this asks "is it round?", and almost nothing anyone draws
// freehand is: an ellipse only 1.3x wider than it is tall already scores
// 0.089 and was classified a rectangle, so in practice a circle could not
// be drawn at all - the reported symptom. Normalised, it asks the question
// actually worth asking, "is it an ellipse or a box?", and every ellipse
// answers alike whatever its proportions.
function radialVariance(points: Point[], box: { minX: number; minY: number; maxX: number; maxY: number }): number {
	// A degenerate axis would divide by zero; the caller has already
	// rejected a loop that flat, so 1 here only guards the arithmetic.
	const width = box.maxX - box.minX || 1;
	const height = box.maxY - box.minY || 1;
	const unit = points.map((point) => ({ x: (point.x - box.minX) / width, y: (point.y - box.minY) / height }));

	const centroid = unit.reduce((sum, point) => ({ x: sum.x + point.x / unit.length, y: sum.y + point.y / unit.length }), {
		x: 0,
		y: 0,
	});
	const radii = unit.map((point) => distance(point, centroid));
	const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
	if (mean === 0) return Infinity;
	const variance = radii.reduce((sum, radius) => sum + (radius - mean) ** 2, 0) / radii.length;
	return Math.sqrt(variance) / mean;
}

export function recognizeShape(points: Point[]): RecognizedShape | null {
	if (points.length < MIN_SAMPLES) return null;

	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) return null;

	const length = pathLength(points);
	// A stroke with no length is a tap, not a shape.
	if (length === 0) return null;

	const box = bounds(points);
	const width = box.maxX - box.minX;
	const height = box.maxY - box.minY;

	const closed = distance(first, last) <= length * CLOSURE_RATIO;

	if (!closed) {
		// Straightness is measured against the chord the stroke actually
		// spans, so a long gentle bow and a short sharp one are judged the
		// same way.
		const chord = distance(first, last);
		if (chord === 0) return null;
		let deviation = 0;
		for (const point of points) deviation = Math.max(deviation, perpendicularDistance(point, first, last));
		if (deviation <= chord * LINE_STRAIGHTNESS) {
			return { tool: 'line', start: first, end: last };
		}
		// Not straight, not closed — a letter, a tick, a scribble. Left
		// alone, which is the whole point.
		return null;
	}

	// A closed loop with almost no extent is a dot, not a circle.
	if (width < 1 || height < 1) return null;

	// Does the loop go more or less straight round its own bounds, or
	// does it wander? See MIN/MAX_PERIMETER_RATIO.
	const perimeter = 2 * (width + height);
	const ratio = length / perimeter;
	if (ratio < MIN_PERIMETER_RATIO || ratio > MAX_PERIMETER_RATIO) return null;

	const start = { x: box.minX, y: box.minY };
	const end = { x: box.maxX, y: box.maxY };
	return radialVariance(points, box) <= OVAL_RADIAL_VARIANCE
		? { tool: 'oval', start, end }
		: { tool: 'rectangle', start, end };
}
