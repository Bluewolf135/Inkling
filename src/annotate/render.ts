import { boundingBox, unionBoundingBox } from './geometry';
import { isOutlined, isSharp, SHARP_MITRE_LIMIT, smoothedPath, strokeCentreline, strokeOutline, type PathSegment } from './stroke';
import { Annotation, ImageAnnotation, isLockedPicture, NOTE_MARKER_SIZE, PicturePixels, Point, Rect, StrokeAnnotation } from './types';

const SELECTION_COLOR = '#1971c2';

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


// Whether this stroke draws as a filled outline rather than a stroked line.
//
// A pen that reported pressure, and every nib but the plain pen, is drawn
// as an outline (see annotate/stroke.ts), since neither a canvas stroke nor
// a PDF `S` operator can vary a line's width along its length. A
// highlighter never is — a highlighter that tapered would read as a
// mistake, and its text-snapped form is a straight segment at line height
// anyway.
function isTapered(annotation: StrokeAnnotation): boolean {
	return isOutlined(annotation);
}

function appendSegments(path: Path2D, segments: PathSegment[]): void {
	for (const segment of segments) {
		if (segment.kind === 'move') path.moveTo(segment.to.x, segment.to.y);
		else if (segment.kind === 'line') path.lineTo(segment.to.x, segment.to.y);
		else path.quadraticCurveTo(segment.control.x, segment.control.y, segment.to.x, segment.to.y);
	}
}

