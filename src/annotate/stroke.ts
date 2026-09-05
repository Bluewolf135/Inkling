import { Point } from './types';

// The shape of a stroke, as geometry, with no renderer in it.
//
// Two things draw a stroke: the canvas overlay (src/annotate/render.ts) and
// the PDF appearance stream written into the file (src/pdf/annotationSync.ts).
// They have to agree exactly — ink that looks one way while you draw it and
// another way once saved is worse than either look on its own — so neither
// of them owns the geometry. This does, and being pure it is also the only
// part of stroke rendering that can be tested properly.

export type PathSegment =
	| { kind: 'move'; to: Point }
	| { kind: 'line'; to: Point }
	| { kind: 'quad'; control: Point; to: Point };

// How thin the lightest touch draws, as a fraction of the tool's width. Not
// zero: an outline of no width is an invisible stroke, which reads as ink
// that failed to record rather than as a light line.
export const MIN_PRESSURE_SCALE = 0.35;

export function hasPressure(points: Point[]): boolean {
	return points.some((point) => typeof point.p === 'number' && Number.isFinite(point.p));
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Quadratic midpoint smoothing: the curve passes through the midpoint of
// each consecutive pair of samples, using the sample itself as the control
// point.
//
// Chosen over a spline for having no degrees of freedom. There is no tension
// constant and no lookahead, so the canvas and the PDF cannot arrive at
// different curves from the same points — which a scheme with parameters
// invites, since the two are written months apart in different files.
//
// The last point is reached by a straight line rather than a curve, so a
// stroke always ends exactly where the pen was lifted.
export function smoothedPath(points: Point[]): PathSegment[] {
	const [first, second] = points;
	if (!first) return [];
	if (!second) return [{ kind: 'move', to: first }];

	const path: PathSegment[] = [{ kind: 'move', to: first }];
	if (points.length === 2) {
		path.push({ kind: 'line', to: second });
		return path;
	}

	path.push({ kind: 'line', to: midpoint(first, second) });
	for (let index = 1; index < points.length - 1; index++) {
		const control = points[index];
		const next = points[index + 1];
		if (!control || !next) continue;
		path.push({ kind: 'quad', control, to: midpoint(control, next) });
	}
	const last = points[points.length - 1];
	if (last) path.push({ kind: 'line', to: last });
	return path;
}

// Consecutive duplicates carry no direction, and a direction is what every
// offset below is perpendicular to. A stylus held still still reports
// moves, so this is the common case rather than a defensive one.
function withoutRepeats(points: Point[]): Point[] {
	const kept: Point[] = [];
	for (const point of points) {
		const previous = kept[kept.length - 1];
		if (previous && previous.x === point.x && previous.y === point.y) continue;
		kept.push(point);
	}
	return kept;
}

function halfWidthAt(point: Point, baseWidth: number): number {
	// A point with no pressure draws at full width, so a stroke whose device
	// only sometimes reported pressure doesn't develop a hairline gap
	// wherever the report went missing.
	const pressure = typeof point.p === 'number' && Number.isFinite(point.p) ? Math.min(Math.max(point.p, 0), 1) : 1;
	return (baseWidth * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * pressure)) / 2;
}

// A closed ring around the stroke, wide where the pen pressed and narrow
// where it did not — the shape that gets filled, since neither a canvas
// stroke nor a PDF `S` operator can vary a line's width along its length.
//
// The ring runs down one side of the stroke and back up the other, so a
// sample's two edge points sit at mirrored positions in the array: `index`
// and `2 * sampleCount - 1 - index`. That is what lets a test measure the
// width the outline actually has rather than restate the formula.
export function outlinePath(points: Point[], baseWidth: number): Point[] {
	const samples = withoutRepeats(points);
	if (samples.length < 2) return [];

	const left: Point[] = [];
	const right: Point[] = [];
	let lastNormal: Point | null = null;

	for (let index = 0; index < samples.length; index++) {
		const current = samples[index];
		if (!current) continue;
		// The direction *through* this sample rather than out of it, so a
		// corner's offset splits the difference between its two segments
		// instead of jumping.
		const before = samples[Math.max(0, index - 1)] ?? current;
		const after = samples[Math.min(samples.length - 1, index + 1)] ?? current;
		const dx = after.x - before.x;
		const dy = after.y - before.y;
		const length = Math.hypot(dx, dy);
		// Annotated, because it feeds lastNormal and lastNormal feeds it back:
		// without this the type is self-referential and inferred as any.
		const normal: Point | null = length > 0 ? { x: -dy / length, y: dx / length } : lastNormal;
		if (!normal) continue;
		lastNormal = normal;

		const half = halfWidthAt(current, baseWidth);
		left.push({ x: current.x + normal.x * half, y: current.y + normal.y * half });
		right.push({ x: current.x - normal.x * half, y: current.y - normal.y * half });
	}

	if (left.length < 2) return [];
	const ring = [...left, ...right.reverse()];
	const start = ring[0];
	if (start) ring.push(start);
	return ring;
}
