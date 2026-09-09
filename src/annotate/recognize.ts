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

// How far a closed loop may sit from whichever shape it matches best,
// averaged per sample and measured in units of its own bounding box, before
// it counts as neither and is left alone.
//
// Every real figure measured while writing this — lumpy circles, ovals up
// to 2.5x wide, boxes with rounded corners and bowed edges — fits its own
// shape to within 0.031. Everything that should be refused (a triangle, a
// diamond, a figure eight, a scribbled blob) sits at 0.093 or worse, since
// it is not close to *either* shape. This sits between, nearer the figures,
// because the cost of a false negative is that nothing happens and the cost
// of a false positive is a word of handwriting replaced by a box.
const MAX_SHAPE_RESIDUAL = 0.06;

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

// How far a closed loop sits from each of the two shapes it could snap to,
// as a mean distance per sample.
//
// This asks the question the answer is actually needed for — "of the oval
// and the rectangle I am about to draw, which is closer to what you drew?"
// — rather than scoring some abstract property of the loop and reading a
// shape off a threshold. Both candidates are fully determined before the
// measurement, because a snapped shape takes the stroke's own bounding box
// either way, so each can simply be scored against the samples.
//
// Two earlier measures failed here, both by scoring roundness on its own.
// A radial variance taken on the raw loop asked "is it round?", which
// nothing drawn freehand is: an ellipse 1.3x wider than tall scored 0.089
// against a 0.07 threshold and came out a rectangle. Taking that same
// variance on the normalised loop fixed the ellipses and still failed,
// because a hand's error is not the per-sample jitter the tests modelled —
// it is low-frequency lumpiness, two or three broad bulges around the loop,
// which does not average out of a variance the way jitter does. Measured
// against realistic strokes, circles ran 0.055-0.134 and boxes 0.073-0.093:
// overlapping ranges, no threshold to put between them, and a "very rounded
// box" at 0.073 indistinguishable from a hand circle at 0.077.
//
// Scoring both candidates instead separates them by a factor of two or more
// in every case, and for a reason worth stating: lumpiness pushes a loop
// away from *both* candidates roughly evenly, so it costs the winner and
// the loser alike and leaves the comparison standing. A single-property
// measure has no such protection — the noise all lands on the one number
// the decision is read from.
//
// Judged on the loop squashed into a unit box, so proportion never decides
// it: a wide oval and a round one score alike, as do a wide box and a
// square. Only how the loop is *judged* is normalised — the shape that
// lands keeps the bounds the pen drew.
function shapeResiduals(
	points: Point[],
	box: { minX: number; minY: number; maxX: number; maxY: number },
): { oval: number; rectangle: number } {
	// A degenerate axis would divide by zero; the caller has already
	// rejected a loop that flat, so 1 here only guards the arithmetic.
	const width = box.maxX - box.minX || 1;
	const height = box.maxY - box.minY || 1;

	let oval = 0;
	let rectangle = 0;
	for (const point of points) {
		// Offsets from the centre of the unit box, so both candidates are
		// centred on the origin and the arithmetic below stays symmetric.
		const x = Math.abs((point.x - box.minX) / width - 0.5);
		const y = Math.abs((point.y - box.minY) / height - 0.5);

		// The inscribed circle: how far this sample is off its edge.
		oval += Math.abs(Math.hypot(x, y) - 0.5);

		// The box's own outline. Inside, the nearest edge is whichever axis
		// the sample sits furthest along; outside — where an overshooting
		// stroke puts it — it is the straight-line distance back in.
		rectangle +=
			x > 0.5 || y > 0.5 ? Math.hypot(Math.max(x - 0.5, 0), Math.max(y - 0.5, 0)) : 0.5 - Math.max(x, y);
	}

	return { oval: oval / points.length, rectangle: rectangle / points.length };
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

	const fit = shapeResiduals(points, box);

	// Close to neither: a triangle, a diamond, a figure eight, a blob. The
	// perimeter check above catches a loop that wanders, but not one that
	// goes cleanly round a shape this cannot draw — and turning a triangle
	// into whichever of the two it happens to sit nearer is a worse answer
	// than leaving it as drawn.
	if (Math.min(fit.oval, fit.rectangle) > MAX_SHAPE_RESIDUAL) return null;

	const start = { x: box.minX, y: box.minY };
	const end = { x: box.maxX, y: box.maxY };
	return fit.oval < fit.rectangle ? { tool: 'oval', start, end } : { tool: 'rectangle', start, end };
}
