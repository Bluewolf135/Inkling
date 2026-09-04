import { eraseAt } from './eraser';
import {
	boundingBox,
	distance,
	hitTestAnnotation,
	normalizeRect,
	polygonEnclosesAnnotation,
	scaleAnnotation,
	translateAnnotation,
	unionBoundingBox,
} from './geometry';
import { createId } from './id';
import { attachPointerGestures, GestureHandlers } from './pointer';
import { handleRects, renderBase, renderOverlay } from './render';
import { AnnotationStore } from './store';
import { HistoryStack } from './history';
import {
	Annotation,
	DEFAULT_COLOR,
	DEFAULT_WIDTH,
	DrawToolType,
	MAX_WIDTH,
	MIN_WIDTH,
	Point,
	Rect,
	ShapeAnnotation,
	ShapeToolType,
	StrokeAnnotation,
	ToolType,
} from './types';

// The eraser reuses the shared width control as its size/radius (per the
// plan: "adjustable size/radius, same as pen/highlighter width control"),
// scaled up — a radius equal to the line width would be too fussy to aim
// with a fingertip or an imprecise pen tap.
const ERASER_RADIUS_FACTOR = 3;
const MIN_ERASER_RADIUS = 10;
const DRAFT_ID = '__draft__';

type HandleName = 'nw' | 'ne' | 'sw' | 'se';

type DragMode =
	| { kind: 'draw'; tool: DrawToolType; points: Point[] }
	| { kind: 'shape'; tool: ShapeToolType; start: Point; end: Point }
	| { kind: 'erase'; before: Annotation[] }
	| { kind: 'lasso'; points: Point[] }
	| { kind: 'move'; before: Annotation[]; ids: string[]; origin: Point }
	| { kind: 'resize'; before: Annotation[]; ids: string[]; box: Rect; handle: HandleName };

interface PageMount {
	// Two stacked canvases rather than one: `base` holds committed
	// annotations and is only repainted when the store's content for this
	// page actually changes; `overlay` holds the in-progress draft/lasso/
	// selection/eraser-cursor and is repainted on every pointer move. See
	// render.ts's renderBase/renderOverlay for why this split matters.
	base: CanvasRenderingContext2D;
	overlay: CanvasRenderingContext2D;
	detach: () => void;
}

export interface AnnotationControllerOptions {
	onAddPage?: () => void;
	getCurrentPage?: () => number | null;
	// Fires once per committed gesture (draw, erase, move, resize, recolor,
	// clear, lasso-delete) and once per undo/redo — the signal src/pdfView.ts
	// uses to know a page's on-disk annotations are now stale and schedule a
	// debounced write.
	onAnnotationsChanged?: (pageNumber: number) => void;
	// Fires once a pinch-zoom gesture on a page ends, with its current zoom
	// scale — src/pdfView.ts uses this to decide whether that page's PDF
	// render is now too low-resolution to look sharp at this zoom level and,
	// if so, re-render it (see its upgradeResolution).
	onZoomSettled?: (pageNumber: number, scale: number) => void;
	// Called right before a highlighter stroke commits (pointerup, or a
	// cancelled-but-kept gesture) — src/pdfView.ts uses this to replace the
	// raw freehand path with one or more straight, text-line-height segments
	// snapped to whatever PDF text the stroke actually swept over, so a
	// highlighter drag over real text comes out straight instead of
	// following the pen's natural wobble. Returning null (no text under the
	// stroke, or the host view doesn't support this — e.g. Markdown ink
	// blocks later) falls back to committing the raw stroke as drawn.
	onSnapHighlighterStroke?: (pageNumber: number, points: Point[], color: string) => Annotation[] | null;
}

// The shared annotation tool module — owns tool/color/width state, an
// undo/redo history, and a per-page annotation store, and wires Pointer
// Events (with palm rejection) to an overlay canvas per mounted page. Built
// once, deliberately free of any PDF- or Markdown-specific concepts, so the
// Markdown ink blocks (a later step) can mount pages into this exact same
// controller instead of duplicating the tool logic.
export class AnnotationController {
	private readonly history = new HistoryStack();
	private readonly store: AnnotationStore;
	private readonly pages = new Map<number, PageMount>();
	private readonly listeners = new Set<() => void>();

