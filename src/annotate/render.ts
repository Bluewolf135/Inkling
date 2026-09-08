import { boundingBox, unionBoundingBox } from './geometry';
import { hasPressure, outlinePath, smoothedPath } from './stroke';
import { Annotation, NOTE_MARKER_SIZE, Point, Rect, StrokeAnnotation } from './types';

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

// Whether this stroke draws as a filled outline rather than a stroked line.
//
// A pen that reported pressure is drawn as a tapered outline, since neither
// a canvas stroke nor a PDF `S` operator can vary a line's width along its
// length. A highlighter never is — a highlighter that tapered would read as
// a mistake, and its text-snapped form is a straight segment at line height
// anyway.
function isTapered(annotation: StrokeAnnotation): boolean {
	return annotation.tool === 'pen' && hasPressure(annotation.points);
}

// Builds a stroke's canvas path from the shared path description (see
// annotate/stroke.ts). Its twin lives in src/pdf/contentStream.ts, emitting
// the same segments as PDF operators — the two must stay in step, which is
// why neither of them computes the segments itself.
function buildStrokePath(annotation: StrokeAnnotation): Path2D {
	const path = new Path2D();

	if (isTapered(annotation)) {
		const [first, ...rest] = outlinePath(annotation.points, annotation.width);
		if (!first || rest.length === 0) return path;
		path.moveTo(first.x, first.y);
		for (const point of rest) path.lineTo(point.x, point.y);
		path.closePath();
		return path;
	}

	for (const segment of smoothedPath(annotation.points)) {
		if (segment.kind === 'move') path.moveTo(segment.to.x, segment.to.y);
		else if (segment.kind === 'line') path.lineTo(segment.to.x, segment.to.y);
		else path.quadraticCurveTo(segment.control.x, segment.control.y, segment.to.x, segment.to.y);
	}
	return path;
}

// Built stroke paths, kept so that redrawing a page does not rebuild them.
//
// This is what stops a block costing its full ink every time it comes back
// on screen. Rebuilding a tapered stroke walks every sample twice — once to
// drop repeats, once to offset it — and allocates a ring of two points per
// sample, all to arrive at the same shape it had a moment ago.
//
// Keyed on the annotation object itself, which is what makes it correct
// with no invalidation logic at all: the store replaces annotations
// wholesale on every edit rather than mutating them in place (see the note
// on `unchanged` in annotate/store.ts), so an edited stroke is a new object
// that simply misses, and the entry for the old one goes when it does.
const strokePaths = new WeakMap<StrokeAnnotation, Path2D>();

// `cache` is false for the overlay's draft stroke: `draftFor` in
// annotate/controller.ts builds a fresh annotation every frame, so caching
// one would allocate an entry per frame and never once hit.
function strokePath(annotation: StrokeAnnotation, cache: boolean): Path2D {
	if (!cache) return buildStrokePath(annotation);

	const existing = strokePaths.get(annotation);
	if (existing) return existing;

	const built = buildStrokePath(annotation);
	strokePaths.set(annotation, built);
	return built;
}

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

