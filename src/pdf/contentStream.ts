import { PathSegment } from '../annotate/stroke';
import { Point } from '../annotate/types';

// Standard Bezier approximation constant for a quarter-circle arc.
const CIRCLE_KAPPA = 0.5522847498307936;

function n(value: number): string {
	return value.toFixed(2);
}

// Builds a PDF content-stream path (no paint operator) from a polyline —
// used for both the ink stroke itself and for line/arrow shafts.
export function moveLineOps(points: Point[]): string {
	const [first, ...rest] = points;
	if (!first) return '';
	const parts = [`${n(first.x)} ${n(first.y)} m`];
	for (const p of rest) parts.push(`${n(p.x)} ${n(p.y)} l`);
	return parts.join('\n');
}

// The PDF twin of render.ts's tracePath: the same shared path description
// (see annotate/stroke.ts), emitted as operators instead of canvas calls.
// A quadratic is written as PDF's `v` — a cubic that reuses the current
// point as its first control, which is exactly what a quadratic is —
// because PDF has no quadratic operator of its own.
export function pathOps(segments: PathSegment[]): string {
	const parts: string[] = [];
	for (const segment of segments) {
		if (segment.kind === 'move') parts.push(`${n(segment.to.x)} ${n(segment.to.y)} m`);
		else if (segment.kind === 'line') parts.push(`${n(segment.to.x)} ${n(segment.to.y)} l`);
		else parts.push(`${n(segment.control.x)} ${n(segment.control.y)} ${n(segment.to.x)} ${n(segment.to.y)} v`);
	}
	return parts.join('\n');
}

// A closed ring, for filling — the shape a pressure-varying stroke takes,
// since no PDF stroking operator can change a line's width along its
// length.
export function polygonOps(points: Point[]): string {
	const [first, ...rest] = points;
	if (!first || rest.length < 2) return '';
	const parts = [`${n(first.x)} ${n(first.y)} m`];
	for (const point of rest) parts.push(`${n(point.x)} ${n(point.y)} l`);
	parts.push('h');
	return parts.join('\n');
}

export function rectangleOps(x: number, y: number, width: number, height: number): string {
	return `${n(x)} ${n(y)} ${n(width)} ${n(height)} re`;
}

// A closed ellipse path via four cubic Bezier arcs — PDF has no native
// ellipse/arc operator.
export function ellipseOps(cx: number, cy: number, rx: number, ry: number): string {
	const ox = rx * CIRCLE_KAPPA;
	const oy = ry * CIRCLE_KAPPA;
	return [
		`${n(cx - rx)} ${n(cy)} m`,
		`${n(cx - rx)} ${n(cy + oy)} ${n(cx - ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
		`${n(cx + ox)} ${n(cy + ry)} ${n(cx + rx)} ${n(cy + oy)} ${n(cx + rx)} ${n(cy)} c`,
		`${n(cx + rx)} ${n(cy - oy)} ${n(cx + ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
		`${n(cx - ox)} ${n(cy - ry)} ${n(cx - rx)} ${n(cy - oy)} ${n(cx - rx)} ${n(cy)} c`,
		'h',
	].join('\n');
}

// Two open line segments radiating from the tip — mirrors the arrowhead
// drawn on the canvas overlay (src/annotate/render.ts) so the PDF appearance
// matches what the user actually drew.
export function arrowHeadOps(from: Point, to: Point, size: number): string {
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	const spread = Math.PI / 7;
	const wing1 = { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) };
	const wing2 = { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) };
	return [`${n(to.x)} ${n(to.y)} m`, `${n(wing1.x)} ${n(wing1.y)} l`, `${n(to.x)} ${n(to.y)} m`, `${n(wing2.x)} ${n(wing2.y)} l`].join(
		'\n',
	);
}