	private tool: ToolType = 'select';
	private color: string = DEFAULT_COLOR;
	private width: number = DEFAULT_WIDTH;
	// Color/width are remembered per tool (pen, highlighter, eraser, each
	// shape) rather than as one global pair — otherwise picking a color/size
	// for the highlighter and then switching to the pen would carry the
	// highlighter's values over, which reads as the pen "forgetting" its own
	// last-used settings. 'select' has no style of its own; it just reflects
	// whatever the most recently used styled tool left behind.
	private readonly toolStyles = new Map<ToolType, { color: string; width: number }>();

	private selection: { pageNumber: number; ids: Set<string> } = { pageNumber: -1, ids: new Set() };
	private drag: { pageNumber: number; mode: DragMode } | null = null;
	private canManagePages = false;
	private eraserCursor: { pageNumber: number; point: Point } | null = null;
	// Each page remembers its own pinch-zoom level independently (see
	// pointer.ts) — the toolbar's zoom readout shows whichever page the view
	// currently considers "current" (getCurrentPage), which in practice is
	// whichever page the user is actually looking at/touching.
	private readonly zoomByPage = new Map<number, number>();

	constructor(private readonly options: AnnotationControllerOptions = {}) {
		this.store = new AnnotationStore(
			this.history,
			(pageNumber) => this.redrawBase(pageNumber),
			(pageNumber) => this.options.onAnnotationsChanged?.(pageNumber),
		);
	}

	// ---- Page lifecycle ----

	mountPage(pageNumber: number, host: HTMLElement, width: number, height: number): void {
		this.unmountPage(pageNumber);

		const baseCanvas = host.createEl('canvas', { cls: 'inkling-annotation-layer inkling-annotation-base' });
		baseCanvas.width = width;
		baseCanvas.height = height;

		// The overlay sits on top and is the only one that receives pointer
		// events — the base layer is purely a picture underneath it.
		const overlayCanvas = host.createEl('canvas', { cls: 'inkling-annotation-layer inkling-annotation-overlay' });
		overlayCanvas.width = width;
		overlayCanvas.height = height;

		const base = baseCanvas.getContext('2d');
		const overlay = overlayCanvas.getContext('2d');
		if (!base || !overlay) throw new Error('Inkling: could not acquire a 2D context for the annotation layer.');

		const detach = attachPointerGestures(overlayCanvas, () => this.getHandlersFor(pageNumber));
		this.pages.set(pageNumber, { base, overlay, detach });
		this.redrawBase(pageNumber);
		this.redrawOverlay(pageNumber);
	}

	// Seeds a page with previously-saved annotations (read back from the
	// PDF) — bypasses history/onAnnotationsChanged since this is already
	// persisted state, not a new edit.
	seedPage(pageNumber: number, annotations: Annotation[]): void {
		this.store.seedPage(pageNumber, annotations);
	}

	getPageAnnotations(pageNumber: number): Annotation[] {
		return this.store.getPage(pageNumber);
	}