// Builds a stroke's canvas path from the shared path description (see
// annotate/stroke.ts). Its twin lives in src/pdf/contentStream.ts, emitting
// the same segments as PDF operators — the two must stay in step, which is
// why neither of them computes the segments itself.
function buildStrokePath(annotation: StrokeAnnotation): Path2D {
	const path = new Path2D();

	if (isTapered(annotation)) {
		appendSegments(path, strokeOutline(annotation));
		path.closePath();
		return path;
	}

	appendSegments(path, strokeCentreline(annotation));
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

// ---- Pictures ----
//
// A picture is decoded once into a bitmap and drawn from that. Decoding is
// asynchronous, and a frame cannot wait for it, so a picture not decoded
// yet draws as a pale placeholder and whoever is listening (the
// controller) repaints when it is ready.

const pictures = new WeakMap<PicturePixels, ImageBitmap | 'decoding' | 'failed'>();
const pictureListeners = new Set<() => void>();

export function onPictureDecoded(listener: () => void): () => void {
	pictureListeners.add(listener);
	return () => pictureListeners.delete(listener);
}

function pictureBitmap(picture: PicturePixels): ImageBitmap | null {
	const known = pictures.get(picture);
	if (known && known !== 'decoding' && known !== 'failed') return known;
	if (known || typeof createImageBitmap !== 'function') return null;
	pictures.set(picture, 'decoding');
	const source =
		picture.format === 'jpeg'
			? new Blob([new Uint8Array(picture.data)], { type: 'image/jpeg' })
			: new ImageData(new Uint8ClampedArray(picture.data), picture.width, picture.height);
	createImageBitmap(source).then(
		(bitmap) => {
			pictures.set(picture, bitmap);
			for (const listener of pictureListeners) listener();
		},
		(error: unknown) => {
			pictures.set(picture, 'failed');
			console.error('Inkling: could not decode a picture.', error);
		},
	);
	return null;
}

function drawPicture(ctx: CanvasRenderingContext2D, annotation: ImageAnnotation): void {
	const box = boundingBox(annotation);
	const width = box.maxX - box.minX;
	const height = box.maxY - box.minY;
	const bitmap = pictureBitmap(annotation.picture);
	ctx.save();
	if (bitmap) {
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, box.minX, box.minY, width, height);
	} else {
		ctx.fillStyle = 'rgba(128, 128, 128, 0.15)';
		ctx.fillRect(box.minX, box.minY, width, height);
	}
	ctx.restore();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation, cache: boolean): void {
	if (annotation.kind === 'image') {
		drawPicture(ctx, annotation);
		return;
	}
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
	// The sharp pen keeps its corners and stops square. Its mitres are kept
	// short: a hairpin turn would otherwise throw a spike far past the line.
	if (annotation.kind === 'stroke' && isSharp(annotation)) {
		ctx.lineCap = 'butt';
		ctx.lineJoin = 'miter';
		ctx.miterLimit = SHARP_MITRE_LIMIT;
	}
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

// ---- Selection ----
//
// Everything below is measured in screen pixels, not canvas pixels, and
// scaled by `chrome` (canvas pixels per screen pixel; see the controller's
// chromeScale). A selection frame and its handles are chrome, the same size
// on every screen; measured in canvas pixels they shrank with every rise in
// pixel density, and on a tablet backed at three canvas pixels to the
// screen pixel a corner handle was three pixels across and could not be hit.

// The light blue a selected drawing is ringed in, and the deeper blue of
// the frame round all of it.
const SELECTION_RING = 'rgba(77, 171, 247, 0.95)';
const SELECTION_FILL = 'rgba(77, 171, 247, 0.08)';

// How far outside a drawing its ring sits, and the ring's own thickness.
const RING_WIDTH = 2;
// The frame stands this far off the selection, so it never sits on ink.
const FRAME_PAD = 8;
const FRAME_DASH = [5, 4];
const HANDLE_RADIUS = 6;
// A handle takes a press this far from its centre: a fingertip or a pen
// held at an angle lands near a target, not on it.
const HANDLE_REACH = 18;

export type HandleName = 'nw' | 'ne' | 'sw' | 'se';

// The frame drawn round a selection, which is also the area a press drags
// the selection by.
export function selectionFrame(box: Rect, chrome: number): Rect {
	const pad = FRAME_PAD * chrome;
	return { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad };
}

export function selectionHandles(box: Rect, chrome: number): Record<HandleName, Point> {
	const frame = selectionFrame(box, chrome);
	return {
		nw: { x: frame.minX, y: frame.minY },
		ne: { x: frame.maxX, y: frame.minY },
		sw: { x: frame.minX, y: frame.maxY },
		se: { x: frame.maxX, y: frame.maxY },
	};
}

// The handle under a press, if any — the nearest within reach.
export function handleAt(box: Rect, chrome: number, point: Point): HandleName | null {
	let found: HandleName | null = null;
	let nearest = HANDLE_REACH * chrome;
	for (const [name, centre] of Object.entries(selectionHandles(box, chrome)) as Array<[HandleName, Point]>) {
		const away = Math.hypot(point.x - centre.x, point.y - centre.y);
		if (away <= nearest) {
			found = name;
			nearest = away;
		}
	}
	return found;
}

// A thin light-blue ring round each selected drawing, following its shape:
// the drawing's own shape drawn a little bigger in blue, then the drawing's
// shape itself cut back out of that, which leaves only the rim. Cut out
// rather than drawn underneath because this layer sits above the ink, and
// blue laid over the ink would tint it.
function drawSelectionRings(ctx: CanvasRenderingContext2D, selected: Annotation[], chrome: number): void {
	const ring = RING_WIDTH * chrome;
	const shapeOf = (annotation: Annotation, grow: number, colour: string) => {
		ctx.strokeStyle = colour;
		ctx.fillStyle = colour;
		if (annotation.kind === 'note') {
			const half = NOTE_MARKER_SIZE / 2 + grow;
			ctx.fillRect(annotation.at.x - half, annotation.at.y - half, half * 2, half * 2);
			return;
		}
		if (annotation.kind === 'image') {
			const box = boundingBox(annotation);
			ctx.fillRect(box.minX - grow, box.minY - grow, box.maxX - box.minX + grow * 2, box.maxY - box.minY + grow * 2);
			return;
		}
		if (annotation.kind === 'stroke') {
			const path = strokePath(annotation, true);
			if (isTapered(annotation)) {
				ctx.lineWidth = grow * 2;
				ctx.lineJoin = 'round';
				if (grow > 0) ctx.stroke(path);
				ctx.fill(path);
			} else {
				ctx.lineWidth = annotation.width + grow * 2;
				const sharp = isSharp(annotation);
				ctx.lineCap = isHighlight(annotation) || sharp ? 'butt' : 'round';
				ctx.lineJoin = sharp ? 'miter' : 'round';
				ctx.miterLimit = SHARP_MITRE_LIMIT;
				ctx.stroke(path);
			}
			return;
		}
		drawAnnotation(ctx, { ...annotation, color: colour, width: annotation.width + grow * 2 }, false);
	};

	ctx.save();
	for (const annotation of selected) shapeOf(annotation, ring, SELECTION_RING);
	ctx.globalCompositeOperation = 'destination-out';
	for (const annotation of selected) shapeOf(annotation, 0, '#000000');
	ctx.restore();
}

// The lock button, on a picture selected on its own: centred above the
// frame, sized in screen pixels like the handles.
const LOCK_RADIUS = 13;
const LOCK_GAP = 10;

export function lockButtonCentre(box: Rect, chrome: number): Point {
	const frame = selectionFrame(box, chrome);
	return { x: (frame.minX + frame.maxX) / 2, y: frame.minY - (LOCK_GAP + LOCK_RADIUS) * chrome };
}

export function lockButtonAt(box: Rect, chrome: number, point: Point): boolean {
	const centre = lockButtonCentre(box, chrome);
	return Math.hypot(point.x - centre.x, point.y - centre.y) <= (LOCK_RADIUS + 6) * chrome;
}

// A padlock in a round button, closed or open.
function drawLockButton(ctx: CanvasRenderingContext2D, box: Rect, chrome: number, locked: boolean): void {
	const { x, y } = lockButtonCentre(box, chrome);
	const unit = chrome;
	ctx.save();
	ctx.beginPath();
	ctx.arc(x, y, LOCK_RADIUS * unit, 0, Math.PI * 2);
	ctx.fillStyle = locked ? SELECTION_COLOR : '#ffffff';
	ctx.fill();
	ctx.lineWidth = 1.5 * unit;
	ctx.strokeStyle = SELECTION_COLOR;
	ctx.stroke();

	const colour = locked ? '#ffffff' : SELECTION_COLOR;
	// The body.
	ctx.fillStyle = colour;
	ctx.fillRect(x - 5.5 * unit, y - 1 * unit, 11 * unit, 8 * unit);
	// The shackle: closed over the body, or swung open to one side.
	ctx.beginPath();
	ctx.lineWidth = 2 * unit;
	ctx.strokeStyle = colour;
	const shackleX = locked ? x : x + 4 * unit;
	ctx.arc(shackleX, y - 1 * unit, 3.5 * unit, Math.PI, 0);
	ctx.moveTo(shackleX - 3.5 * unit, y - 1 * unit);
	ctx.lineTo(shackleX - 3.5 * unit, y + (locked ? 0 : -1) * unit);
	ctx.stroke();
	ctx.restore();
}

function drawSelectionFrame(ctx: CanvasRenderingContext2D, box: Rect, chrome: number, handles = true): void {
	const frame = selectionFrame(box, chrome);
	withHalo(
		ctx,
		chrome,
		SELECTION_COLOR,
		() => {
			ctx.beginPath();
			ctx.rect(frame.minX, frame.minY, frame.maxX - frame.minX, frame.maxY - frame.minY);
		},
		FRAME_DASH.map((length) => length * chrome),
	);

	if (!handles) return;
	ctx.save();
	ctx.fillStyle = '#ffffff';
	ctx.strokeStyle = SELECTION_COLOR;
	ctx.lineWidth = 1.5 * chrome;
	for (const centre of Object.values(selectionHandles(box, chrome))) {
		ctx.beginPath();
		ctx.arc(centre.x, centre.y, HANDLE_RADIUS * chrome, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}
	ctx.restore();
}

// The loop being drawn: dashed, closed back to where it started so it
// reads as the area it will take, and faintly filled. Curved through the
// samples the way a pen stroke is, so it follows the hand as smoothly as
// the pen does rather than as a run of straight dashes.
function drawLasso(ctx: CanvasRenderingContext2D, points: Point[], chrome: number): void {
	if (points.length < 2) return;
	const segments = smoothedPath(points);
	const path = () => {
		ctx.beginPath();
		for (const segment of segments) {
			if (segment.kind === 'move') ctx.moveTo(segment.to.x, segment.to.y);
			else if (segment.kind === 'line') ctx.lineTo(segment.to.x, segment.to.y);
			else ctx.quadraticCurveTo(segment.control.x, segment.control.y, segment.to.x, segment.to.y);
		}
		ctx.closePath();
	};

	ctx.save();
	ctx.fillStyle = SELECTION_FILL;
	path();
	ctx.fill();
	ctx.restore();

	withHalo(ctx, 1.5 * chrome, SELECTION_COLOR, path, [6 * chrome, 4 * chrome]);
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
	// Canvas pixels per screen pixel, which every piece of selection chrome
	// is sized by. 1 where the canvas is shown at its own size.
	chrome?: number;
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
	drawInk(ctx, annotations);
}

// The base layer's ink, drawn under whatever transform `ctx` has and over
// whatever it already holds. Split out of renderBase for the PDF view's
// detail layer, which draws the same ink again magnified onto a canvas of
// its own (see pdfView.ts).
export function drawInk(ctx: CanvasRenderingContext2D, annotations: Annotation[]): void {
	// Pictures first, beneath everything: a photo of a whiteboard is
	// something to write on, not something to cover what was written.
	for (const annotation of annotations) {
		if (annotation.kind === 'image') drawAnnotation(ctx, annotation, true);
	}
	for (const annotation of annotations) {
		if (annotation.kind !== 'image' && !isHighlight(annotation)) drawAnnotation(ctx, annotation, true);
	}
}

// The highlight layer — everything drawn with the highlighter, and nothing
// else. Its own canvas so it can be multiplied into the page (styles.css)
// without taking the pen, the shapes and the note markers with it.
//
// Drawn at full strength here rather than at HIGHLIGHTER_OPACITY: the layer
// carries the opacity, so strokes that overlap on it do not compound into a
// darker patch the way per-annotation alpha did.
// `draft` is the in-progress highlighter stroke, which is drawn on this
// layer rather than on the overlay above it. The overlay carries neither the
// multiply nor the layer opacity, so a draft drawn there was flat opaque
// colour laid over the page: the highlighter covered the very words it was
// highlighting for as long as the pen was down, then dropped behind them at
// pointerup when the committed stroke landed here instead. Drawn here it is
// the same pixels the committed stroke will be — including the way it
// overlaps a highlight already on the line, which on this one layer stays a
// single strength instead of compounding.
//
// It is passed rather than found in `annotations` because a draft is not in
// the store yet, and it is drawn uncached for the reason drawAnnotation's
// `cache` argument exists at all: draftFor builds a fresh annotation object
// every frame.
export function renderHighlights(ctx: CanvasRenderingContext2D, annotations: Annotation[], draft?: Annotation | null): void {
	const { canvas } = ctx;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	for (const annotation of annotations) {
		if (isHighlight(annotation)) drawAnnotation(ctx, annotation, true);
	}
	if (draft && isHighlight(draft)) drawAnnotation(ctx, draft, false);
}

// The live/interactive layer — the in-progress draft stroke or shape, the
// lasso rect, the selection outline/handles, and the eraser cursor. Redrawn
// on every pointermove, but its cost only ever depends on the *current*
// gesture (one draft stroke, a handful of selected annotations), not on how
// much ink already exists on the page.
export function renderOverlay(ctx: CanvasRenderingContext2D, options: OverlayOptions = {}): void {
	const { canvas } = ctx;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	drawOverlay(ctx, options);
}

// The overlay's contents without the clear, for the same reason as drawInk.
export function drawOverlay(ctx: CanvasRenderingContext2D, options: OverlayOptions = {}): void {
	const chrome = options.chrome ?? 1;

	// The rings first: cutting each drawing's shape out of its ring clears
	// whatever is on this layer there, which must not include the frame.
	const selected = options.selected;
	if (selected && selected.length > 0) {
		drawSelectionRings(ctx, selected, chrome);
		const box = unionBoundingBox(selected.map(boundingBox));
		// Nothing to size on a selection that cannot move.
		const locked = selected.some(isLockedPicture);
		drawSelectionFrame(ctx, box, chrome, !locked);
		const [only] = selected;
		if (selected.length === 1 && only?.kind === 'image') drawLockButton(ctx, box, chrome, locked);
	}

	if (options.draft) drawAnnotation(ctx, options.draft, false);
	if (options.lassoPath) drawLasso(ctx, options.lassoPath, chrome);

	if (options.eraserCursor) drawEraserCursor(ctx, options.eraserCursor.point, options.eraserCursor.radius);
}