// A small page-marker: a rounded tab with one corner folded, in the
// annotation’s colour, centred on its point. Drawn at a fixed size
// rather than scaled by anything, so it stays a tappable target however
// fine the pen currently is.
function drawNoteMarker(ctx: CanvasRenderingContext2D, at: Point, color: string): void {
	const size = NOTE_MARKER_SIZE;
	const half = size / 2;
	const x = at.x - half;
	const y = at.y - half;
	const fold = size * 0.32;
	const radius = size * 0.18;

	ctx.save();
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + size - radius, y);
	ctx.quadraticCurveTo(x + size, y, x + size, y + radius);
	ctx.lineTo(x + size, y + size - fold);
	// The fold: a clipped bottom-right corner, which is what makes this
	// read as a note rather than as a coloured square.
	ctx.lineTo(x + size - fold, y + size);
	ctx.lineTo(x + radius, y + size);
	ctx.quadraticCurveTo(x, y + size, x, y + size - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
	ctx.fill();
	ctx.restore();

	// A pale outline, so a marker placed over dark ink or a dark scan is
	// still separable from it — the same two-pass reasoning as the eraser
	// ring and the selection outline above.
	ctx.save();
	ctx.strokeStyle = CHROME_HALO;
	ctx.lineWidth = 1;
	ctx.strokeRect(x - 0.5, y - 0.5, size + 1, size + 1);
	ctx.restore();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation, cache: boolean): void {
	ctx.save();
	ctx.strokeStyle = annotation.color;
	ctx.lineWidth = annotation.width;
	// Flat ends on a highlighter, round on everything else. A snapped
	// highlight is one straight segment at the text's own height (see
	// pdfView.ts), so a round cap adds a bulge of half that height past the
	// first and last glyph — the pill shape that made highlights read as
	// drawn blobs rather than as marked text. A real highlighter's chisel
	// tip stops square, and so does this.
	ctx.lineCap = isHighlight(annotation) ? 'butt' : 'round';
	ctx.lineJoin = 'round';
	// Note there is no globalAlpha here any more. A highlighter's
	// translucency is a property of the *layer* it lands on, which is
	// composited into the page with mix-blend-mode: multiply (see
	// styles.css). Setting it per-annotation was the old behaviour and had
	// two visible faults: source-over paint at 40% put colour between the
	// reader and the words, so black text under a highlight came out grey;
	// and two overlapping strokes each contributed their own 40%, so a
	// second pass over the same line came out darker than the first. On one
	// layer at one opacity, overlapping strokes simply paint over each
	// other and the page beneath keeps its contrast.

	if (annotation.kind === 'note') {
		drawNoteMarker(ctx, annotation.at, annotation.color);
		ctx.restore();
		return;
	}

	if (annotation.kind === 'stroke') {
		// Anything not tapered draws as the smoothed path, which is what
		// stops fast handwriting coming out visibly faceted.
		const path = strokePath(annotation, cache);
		if (isTapered(annotation)) {
			ctx.fillStyle = annotation.color;
			ctx.fill(path);
		} else {
			ctx.stroke(path);
		}
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

// Whether this annotation belongs on the multiplied highlight layer rather
// than on the ink layer above it. The two are separated because the blend
// mode that makes a highlighter correct makes everything else wrong: dark
// ink multiplied into a dark (or inverted) page disappears, and a note
// marker's white halo multiplies away to nothing.
export function isHighlight(annotation: Annotation): boolean {
	return annotation.kind === 'stroke' && annotation.tool === 'highlighter';
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
	for (const annotation of annotations) {
		if (!isHighlight(annotation)) drawAnnotation(ctx, annotation, true);
	}
}

// The highlight layer — everything drawn with the highlighter, and nothing
// else. Its own canvas so it can be multiplied into the page (styles.css)
// without taking the pen, the shapes and the note markers with it.
//
// Drawn at full strength here rather than at HIGHLIGHTER_OPACITY: the layer
// carries the opacity, so strokes that overlap on it do not compound into a
// darker patch the way per-annotation alpha did.
export function renderHighlights(ctx: CanvasRenderingContext2D, annotations: Annotation[]): void {
	const { canvas } = ctx;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	for (const annotation of annotations) {
		if (isHighlight(annotation)) drawAnnotation(ctx, annotation, true);
	}
}

// The live/interactive layer — the in-progress draft stroke or shape, the
// lasso rect, the selection outline/handles, and the eraser cursor. Redrawn
// on every pointermove, but its cost only ever depends on the *current*
// gesture (one draft stroke, a handful of selected annotations), not on how
// much ink already exists on the page.
export function renderOverlay(ctx: CanvasRenderingContext2D, options: OverlayOptions = {}): void {
	const { canvas } = ctx;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	if (options.draft) drawAnnotation(ctx, options.draft, false);

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