	// Re-backs a page's annotation canvases at a new resolution and swaps in
	// `annotations` already reprojected to match (src/pdfView.ts does that
	// reprojection, via pdf.js's viewport, before calling this — it's the
	// only side that knows about pdf.js viewports at all). Used when a
	// pinch-zoomed page gets re-rendered sharper (see
	// AnnotationControllerOptions.onZoomSettled): setting canvas.width/height
	// clears a canvas's contents as a side effect, and the existing
	// annotations' coordinates would no longer line up with the new
	// resolution's pixel grid regardless, so both need to change together.
	// Goes through the store's live-update path (not commitGesture) since
	// this is purely a resolution/coordinate-space migration — the on-disk
	// PDF-space representation is unchanged, so it must not register as an
	// edit (no history entry, no autosave).
	resizePage(pageNumber: number, width: number, height: number, annotations: Annotation[]): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		mount.base.canvas.width = width;
		mount.base.canvas.height = height;
		mount.overlay.canvas.width = width;
		mount.overlay.canvas.height = height;
		this.store.setPageLive(pageNumber, annotations);
		this.redrawOverlay(pageNumber);
	}

	getCanManagePages(): boolean {
		return this.canManagePages;
	}

	setCanManagePages(value: boolean): void {
		this.canManagePages = value;
		this.notify();
	}

	// How many pages the surface being annotated has, purely so the toolbar
	// can show a "12 / 195" readout. Not derived from `this.pages` — that map
	// only holds pages currently *mounted*, which for a long PDF is the
	// handful near the viewport (see src/pdfView.ts's page recycling), not
	// the document's length. Defaults to a single page, which is what a
	// Markdown ink block is and always stays.
	private pageCount = 1;

	getPageCount(): number {
		return this.pageCount;
	}

	setPageCount(count: number): void {
		if (count === this.pageCount) return;
		this.pageCount = count;
		this.notify();
	}

	// The page the reader is currently on, as the host view understands it.
	getCurrentPageNumber(): number {
		return this.options.getCurrentPage?.() ?? 1;
	}

	// Repaints the toolbar from state this controller doesn't own and can't
	// observe — the current page number, which changes as the host view is
	// scrolled rather than through any call made here. src/pdfView.ts calls
	// this when its own tracking moves to a different page.
	refreshUi(): void {
		this.notify();
	}

	unmountPage(pageNumber: number): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		mount.detach();
		mount.base.canvas.remove();
		mount.overlay.canvas.remove();
		this.pages.delete(pageNumber);
	}

	unmountAll(): void {
		for (const pageNumber of [...this.pages.keys()]) this.unmountPage(pageNumber);
		this.selection = { pageNumber: -1, ids: new Set() };
		this.drag = null;
		this.eraserCursor = null;
		this.zoomByPage.clear();
		this.history.clear();
	}

	// ---- Tool / style state ----

	getTool(): ToolType {
		return this.tool;
	}

	setTool(tool: ToolType): void {
		this.tool = tool;
		this.drag = null;
		if (tool !== 'select') this.selection = { pageNumber: -1, ids: new Set() };
		if (tool !== 'eraser') this.eraserCursor = null;
		if (tool !== 'select') {
			const style = this.styleFor(tool);
			this.color = style.color;
			this.width = style.width;
		}
		this.notify();
		this.redrawAllOverlay();
	}

	getColor(): string {
		return this.color;
	}

	setColor(color: string): void {
		this.color = color;
		if (this.tool !== 'select') this.toolStyles.set(this.tool, { ...this.styleFor(this.tool), color });
		if (this.selection.ids.size > 0) this.restyleSelection({ color });
		this.notify();
	}

	getWidth(): number {
		return this.width;
	}

	setWidth(width: number): void {
		this.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
		if (this.tool !== 'select') this.toolStyles.set(this.tool, { ...this.styleFor(this.tool), width: this.width });
		if (this.selection.ids.size > 0) this.restyleSelection({ width: this.width });
		// Keep the eraser outline's displayed radius in sync while the user
		// drags the width slider with it already showing.
		if (this.eraserCursor) this.redrawOverlay(this.eraserCursor.pageNumber);
		this.notify();
	}

	private styleFor(tool: ToolType): { color: string; width: number } {
		return this.toolStyles.get(tool) ?? { color: DEFAULT_COLOR, width: DEFAULT_WIDTH };
	}

	hasSelection(): boolean {
		return this.selection.ids.size > 0;
	}

	// Whether a draw/shape/erase/lasso/move/resize gesture is currently
	// mid-flight on any page — src/pdfView.ts checks this before letting an
	// autosave run, so a save landing exactly when the user has a pen down
	// can't compete with live drawing for the main thread (or, worse,
	// serialize a stroke that isn't finished yet).
	isGestureActive(): boolean {
		return this.drag !== null;
	}

	// The current page's pinch-zoom level (1 = no zoom) — for the toolbar's
	// zoom readout.
	getZoom(): number {
		const pageNumber = this.options.getCurrentPage?.();
		if (pageNumber == null) return 1;
		return this.getPageZoom(pageNumber);
	}

	// One specific page's zoom level, regardless of which page is current —
	// src/pdfView.ts uses this to leave zoomed pages mounted when it recycles
	// scrolled-away ones, since this state is keyed to a mount that recycling
	// would throw away.
	getPageZoom(pageNumber: number): number {
		return this.zoomByPage.get(pageNumber) ?? 1;
	}

	// ---- History ----

	get canUndo(): boolean {
		return this.history.canUndo;
	}

	get canRedo(): boolean {
		return this.history.canRedo;
	}

	undo(): void {
		const pageNumber = this.history.undo();
		this.notify();
		if (pageNumber !== undefined) this.options.onAnnotationsChanged?.(pageNumber);
	}

	redo(): void {
		const pageNumber = this.history.redo();
		this.notify();
		if (pageNumber !== undefined) this.options.onAnnotationsChanged?.(pageNumber);
	}

	// ---- Page-level actions ----

	addPage(): void {
		this.options.onAddPage?.();
	}

	clearCurrentPage(): void {
		const pageNumber = this.options.getCurrentPage?.();
		if (pageNumber == null) return;
		this.store.clearPage(pageNumber);
		if (this.selection.pageNumber === pageNumber) this.selection = { pageNumber: -1, ids: new Set() };
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	deleteSelection(): void {
		if (this.selection.ids.size === 0) return;
		const { pageNumber, ids } = this.selection;
		const before = this.store.getPage(pageNumber);
		this.store.setPageLive(
			pageNumber,
			before.filter((a) => !ids.has(a.id)),
		);
		this.store.commitGesture(pageNumber, before);
		this.selection = { pageNumber: -1, ids: new Set() };
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// ---- Subscriptions (toolbar reactivity) ----

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	// ---- Gesture handling ----

	private getHandlersFor(pageNumber: number): GestureHandlers {
		return {
			onStart: (point) => this.handleStart(pageNumber, point),
			onMove: (point) => this.handleMove(pageNumber, point),
			onEnd: (point) => this.handleEnd(pageNumber, point),
			onCancel: () => this.handleCancel(pageNumber),
			onHover: (point) => this.handleHover(pageNumber, point),
			onZoomChange: (scale) => {
				this.zoomByPage.set(pageNumber, scale);
				this.notify();
			},
			onZoomEnd: (scale) => this.options.onZoomSettled?.(pageNumber, scale),
		};
	}

	private handleHover(pageNumber: number, point: Point | null): void {
		const wasShowing = this.eraserCursor?.pageNumber === pageNumber;
		if (this.tool !== 'eraser' || !point) {
			this.eraserCursor = null;
			if (wasShowing) this.redrawOverlay(pageNumber);
			return;
		}
		this.eraserCursor = { pageNumber, point };
		this.redrawOverlay(pageNumber);
	}

	private handleStart(pageNumber: number, point: Point): void {
		switch (this.tool) {
			case 'pen':
			case 'highlighter':
				this.drag = { pageNumber, mode: { kind: 'draw', tool: this.tool, points: [point] } };
				break;
			case 'line':
			case 'rectangle':
			case 'oval':
			case 'arrow':
				this.drag = { pageNumber, mode: { kind: 'shape', tool: this.tool, start: point, end: point } };
				break;
			case 'eraser':
				this.drag = { pageNumber, mode: { kind: 'erase', before: this.store.getPage(pageNumber) } };
				this.applyErase(pageNumber, point);
				break;
			case 'select':
				this.handleSelectStart(pageNumber, point);
				break;
		}
		this.redrawOverlay(pageNumber);
	}

	private handleSelectStart(pageNumber: number, point: Point): void {
		const annotations = this.store.getPage(pageNumber);

		if (this.selection.pageNumber === pageNumber && this.selection.ids.size > 0) {
			const boxes = annotations.filter((a) => this.selection.ids.has(a.id)).map(boundingBox);
			if (boxes.length > 0) {
				const box = unionBoundingBox(boxes);
				const handles = handleRects(box);
				for (const name of Object.keys(handles) as HandleName[]) {
					const rect = handles[name];
					if (point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY) {
						this.drag = {
							pageNumber,
							mode: { kind: 'resize', before: annotations, ids: [...this.selection.ids], box, handle: name },
						};
						return;
					}
				}
			}
		}

		const hit = [...annotations].reverse().find((a) => hitTestAnnotation(a, point));
		if (hit) {
			if (!this.selection.ids.has(hit.id)) {
				this.selection = { pageNumber, ids: new Set([hit.id]) };
				this.notify();
			}
			this.drag = {
				pageNumber,
				mode: { kind: 'move', before: annotations, ids: [...this.selection.ids], origin: point },
			};
			return;
		}

		this.selection = { pageNumber, ids: new Set() };
		this.drag = { pageNumber, mode: { kind: 'lasso', points: [point] } };
		this.notify();
	}

	private handleMove(pageNumber: number, point: Point): void {
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw':
				mode.points.push(point);
				this.redrawOverlay(pageNumber);
				break;
			case 'shape':
				mode.end = point;
				this.redrawOverlay(pageNumber);
				break;
			case 'erase':
				this.applyErase(pageNumber, point);
				break;
			case 'lasso':
				mode.points.push(point);
				this.redrawOverlay(pageNumber);
				break;
			case 'move': {
				const dx = point.x - mode.origin.x;
				const dy = point.y - mode.origin.y;
				const next = mode.before.map((a) => (mode.ids.includes(a.id) ? translateAnnotation(a, dx, dy) : a));
				this.store.setPageLive(pageNumber, next);
				break;
			}
			case 'resize': {
				const to = resizeRect(mode.box, mode.handle, point);
				const next = mode.before.map((a) => (mode.ids.includes(a.id) ? scaleAnnotation(a, mode.box, to) : a));
				this.store.setPageLive(pageNumber, next);
				break;
			}
		}
	}

	private handleEnd(pageNumber: number, point: Point): void {
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw': {
				mode.points.push(point);
				if (mode.points.length >= 2) this.commitDrawStroke(pageNumber, mode);
				break;
			}
			case 'shape': {
				mode.end = point;
				if (distance(mode.start, mode.end) > 2) this.commitNew(pageNumber, this.shapeFromDraft(mode));
				break;
			}
			case 'erase':
				this.store.commitGesture(pageNumber, mode.before);
				break;
			case 'lasso': {
				const polygon = [...mode.points, point];
				const hits = this.store.getPage(pageNumber).filter((a) => polygonEnclosesAnnotation(a, polygon));
				this.selection = { pageNumber, ids: new Set(hits.map((a) => a.id)) };
				break;
			}
			case 'move':
			case 'resize':
				this.store.commitGesture(pageNumber, mode.before);
				break;
		}

		this.drag = null;
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// A pointercancel — the browser deciding mid-gesture to hand the pointer
	// off to a native action (scrolling being the main real-world case; see
	// src/annotate/pointer.ts) — ends a gesture the same way a pointerup
	// would for draw/shape: keep whatever was drawn so far rather than
	// throwing it away, since from the user's perspective they were still
	// mid-stroke, not cancelling on purpose. Erase/move/resize still revert
	// on cancel, since a mutation of *existing* annotations being cut short
	// is safer to undo than to risk half-applying.
	private handleCancel(pageNumber: number): void {
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw':
				if (mode.points.length >= 2) this.commitDrawStroke(pageNumber, mode);
				break;
			case 'shape':
				if (distance(mode.start, mode.end) > 2) this.commitNew(pageNumber, this.shapeFromDraft(mode));
				break;
			case 'erase':
			case 'move':
			case 'resize':
				this.store.setPageLive(pageNumber, mode.before);
				break;
		}

		this.drag = null;
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// Accepts either one annotation or a batch — a snapped highlighter stroke
	// (see commitDrawStroke) can become several straight segments, one per
	// text line it swept over, and all of them need to land as a single undo
	// step rather than one each.
	private commitNew(pageNumber: number, annotation: Annotation | Annotation[]): void {
		const additions = Array.isArray(annotation) ? annotation : [annotation];
		if (additions.length === 0) return;
		const before = this.store.getPage(pageNumber);
		this.store.setPageLive(pageNumber, [...before, ...additions]);
		this.store.commitGesture(pageNumber, before);
	}

	// A finished (or cancelled-but-kept) 'draw' gesture — for the highlighter
	// specifically, gives the host view a chance to replace the raw freehand
	// path with straight, text-snapped segments before committing (see
	// AnnotationControllerOptions.onSnapHighlighterStroke). Anything it
	// declines to snap (not a highlighter, no text under the stroke, or no
	// host support) commits as drawn, same as every other tool.
	private commitDrawStroke(pageNumber: number, mode: { tool: DrawToolType; points: Point[] }): void {
		if (mode.tool === 'highlighter') {
			const snapped = this.options.onSnapHighlighterStroke?.(pageNumber, mode.points, this.color);
			if (snapped && snapped.length > 0) {
				this.commitNew(pageNumber, snapped);
				return;
			}
		}
		this.commitNew(pageNumber, this.strokeFromDraft(mode));
	}

	private strokeFromDraft(mode: { tool: DrawToolType; points: Point[] }): StrokeAnnotation {
		return { id: createId(), kind: 'stroke', tool: mode.tool, color: this.color, width: this.width, points: mode.points };
	}

	private shapeFromDraft(mode: { tool: ShapeToolType; start: Point; end: Point }): ShapeAnnotation {
		return {
			id: createId(),
			kind: 'shape',
			tool: mode.tool,
			color: this.color,
			width: this.width,
			start: mode.start,
			end: mode.end,
		};
	}

	private applyErase(pageNumber: number, point: Point): void {
		this.store.setPageLive(pageNumber, eraseAt(this.store.getPage(pageNumber), point, this.eraserRadius()));
	}

	private eraserRadius(): number {
		return Math.max(this.width * ERASER_RADIUS_FACTOR, MIN_ERASER_RADIUS);
	}

	private restyleSelection(patch: Partial<Pick<Annotation, 'color' | 'width'>>): void {
		const { pageNumber, ids } = this.selection;
		const before = this.store.getPage(pageNumber);
		this.store.setPageLive(
			pageNumber,
			before.map((a) => (ids.has(a.id) ? { ...a, ...patch } : a)),
		);
		this.store.commitGesture(pageNumber, before);
		this.redrawOverlay(pageNumber);
	}

	// ---- Rendering ----

	private redrawAllOverlay(): void {
		for (const pageNumber of this.pages.keys()) this.redrawOverlay(pageNumber);
	}

	private redrawBase(pageNumber: number): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		renderBase(mount.base, this.store.getPage(pageNumber));
	}

	private redrawOverlay(pageNumber: number): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;

		const dragMode = this.drag?.pageNumber === pageNumber ? this.drag.mode : null;
		const lassoPath = dragMode?.kind === 'lasso' ? dragMode.points : null;
		const draft = this.draftFor(dragMode);
		const eraserCursor =
			this.eraserCursor?.pageNumber === pageNumber ? { point: this.eraserCursor.point, radius: this.eraserRadius() } : null;
		const selected =
			this.selection.pageNumber === pageNumber && this.selection.ids.size > 0
				? this.store.getPage(pageNumber).filter((a) => this.selection.ids.has(a.id))
				: undefined;

		renderOverlay(mount.overlay, { selected, draft, lassoPath, eraserCursor });
	}

	private draftFor(mode: DragMode | null): Annotation | null {
		if (!mode) return null;
		if (mode.kind === 'draw') return { id: DRAFT_ID, kind: 'stroke', tool: mode.tool, color: this.color, width: this.width, points: mode.points };
		if (mode.kind === 'shape') {
			return {
				id: DRAFT_ID,
				kind: 'shape',
				tool: mode.tool,
				color: this.color,
				width: this.width,
				start: mode.start,
				end: mode.end,
			};
		}
		return null;
	}
}

function resizeRect(box: Rect, handle: HandleName, point: Point): Rect {
	switch (handle) {
		case 'nw':
			return normalizeRect(point, { x: box.maxX, y: box.maxY });
		case 'ne':
			return normalizeRect(point, { x: box.minX, y: box.maxY });
		case 'sw':
			return normalizeRect(point, { x: box.maxX, y: box.minY });
		case 'se':
			return normalizeRect(point, { x: box.minX, y: box.minY });
	}
}
