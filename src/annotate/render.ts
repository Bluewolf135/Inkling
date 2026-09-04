import { boundingBox, unionBoundingBox } from './geometry';
import { Annotation, HIGHLIGHTER_OPACITY, Point, Rect } from './types';

const SELECTION_COLOR = '#1971c2';
const HANDLE_SIZE = 10;

// Interactive chrome — the eraser ring, the selection outline, the lasso —
// is drawn in two passes: a pale halo first, then the real line on top of
// it, a little thinner. No single color survives every background this
// chrome has to sit on. A flat dark ring vanished against a dark surface,
// and (even on white paper) against the patch of dense black ink you are
// most likely to be erasing in the first place. Two passes means whichever
// one the background swallows, the other still reads.
const CHROME_HALO = 'rgba(255, 255, 255, 0.9)';
const CHROME_LINE = 'rgba(0, 0, 0, 0.75)';

// Runs `path` twice, once as the halo underneath and once as the line
// itself. The caller lays down the path and picks the top color; widths
// are handled here so every piece of chrome gets the same weight of halo.
//
// `dash` belongs to this function rather than to the caller's `path`, and
// that is the whole point of it being a parameter: the halo must stay
// solid while the line above it is dashed, since the gaps in a dashed line
// are exactly where the contrast is needed. A caller that set the dash
// inside its own path callback would set it for both passes — the halo
// would come out dashed and in phase with the line covering it, doing
// nothing at all.
function withHalo(
	ctx: CanvasRenderingContext2D,
	lineWidth: number,
	color: string,
	path: () => void,
	dash?: number[],
): void {
	ctx.save();
	ctx.lineWidth = lineWidth + 2;
	ctx.strokeStyle = CHROME_HALO;
	ctx.setLineDash([]);
	path();
	ctx.stroke();
	ctx.restore();

	ctx.save();
	ctx.lineWidth = lineWidth;
	ctx.strokeStyle = color;
	if (dash) ctx.setLineDash(dash);
	path();
	ctx.stroke();
	ctx.restore();
}

const CHROME_DASH = [4, 3];

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
	const x = box.minX - 6;
	const y = box.minY - 6;
	const w = box.maxX - box.minX + 12;
	const h = box.maxY - box.minY + 12;
	withHalo(
		ctx,
		1,
		SELECTION_COLOR,
		() => {
			ctx.beginPath();
			ctx.rect(x, y, w, h);
		},
		CHROME_DASH,
	);
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
	// A neutral mid-grey wash rather than the black one this had: at 12% it
	// lightens a dark background and darkens a light one, so the disc itself
	// registers either way instead of only over pale paper.
	ctx.fillStyle = 'rgba(127, 127, 127, 0.12)';
	ctx.fill();
	ctx.restore();

	withHalo(ctx, 1.5, CHROME_LINE, () => {
		ctx.beginPath();
		ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
	});
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
		// closePath (not just stroke) is what draws the straight line back to
		// the start point too, so the loop reads as a closed selection region
		// while it's still being drawn, not just once released — and it's
		// needed for fill() to treat this as an enclosed area at all.
		const path = () => {
			ctx.beginPath();
			ctx.moveTo(first.x, first.y);
			for (const p of rest) ctx.lineTo(p.x, p.y);
			ctx.closePath();
		};

		ctx.save();
		ctx.fillStyle = 'rgba(25, 113, 194, 0.08)';
		path();
		ctx.fill();
		ctx.restore();

		withHalo(ctx, 1, SELECTION_COLOR, path, CHROME_DASH);
	}

	if (options.eraserCursor) drawEraserCursor(ctx, options.eraserCursor.point, options.eraserCursor.radius);
}
