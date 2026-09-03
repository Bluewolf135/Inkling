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
