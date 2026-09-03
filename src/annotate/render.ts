import { boundingBox, unionBoundingBox } from './geometry';
import { Annotation, HIGHLIGHTER_OPACITY, Point, Rect } from './types';

const SELECTION_COLOR = '#1971c2';
const HANDLE_SIZE = 10;

function drawPolyline(ctx: CanvasRenderingContext2D, points: Point[]): void {
	const [first, ...rest] = points;
	if (!first || rest.length === 0) return;
	ctx.beginPath();
	ctx.moveTo(first.x, first.y);
	for (const p of rest) ctx.lineTo(p.x, p.y);
	ctx.stroke();
}

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number): void {
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	const spread = Math.PI / 7;
	ctx.beginPath();
	ctx.moveTo(to.x, to.y);
	ctx.lineTo(to.x - size * Math.cos(angle - spread), to.y - size * Math.sin(angle - spread));
	ctx.moveTo(to.x, to.y);
	ctx.lineTo(to.x - size * Math.cos(angle + spread), to.y - size * Math.sin(angle + spread));
	ctx.stroke();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation): void {
	ctx.save();
	ctx.strokeStyle = annotation.color;
	ctx.lineWidth = annotation.width;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	if (annotation.kind === 'stroke' && annotation.tool === 'highlighter') {
		ctx.globalAlpha = HIGHLIGHTER_OPACITY;
	}

	if (annotation.kind === 'stroke') {
		drawPolyline(ctx, annotation.points);
	} else {
		const { start, end } = annotation;
		switch (annotation.tool) {
			case 'line':
				drawPolyline(ctx, [start, end]);
				break;
			case 'arrow':
				drawPolyline(ctx, [start, end]);
				drawArrowhead(ctx, start, end, Math.max(12, annotation.width * 3));
				break;
			case 'rectangle':
				ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
				break;
			case 'oval': {
				const rx = Math.abs(end.x - start.x) / 2;
				const ry = Math.abs(end.y - start.y) / 2;
				ctx.beginPath();
				ctx.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, rx, ry, 0, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
		}
	}
	ctx.restore();
}

function drawSelectionOutline(ctx: CanvasRenderingContext2D, box: Rect): void {
	ctx.save();
	ctx.strokeStyle = SELECTION_COLOR;
	ctx.lineWidth = 1;
	ctx.setLineDash([4, 3]);
	ctx.strokeRect(box.minX - 6, box.minY - 6, box.maxX - box.minX + 12, box.maxY - box.minY + 12);
	ctx.restore();
}

export function handleRects(box: Rect): Record<'nw' | 'ne' | 'sw' | 'se', Rect> {
	const half = HANDLE_SIZE / 2;
	const corners = {
		nw: { x: box.minX - 6, y: box.minY - 6 },
		ne: { x: box.maxX + 6, y: box.minY - 6 },
		sw: { x: box.minX - 6, y: box.maxY + 6 },
		se: { x: box.maxX + 6, y: box.maxY + 6 },
	};
	const toRect = (p: Point): Rect => ({ minX: p.x - half, minY: p.y - half, maxX: p.x + half, maxY: p.y + half });
	return { nw: toRect(corners.nw), ne: toRect(corners.ne), sw: toRect(corners.sw), se: toRect(corners.se) };
}

function drawHandles(ctx: CanvasRenderingContext2D, box: Rect): void {
	ctx.save();
	ctx.fillStyle = '#ffffff';
	ctx.strokeStyle = SELECTION_COLOR;
	ctx.lineWidth = 1.5;
	for (const rect of Object.values(handleRects(box))) {
		ctx.fillRect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
		ctx.strokeRect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
	}
	ctx.restore();
}

function drawEraserCursor(ctx: CanvasRenderingContext2D, point: Point, radius: number): void {
	ctx.save();
	ctx.beginPath();
	ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
	ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
	ctx.fill();
	ctx.lineWidth = 1.5;
	ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
	ctx.stroke();
	ctx.restore();
}

export interface OverlayOptions {
	selected?: Annotation[];
	draft?: Annotation | null;
	lassoPath?: Point[] | null;
	eraserCursor?: { point: Point; radius: number } | null;
}

// The committed-annotation layer — redrawn only when the store's page
// content actually changes (a stroke/shape commits, an erase/move/resize
// lands, undo/redo, seed/clear), never on every pointermove. Splitting this
// out from the overlay below is what keeps freehand drawing fast as a page
// accumulates more ink: without it, every single pointermove of a new
// stroke had to redraw every *previous* stroke on the page too, so drawing
// got measurably laggier the longer a note-taking session went on.
export function renderBase(ctx: CanvasRenderingContext2D, annotations: Annotation[]): void {
	const { canvas } = ctx;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	for (const annotation of annotations) drawAnnotation(ctx, annotation);
}

// The live/interactive layer — the in-progress draft stroke or shape, the
// lasso rect, the selection outline/handles, and the eraser cursor. Redrawn
// on every pointermove, but its cost only ever depends on the *current*
// gesture (one draft stroke, a handful of selected annotations), not on how
// much ink already exists on the page.
export function renderOverlay(ctx: CanvasRenderingContext2D, options: OverlayOptions = {}): void {
	const { canvas } = ctx;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	if (options.draft) drawAnnotation(ctx, options.draft);

	const selected = options.selected;
	if (selected && selected.length > 0) {
		const box = unionBoundingBox(selected.map(boundingBox));
		drawSelectionOutline(ctx, box);
		drawHandles(ctx, box);
	}

	const [first, ...rest] = options.lassoPath ?? [];
	if (first && rest.length > 0) {
		ctx.save();
		ctx.strokeStyle = SELECTION_COLOR;
		ctx.setLineDash([4, 3]);
		ctx.fillStyle = 'rgba(25, 113, 194, 0.08)';
		ctx.beginPath();
		ctx.moveTo(first.x, first.y);
		for (const p of rest) ctx.lineTo(p.x, p.y);
		// closePath (not just stroke) is what draws the straight line back to
		// the start point too, so the loop reads as a closed selection region
		// while it's still being drawn, not just once released — and it's
		// needed for fill() to treat this as an enclosed area at all.
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	if (options.eraserCursor) drawEraserCursor(ctx, options.eraserCursor.point, options.eraserCursor.radius);
}
