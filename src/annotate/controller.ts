import { eraseAt } from './eraser';
import {
	boundingBox,
	clampPointToBounds,
	clampRectToBounds,
	clampTranslation,
	distance,
	hitTestAnnotation,
	normalizeRect,
	polygonEnclosesAnnotation,
	scaleAnnotation,
	translateAnnotation,
	unionBoundingBox,
} from './geometry';
import { createId } from './id';
import { attachPointerGestures, currentZoom, GestureHandlers, zoomAbout } from './pointer';
import { recognizeShape } from './recognize';
import { SIMPLIFY_EPSILON, simplifyPoints } from './simplify';
import { handleRects, renderBase, renderOverlay } from './render';
import { AnnotationStore } from './store';
import { HistoryStack } from './history';
import { ToolState } from './toolState';
import {
	Annotation,
	DrawToolType,
	NoteAnnotation,
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

// How long the pen has to dwell at the end of a stroke, before lifting,
// for that stroke to be offered to shape recognition. The gesture every
// other handwriting app uses, and the reason recognition needs no UI of
// its own: it is opt-in per stroke, so ordinary handwriting is never
// rewritten behind the user’s back.
const SHAPE_HOLD_MS = 500;

// How far a sample may sit from the last one and still count as the pen
// having been held still. A stylus resting on glass reports a steady
// jitter of a pixel or two, and treating that as motion would mean the
// hold gesture could never be performed at all.
const HOLD_STILLNESS_PX = 2.5;

type HandleName = 'nw' | 'ne' | 'sw' | 'se';

type DragMode =
	| { kind: 'draw'; tool: DrawToolType; points: Point[]; lastMovedAt: number }
	| { kind: 'shape'; tool: ShapeToolType; start: Point; end: Point }
	| { kind: 'erase'; before: Annotation[] }
	| { kind: 'lasso'; points: Point[] }
	// `box` is the selection's bounds at the moment the drag began, held so
	// every move can be limited against them without recomputing the union
	// of every selected annotation on each pointer sample. Resize carries
	// one for the same reason.
	| { kind: 'move'; before: Annotation[]; ids: string[]; origin: Point; box: Rect }
	| { kind: 'resize'; before: Annotation[]; ids: string[]; box: Rect; handle: HandleName };

interface PageMount {
	// Two stacked canvases rather than one: `base` holds committed
	// annotations and is only repainted when the store's content for this
	// page actually changes; `overlay` holds the in-progress draft/lasso/
	// selection/eraser-cursor and is repainted on every pointer move. See
	// render.ts's renderBase/renderOverlay for why this split matters.
	base: CanvasRenderingContext2D;
	// The overlay's element is always here — it is the surface that receives
	// pointer events, so it has to exist from the moment the page mounts.
	// Its 2D context is not: acquiring one is what makes the browser
	// allocate the backing store, width x height x 4 bytes, and a page
	// somebody only ever scrolls past never needs it. See overlayContext.
	overlayCanvas: HTMLCanvasElement;
	overlay: CanvasRenderingContext2D | null;
	// The zoomable wrapper the canvases live in — the element the zoom
	// transform is applied to. Held so a zoom asked for from the toolbar
	// or the keyboard, which has no pointer to work back from, can reach
	// the same machinery a pinch does.
	content: HTMLElement;
	detach: () => void;
}

export interface AnnotationControllerOptions {
	// The plugin-wide tool/color/width selection. Passed in rather than
	// owned here because a Markdown ink block's controller is destroyed and
	// rebuilt every time the block saves (see markdown/inkBlock.ts), which
	// would otherwise reset the user's pen mid-sentence. Omitted only by
	// callers with no toolbar to keep in sync — each gets its own.
	toolState?: ToolState;
	// An undo history that outlives this controller. Ink blocks pass one
	// because a block is destroyed and rebuilt by its own save, roughly a
	// second after the pen comes up — a history owned by the controller
	// was therefore wiped that often, which made undo useless on the one
	// surface people draw on most. Omitted by callers whose controller
	// outlives the work, which get their own.
	history?: HistoryStack;
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
	// Asks the host surface to scroll to a page. Only the host knows how
	// its pages are laid out — a Markdown ink block has exactly one and
	// omits this, which is what hides the toolbar page controls there.
	onGoToPage?: (pageNumber: number) => void;
	// Asks the host surface to collect text for a note annotation, given
	// where it sits (in this page’s canvas space) and whatever it already
	// says. Resolving null cancels; resolving an empty string deletes.
	//
	// The controller owns no DOM of its own — it is mounted into a PDF
	// view and into Markdown ink blocks alike — so the editor belongs to
	// whoever mounted it. A host that does not supply this has no note
	// tool at all, which is how ink blocks stay out of it.
	onEditNote?: (pageNumber: number, point: Point, existing: string) => Promise<string | null>;
	// Whether a stroke keeps the pressure its samples carried. Read at
	// commit time rather than at capture: turning it off should change
	// how the next stroke is drawn, not require reopening the file.
	isPressureEnabled?: () => boolean;
	// Whether holding the pen still at the end of a stroke snaps it to a
	// clean shape. Off unless the host says otherwise, so a surface that
	// never opted in cannot silently rewrite handwriting.
	isShapeRecognitionEnabled?: () => boolean;
	// Dark-mode page inversion, which belongs to the host: only it has a
	// page canvas to invert. A surface without one omits both and the
	// toolbar hides the control.
	onToggleInversion?: () => void;
	isInverted?: () => boolean;
	// Asks the host to show or hide its navigation panel. Same reasoning:
	// the panel belongs to the PDF view, not to the shared controller.
	onToggleNavigation?: () => void;
}

// The shared annotation tool module — owns tool/color/width state, an
// undo/redo history, and a per-page annotation store, and wires Pointer
// Events (with palm rejection) to an overlay canvas per mounted page. Built
// once, deliberately free of any PDF- or Markdown-specific concepts, so the
// Markdown ink blocks (a later step) can mount pages into this exact same
// controller instead of duplicating the tool logic.
export class AnnotationController {
	private readonly history: HistoryStack;
	// Whether this controller created its own history, and so may clear
	// it. A history handed in from outside outlives this controller on
	// purpose (see markdown/inkBlock.ts) and clearing it on unmount would
	// defeat the entire point of passing it.
	private readonly ownsHistory: boolean;
	private readonly store: AnnotationStore;
	private readonly pages = new Map<number, PageMount>();
	private readonly listeners = new Set<() => void>();

	private readonly toolState: ToolState;
	private readonly unsubscribeToolState: () => void;

	private selection: { pageNumber: number; ids: Set<string> } = { pageNumber: -1, ids: new Set() };
	private drag: { pageNumber: number; mode: DragMode } | null = null;
	private canManagePages = false;
	// Set when the document cannot be safely written to (see
	// src/pdf/compatibility.ts). Every input path checks it, rather than the
	// view simply not attaching gestures, because a book is rendered lazily,
	// page by page, as it is scrolled — a view-level check would not cover
	// the pages mounted later.
	private readOnly = false;
	private eraserCursor: { pageNumber: number; point: Point } | null = null;
	// Each page remembers its own pinch-zoom level independently (see
	// pointer.ts) — the toolbar's zoom readout shows whichever page the view
	// currently considers "current" (getCurrentPage), which in practice is
	// whichever page the user is actually looking at/touching.
	private readonly zoomByPage = new Map<number, number>();
	// Coalesced pointer samples arrive several per animation frame (see
	// annotate/pointer.ts) and each one used to repaint the overlay. The
	// picture can only change once a frame, so the extra repaints were pure
	// cost — more so now that a pressure-varying stroke rebuilds a filled
	// outline from every sample it has.
	private overlayRedrawFrame: number | null = null;
	private overlayRedrawPage: number | null = null;

	constructor(private readonly options: AnnotationControllerOptions = {}) {
		this.toolState = options.toolState ?? new ToolState();
		this.ownsHistory = options.history === undefined;
		this.history = options.history ?? new HistoryStack();
		this.store = new AnnotationStore(
			this.history,
			(pageNumber) => this.redrawBase(pageNumber),
			(pageNumber) => this.options.onAnnotationsChanged?.(pageNumber),
		);
		// Last, because the callback repaints through the store above.
		// Another surface over the same shared selection can change the tool
		// or its style at any time, so reconciling happens here rather than
		// in setTool/setColor/setWidth — a change made through a second ink
		// block's strip has to reach this one's toolbar and overlay too.
		this.unsubscribeToolState = this.toolState.subscribe((change) => {
			if (change === 'tool') {
				this.drag = null;
				const tool = this.toolState.getTool();
				// A selection only survives in the one tool that can act on
				// it, and the eraser outline only while the eraser is held.
				if (tool !== 'select') this.selection = { pageNumber: -1, ids: new Set() };
				if (tool !== 'eraser') this.eraserCursor = null;
			}
			this.notify();
			this.redrawAllOverlay();
		});
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
		if (!base) throw new Error('Inkling: could not acquire a 2D context for the annotation layer.');

		const detach = attachPointerGestures(overlayCanvas, () => this.getHandlersFor(pageNumber));
		this.pages.set(pageNumber, { base, overlayCanvas, overlay: null, content: host, detach });
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
		mount.overlayCanvas.width = width;
		mount.overlayCanvas.height = height;
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
		mount.overlayCanvas.remove();
		this.pages.delete(pageNumber);
	}

	unmountAll(): void {
		this.cancelScheduledOverlayRedraw();
		for (const pageNumber of [...this.pages.keys()]) this.unmountPage(pageNumber);
		this.selection = { pageNumber: -1, ids: new Set() };
		this.drag = null;
		this.eraserCursor = null;
		this.zoomByPage.clear();
		if (this.ownsHistory) this.history.clear();
	}

	// End of life for the controller itself, as distinct from unmounting its
	// pages. The shared ToolState outlives every controller over it, so a
	// controller that stayed subscribed would be kept alive by it — and an
	// ink block, rebuilt on every save, would leak one per stroke burst.
	destroy(): void {
		this.unmountAll();
		this.unsubscribeToolState();
		this.listeners.clear();
	}

	// ---- Tool / style state ----

	// Pure delegation to the shared ToolState. Everything a *mounted
	// surface* has to do about a change — dropping an in-flight drag,
	// clearing a selection the new tool can't act on, repainting — lives in
	// the subscription set up in the constructor instead, so it happens for
	// a change made through any surface rather than only through this one.
	// The exception is restyling a live selection below, which belongs to
	// the surface the user is actually pointing at.

	getTool(): ToolType {
		return this.toolState.getTool();
	}

	setTool(tool: ToolType): void {
		this.toolState.setTool(tool);
	}

	// A starting tool for this surface, honoured only until the user picks
	// one — see ToolState.suggestTool.
	suggestTool(tool: ToolType): void {
		this.toolState.suggestTool(tool);
	}

	getColor(): string {
		return this.toolState.getColor();
	}

	setColor(color: string): void {
		this.toolState.setColor(color);
		if (this.selection.ids.size > 0) this.restyleSelection({ color });
	}

	getWidth(): number {
		return this.toolState.getWidth();
	}

	setWidth(width: number): void {
		this.toolState.setWidth(width);
		// Clamped by the shared state, so read it back rather than restyling
		// a selection with a value it refused.
		if (this.selection.ids.size > 0) this.restyleSelection({ width: this.getWidth() });
	}

	hasSelection(): boolean {
		return this.selection.ids.size > 0;
	}

	isToolbarCollapsed(): boolean {
		return this.toolState.isToolbarCollapsed();
	}

	setToolbarCollapsed(collapsed: boolean): void {
		this.toolState.setToolbarCollapsed(collapsed);
	}

	isReadOnly(): boolean {
		return this.readOnly;
	}

	setReadOnly(readOnly: boolean): void {
		if (readOnly === this.readOnly) return;
		this.readOnly = readOnly;
		if (readOnly) {
			// Nothing selected can be acted on any more, and a half-finished
			// gesture would otherwise commit on pointerup into a file we have
			// just decided not to write to.
			this.drag = null;
			this.selection = { pageNumber: -1, ids: new Set() };
			this.eraserCursor = null;
		}
		this.notify();
		this.redrawAllOverlay();
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

	// Zooms the current page by a factor, about its centre — a toolbar or
	// keyboard zoom has no cursor to aim at, and the middle of the page is
	// what the reader is looking at.
	zoomBy(factor: number): void {
		this.zoomCurrentPage((scale) => scale * factor);
	}

	resetZoom(): void {
		this.zoomCurrentPage(() => 1);
	}

	private zoomCurrentPage(next: (scale: number) => number): void {
		const pageNumber = this.options.getCurrentPage?.();
		if (pageNumber == null) return;
		const mount = this.pages.get(pageNumber);
		const placeholder = mount?.content.parentElement;
		if (!mount || !placeholder) return;

		const rect = placeholder.getBoundingClientRect();
		const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		const scale = zoomAbout(mount.content, placeholder, next(currentZoom(mount.content)), centre);
		this.zoomByPage.set(pageNumber, scale);
		this.notify();
		// Same signal a settled pinch sends, so the page re-renders at a
		// resolution matching the new zoom rather than staying a blown-up
		// copy of the old raster.
		this.options.onZoomSettled?.(pageNumber, scale);
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
		const pageNumber = this.store.applyUndo();
		this.notify();
		if (pageNumber !== undefined) {
			this.redrawOverlay(pageNumber);
			this.options.onAnnotationsChanged?.(pageNumber);
		}
	}

	redo(): void {
		const pageNumber = this.store.applyRedo();
		this.notify();
		if (pageNumber !== undefined) {
			this.redrawOverlay(pageNumber);
			this.options.onAnnotationsChanged?.(pageNumber);
		}
	}

	// ---- Page-level actions ----

	addPage(): void {
		this.options.onAddPage?.();
	}

	canInvert(): boolean {
		return this.options.onToggleInversion !== undefined;
	}

	isInverted(): boolean {
		return this.options.isInverted?.() ?? false;
	}

	toggleInversion(): void {
		this.options.onToggleInversion?.();
	}

	canTakeNotes(): boolean {
		return this.options.onEditNote !== undefined;
	}

	canNavigate(): boolean {
		return this.options.onGoToPage !== undefined;
	}

	goToPage(pageNumber: number): void {
		const clamped = Math.min(Math.max(Math.round(pageNumber), 1), this.pageCount);
		if (!Number.isFinite(clamped)) return;
		this.options.onGoToPage?.(clamped);
	}

	canToggleNavigation(): boolean {
		return this.options.onToggleNavigation !== undefined;
	}

	toggleNavigation(): void {
		this.options.onToggleNavigation?.();
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
		if (this.readOnly) return;
		const wasShowing = this.eraserCursor?.pageNumber === pageNumber;
		if (this.getTool() !== 'eraser' || !point) {
			this.eraserCursor = null;
			if (wasShowing) this.redrawOverlay(pageNumber);
			return;
		}
		this.eraserCursor = { pageNumber, point };
		this.redrawOverlay(pageNumber);
	}

	private handleStart(pageNumber: number, point: Point): void {
		if (this.readOnly) return;
		// Bound once so the switch below narrows it — a getter call in each
		// case would be opaque to the narrowing and force a cast.
		const tool = this.getTool();
		switch (tool) {
			case 'pen':
			case 'highlighter':
				this.drag = {
					pageNumber,
					mode: { kind: 'draw', tool, points: [this.clampToPage(pageNumber, point)], lastMovedAt: performance.now() },
				};
				break;
			case 'line':
			case 'rectangle':
			case 'oval':
			case 'arrow':
				this.drag = {
					pageNumber,
					mode: { kind: 'shape', tool, start: this.clampToPage(pageNumber, point), end: this.clampToPage(pageNumber, point) },
				};
				break;
			case 'eraser':
				this.drag = { pageNumber, mode: { kind: 'erase', before: this.store.getPage(pageNumber) } };
				this.applyErase(pageNumber, point);
				break;
			case 'note':
				// No drag: a note is placed by tapping, and the gesture ends
				// the moment the editor opens.
				void this.editNoteAt(pageNumber, point, null, '');
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
		// Tapping an existing note with the select tool reopens it. Anything
		// else selects and drags as before — a note that could only ever be
		// read would be a note you could not correct.
		if (hit?.kind === 'note') {
			void this.editNoteAt(pageNumber, hit.at, hit, hit.note);
			return;
		}
		if (hit) {
			if (!this.selection.ids.has(hit.id)) {
				this.selection = { pageNumber, ids: new Set([hit.id]) };
				this.notify();
			}
			const moving = [...this.selection.ids];
			this.drag = {
				pageNumber,
				mode: {
					kind: 'move',
					before: annotations,
					ids: moving,
					origin: point,
					box: unionBoundingBox(annotations.filter((a) => moving.includes(a.id)).map(boundingBox)),
				},
			};
			return;
		}

		this.selection = { pageNumber, ids: new Set() };
		this.drag = { pageNumber, mode: { kind: 'lasso', points: [point] } };
		this.notify();
	}

	// Keeps a drawn point inside the page it is being drawn on.
	//
	// Only drawing is clamped. Erasing and lassoing outside the surface are
	// harmless — there is nothing out there to act on — and clamping a move
	// or resize would change what dragging a selection does, which is a
	// separate decision from this one.
	//
	// The surface's own pixel size is the bound, which is the same space the
	// incoming point is already in: annotate/pointer.ts maps client
	// coordinates through the canvas's displayed size to its backing store,
	// so a zoomed or stretched surface is already accounted for by the time
	// a point arrives here.
	// The two clamps a selection needs, against the same bounds drawing uses.
	// Both no-op when the page is not mounted, since there is then nothing to
	// measure against and refusing to move would be worse than not clamping.
	private clampMove(pageNumber: number, box: Rect, dx: number, dy: number): { dx: number; dy: number } {
		const mount = this.pages.get(pageNumber);
		if (!mount) return { dx, dy };
		return clampTranslation(box, dx, dy, mount.base.canvas.width, mount.base.canvas.height);
	}

	private clampRect(pageNumber: number, rect: Rect): Rect {
		const mount = this.pages.get(pageNumber);
		if (!mount) return rect;
		return clampRectToBounds(rect, mount.base.canvas.width, mount.base.canvas.height);
	}

	private clampToPage(pageNumber: number, point: Point): Point {
		const mount = this.pages.get(pageNumber);
		if (!mount) return point;
		return clampPointToBounds(point, mount.base.canvas.width, mount.base.canvas.height);
	}

	private handleMove(pageNumber: number, point: Point): void {
		if (this.readOnly) return;
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw': {
				// Only movement that goes somewhere counts as movement: a pen
				// resting on glass still reports a jittery stream of samples,
				// and treating those as motion would mean the hold gesture
				// could never be performed at all.
				const clamped = this.clampToPage(pageNumber, point);
				const previous = mode.points[mode.points.length - 1];
				if (!previous || Math.hypot(clamped.x - previous.x, clamped.y - previous.y) > HOLD_STILLNESS_PX) {
					mode.lastMovedAt = performance.now();
				}
				mode.points.push(clamped);
				this.scheduleOverlayRedraw(pageNumber);
				break;
			}
			case 'shape':
				mode.end = this.clampToPage(pageNumber, point);
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
				// Limited by where the selection would end up, not by where
				// the pointer is: see clampTranslation. Dragging a selection
				// off the page used to leave it there, invisible only because
				// a canvas discards what falls off it — the same way drawing
				// off the edge did before it was clamped.
				const { dx, dy } = this.clampMove(
					pageNumber,
					mode.box,
					point.x - mode.origin.x,
					point.y - mode.origin.y,
				);
				const next = mode.before.map((a) => (mode.ids.includes(a.id) ? translateAnnotation(a, dx, dy) : a));
				this.store.setPageLive(pageNumber, next);
				break;
			}
			case 'resize': {
				const to = this.clampRect(pageNumber, resizeRect(mode.box, mode.handle, point));
				const next = mode.before.map((a) => (mode.ids.includes(a.id) ? scaleAnnotation(a, mode.box, to) : a));
				this.store.setPageLive(pageNumber, next);
				break;
			}
		}
	}

	private handleEnd(pageNumber: number, point: Point): void {
		if (this.readOnly) return;
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw': {
				mode.points.push(this.clampToPage(pageNumber, point));
				if (mode.points.length >= 2) this.commitDrawStroke(pageNumber, mode);
				break;
			}
			case 'shape': {
				mode.end = this.clampToPage(pageNumber, point);
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
		// Included deliberately: this is the path a palm rejection or a lost
		// pointer takes, and for a draw gesture it *commits* what was drawn
		// rather than discarding it. Leaving it ungated would let a stroke
		// that began before read-only engaged still finish.
		if (this.readOnly) return;
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
	private commitDrawStroke(pageNumber: number, mode: { tool: DrawToolType; points: Point[]; lastMovedAt: number }): void {
		// Held still at the end of a pen stroke: offer it to recognition.
		// Checked before the highlighter branch below only because a
		// highlighter is never snapped — a straight yellow bar is already
		// what the snapping it does have produces.
		if (mode.tool === 'pen' && (this.options.isShapeRecognitionEnabled?.() ?? false)) {
			if (performance.now() - mode.lastMovedAt >= SHAPE_HOLD_MS) {
				const recognized = recognizeShape(mode.points);
				if (recognized) {
					this.commitNew(pageNumber, {
						id: createId(),
						kind: 'shape',
						tool: recognized.tool,
						color: this.getColor(),
						width: this.getWidth(),
						start: recognized.start,
						end: recognized.end,
					});
					return;
				}
			}
		}

		if (mode.tool === 'highlighter') {
			const snapped = this.options.onSnapHighlighterStroke?.(pageNumber, mode.points, this.getColor());
			if (snapped && snapped.length > 0) {
				this.commitNew(pageNumber, snapped);
				return;
			}
		}
		this.commitNew(pageNumber, this.strokeFromDraft(mode));
	}

	// Opens the host’s note editor and applies whatever comes back.
	// `existing` being non-null means this is an edit rather than a new
	// note, and an empty result then deletes it: clearing the text of a
	// note is the only way anyone would expect to remove one.
	private async editNoteAt(
		pageNumber: number,
		point: Point,
		existing: NoteAnnotation | null,
		current: string,
	): Promise<void> {
		if (this.readOnly) return;
		const edit = this.options.onEditNote;
		if (!edit) return;

		const text = (await edit(pageNumber, point, current))?.trim() ?? null;
		// Cancelled. Deliberately distinct from an empty string, which is a
		// decision to delete.
		if (text === null) return;
		if (this.readOnly) return;

		const before = this.store.getPage(pageNumber);
		if (!existing) {
			if (!text) return;
			this.store.setPageLive(pageNumber, [
				...before,
				{
					id: createId(),
					kind: 'note',
					color: this.getColor(),
					width: this.getWidth(),
					at: point,
					note: text,
				},
			]);
		} else if (!text) {
			this.store.setPageLive(
				pageNumber,
				before.filter((annotation) => annotation.id !== existing.id),
			);
		} else {
			this.store.setPageLive(
				pageNumber,
				before.map((annotation) => (annotation.id === existing.id ? { ...existing, note: text } : annotation)),
			);
		}
		this.store.commitGesture(pageNumber, before);
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	private strokeFromDraft(mode: { tool: DrawToolType; points: Point[] }): StrokeAnnotation {
		// Thinned here, at the moment the stroke commits, rather than when it
		// is written to the file. A save lands about a second after the pen
		// lifts and re-renders the block from what it wrote — so simplifying
		// there would visibly change the ink after the fact, which is exactly
		// the bug that made a tapered stroke redraw itself flat (see the
		// pressure note in src/markdown/inkBlockFormat.ts). Doing it on commit
		// means what you see the instant you lift the pen is what is stored.
		//
		// After shape recognition and highlighter snapping above, both of
		// which read the full sample set and are better for it.
		const simplified = simplifyPoints(mode.points, SIMPLIFY_EPSILON);

		// Pressure is stripped rather than never captured, so the setting
		// governs one place — what gets committed — instead of being
		// checked in the pointer layer, the renderer, and the serializer.
		const keepPressure = this.options.isPressureEnabled?.() ?? true;
		const points = keepPressure ? simplified : simplified.map(({ x, y }) => ({ x, y }));
		return { id: createId(), kind: 'stroke', tool: mode.tool, color: this.getColor(), width: this.getWidth(), points };
	}

	private shapeFromDraft(mode: { tool: ShapeToolType; start: Point; end: Point }): ShapeAnnotation {
		return {
			id: createId(),
			kind: 'shape',
			tool: mode.tool,
			color: this.getColor(),
			width: this.getWidth(),
			start: mode.start,
			end: mode.end,
		};
	}

	private applyErase(pageNumber: number, point: Point): void {
		this.store.setPageLive(pageNumber, eraseAt(this.store.getPage(pageNumber), point, this.eraserRadius()));
	}

	private eraserRadius(): number {
		return Math.max(this.getWidth() * ERASER_RADIUS_FACTOR, MIN_ERASER_RADIUS);
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

	private scheduleOverlayRedraw(pageNumber: number): void {
		this.overlayRedrawPage = pageNumber;
		if (this.overlayRedrawFrame !== null) return;
		this.overlayRedrawFrame = window.requestAnimationFrame(() => {
			this.overlayRedrawFrame = null;
			const page = this.overlayRedrawPage;
			this.overlayRedrawPage = null;
			if (page !== null) this.redrawOverlay(page);
		});
	}

	private cancelScheduledOverlayRedraw(): void {
		if (this.overlayRedrawFrame === null) return;
		window.cancelAnimationFrame(this.overlayRedrawFrame);
		this.overlayRedrawFrame = null;
		this.overlayRedrawPage = null;
	}

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

		// Nothing to draw and nothing ever drawn: leave the overlay
		// unallocated. This is the whole point of deferring it — a page being
		// read rather than drawn on reaches here on every mount and would
		// otherwise pay for a full-size canvas to clear it and stop.
		const empty = !draft && !lassoPath && !eraserCursor && (!selected || selected.length === 0);
		if (empty && !mount.overlay) return;

		const overlay = this.overlayContext(mount);
		renderOverlay(overlay, { selected, draft, lassoPath, eraserCursor });
	}

	// The overlay's drawing context, acquired the first time something
	// actually needs to be drawn on it and kept from then on.
	private overlayContext(mount: PageMount): CanvasRenderingContext2D {
		if (mount.overlay) return mount.overlay;

		const overlay = mount.overlayCanvas.getContext('2d');
		if (!overlay) throw new Error('Inkling: could not acquire a 2D context for the annotation layer.');
		mount.overlay = overlay;
		return overlay;
	}

	private draftFor(mode: DragMode | null): Annotation | null {
		if (!mode) return null;
		if (mode.kind === 'draw') return { id: DRAFT_ID, kind: 'stroke', tool: mode.tool, color: this.getColor(), width: this.getWidth(), points: mode.points };
		if (mode.kind === 'shape') {
			return {
				id: DRAFT_ID,
				kind: 'shape',
				tool: mode.tool,
				color: this.getColor(),
				width: this.getWidth(),
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
