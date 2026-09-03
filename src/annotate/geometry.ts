import { Annotation, Point, Rect } from './types';

export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return distance(p, a);

	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
	t = Math.max(0, Math.min(1, t));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function distanceToPolyline(p: Point, points: Point[]): number {
	const [first, ...rest] = points;
	if (!first) return Infinity;
	if (rest.length === 0) return distance(p, first);

	let min = Infinity;
	let previous = first;
	for (const current of rest) {
		min = Math.min(min, distanceToSegment(p, previous, current));
		previous = current;
	}
	return min;
}

export function boundingBox(annotation: Annotation): Rect {
	const points = annotation.kind === 'stroke' ? annotation.points : [annotation.start, annotation.end];
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function unionBoundingBox(boxes: Rect[]): Rect {
	return {
		minX: Math.min(...boxes.map((b) => b.minX)),
		minY: Math.min(...boxes.map((b) => b.minY)),
		maxX: Math.max(...boxes.map((b) => b.maxX)),
		maxY: Math.max(...boxes.map((b) => b.maxY)),
	};
}

// Selection hit-testing is deliberately generous (half the stroke width, at
// least a touch-friendly minimum) — thin strokes are hard to hit precisely
// with a fingertip or an imprecise pen tap.
const MIN_HIT_TOLERANCE = 10;

export function hitTestAnnotation(annotation: Annotation, point: Point): boolean {
	const tolerance = Math.max(MIN_HIT_TOLERANCE, annotation.width / 2 + 4);

	if (annotation.kind === 'stroke') {
		return distanceToPolyline(point, annotation.points) <= tolerance;
	}

	if (annotation.tool === 'line' || annotation.tool === 'arrow') {
		return distanceToSegment(point, annotation.start, annotation.end) <= tolerance;
	}

	// rectangle / oval: anywhere inside a tolerance-inflated bounding box —
	// treated as a fillable region for selection purposes even though only
	// the outline is drawn, since that's the easier target to hit.
	const box = boundingBox(annotation);
	return (
		point.x >= box.minX - tolerance &&
		point.x <= box.maxX + tolerance &&
		point.y >= box.minY - tolerance &&
		point.y <= box.maxY + tolerance
	);
}

// Ray-casting point-in-polygon test (even-odd rule) — used by the freeform
// lasso below. Treats `polygon` as implicitly closed (wraps from the last
// point back to the first) regardless of whether the caller already closed
// it explicitly.
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
	if (polygon.length < 3) return false;
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const pi = polygon[i];
		const pj = polygon[j];
		if (!pi || !pj) continue;
		const crosses = pi.y > point.y !== pj.y > point.y;
		if (crosses && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
	}
	return inside;
}

// The points that define an annotation's extent, for the freeform lasso's
// "fully enclosed" test below — every stroke point, a shape's two
// endpoints, or (rectangle/oval) all four corners of its bounding box,
// since a concave lasso could enclose a shape's start/end diagonal while
// still cutting through one of its other two corners.
function extentPoints(annotation: Annotation): Point[] {
	if (annotation.kind === 'stroke') return annotation.points;
	if (annotation.tool === 'line' || annotation.tool === 'arrow') return [annotation.start, annotation.end];
	const box = boundingBox(annotation);
	return [
		{ x: box.minX, y: box.minY },
		{ x: box.maxX, y: box.minY },
		{ x: box.minX, y: box.maxY },
		{ x: box.maxX, y: box.maxY },
	];
}

// Freeform-lasso selection is full-enclosure, not intersection — an
// annotation is only selected once the drawn loop actually surrounds it,
// not merely touches it.
export function polygonEnclosesAnnotation(annotation: Annotation, polygon: Point[]): boolean {
	return extentPoints(annotation).every((p) => pointInPolygon(p, polygon));
}

export function translateAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
	if (annotation.kind === 'stroke') {
		return { ...annotation, points: annotation.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
	}
	return {
		...annotation,
		start: { x: annotation.start.x + dx, y: annotation.start.y + dy },
		end: { x: annotation.end.x + dx, y: annotation.end.y + dy },
	};
}

// Scales an annotation's geometry from `from` to `to` (a resize-handle
// drag). Degenerate axes (a perfectly flat/vertical selection) keep that
// axis's original coordinates rather than dividing by zero.
export function scaleAnnotation(annotation: Annotation, from: Rect, to: Rect): Annotation {
	const scaleX = from.maxX - from.minX === 0 ? 1 : (to.maxX - to.minX) / (from.maxX - from.minX);
	const scaleY = from.maxY - from.minY === 0 ? 1 : (to.maxY - to.minY) / (from.maxY - from.minY);

	const project = (p: Point): Point => ({
		x: to.minX + (p.x - from.minX) * scaleX,
		y: to.minY + (p.y - from.minY) * scaleY,
	});

	if (annotation.kind === 'stroke') {
		return { ...annotation, points: annotation.points.map(project) };
	}
	return { ...annotation, start: project(annotation.start), end: project(annotation.end) };
}

export function normalizeRect(a: Point, b: Point): Rect {
	return {
		minX: Math.min(a.x, b.x),
		minY: Math.min(a.y, b.y),
		maxX: Math.max(a.x, b.x),
		maxY: Math.max(a.y, b.y),
	};
}
