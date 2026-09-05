import { FileView, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { AnnotationMode, getDocument, RenderingCancelledException, type PageViewport, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { AnnotationController, buildToolbar, MAX_ZOOM, PRESET_COLORS, ToolState, type Annotation, type Point, type ToolType } from './annotate';
import { createId } from './annotate/id';
import { AnnotationWriterClient } from './pdf/annotationWriterClient';
import { toArrayBuffer } from './binary';
import { writeBinarySafely } from './vaultWrite';
import { compareProfiles, formatMediaBox, normalizeRotation, samplePageIndices, type StructureProfile } from './pdf/compatibility';
import { findMatches, flattenOutline, type OutlineEntry } from './pdf/navigation';
import { BASELINE_DESCENT_RATIO, groupIntoLines, quoteBetween, type PositionedBox, type TextLine } from './pdf/textLines';
import { maxWriteIntervalMs } from './pdf/saveCadence';
import { applyTemplateStyle, PAGE_SIZE, parseTemplateStyleFromKeywords, readTemplateStyle } from './templates';

// pdfjs-dist is pinned to an exact version (see package.json) — 5.4.624+
// calls Uint8Array.prototype.toHex() unconditionally when computing a PDF's
// fingerprint, an API too new for Obsidian's bundled Chromium. Check that a
// newer pin still guards it (grep pdf.worker.mjs for "toHex") before bumping.

export const VIEW_TYPE_PDF = 'inkling-pdf-view';

// Obsidian's own built-in PDF view type id — used to switch a leaf back to
// native reading (page number/zoom/outline, and no pdf-lib/editing cost)
// when the user is done annotating. See main.ts for the reverse direction:
// it stays the default for opening a .pdf at all now, and only swaps a leaf
// into VIEW_TYPE_PDF when the user explicitly asks to annotate.
export const CORE_PDF_VIEW_TYPE = 'pdf';

const PAGE_NUMBER_ATTR = 'pageNumber';
const RENDER_SCALE = 1.5;

// How many pages either side of the visible ones keep their canvases once
// scrolled past; anything beyond is torn back down to its placeholder and
// re-rendered if the user returns. Rendering was lazy already, but nothing
// was ever released — read a 195-page book start to finish and all 195
// pages ended up holding three canvases each (a PDF page plus two
// annotation layers), which on a tablet is exactly the sort of steadily
// climbing memory use that ends in the renderer being killed. Annotations
// aren't affected: they live in the controller's store, keyed by page, and
// are redrawn from it whenever a page mounts again.
const PAGE_RETAIN_MARGIN = 3;

// How long to wait after the last edit before writing annotations into the
// file — pdf-lib's rewrites aren't incremental, so batching rapid
// successive strokes into one save matters more here than for most
// autosave features (see the plan's Write granularity note).
const WRITE_DEBOUNCE_MS = 1500;

// One press of a zoom key. Matches the step the toolbar buttons use, so
// the two agree about what "zoom in once" means.
const KEYBOARD_ZOOM_STEP = 1.25;

// Single-letter tool shortcuts. Every drawing app has them, and they cost
// nothing here because this view contains no text to type into.
const TOOL_KEYS: Record<string, ToolType | undefined> = {
	s: 'select',
	p: 'pen',
	h: 'highlighter',
	e: 'eraser',
	l: 'line',
	r: 'rectangle',
	o: 'oval',
	a: 'arrow',
};

// pdf.js runs its own parsing off the main thread via a worker it manages
// internally (see main.ts's configurePdfWorker) — a separate worker from
// AnnotationWriterClient's, but the same failure mode applies: if it's
// killed or wedged (mobile memory pressure parsing a large book, the same
// theorized cause as the annotation-writer worker's own crash handling),
// pdf.js's own promise can simply never settle, with no error and no
// timeout of its own. Left unguarded, that hung `await` is indistinguishable
// from "goes black and doesn't pop up" — nothing after it ever runs, so no
// page ever gets far enough to render.
const PDF_LOAD_TIMEOUT_MS = 45000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = window.setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timeout);
				// Rewrapped rather than passed straight through: pdf.js can
				// reject with values that aren't Errors, and callers here log
				// whatever comes out.
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

// Stroke width is a length, so it belongs to a coordinate space just as
// much as the points do — canvas pixels here, PDF points on disk, differing
// by the viewport's scale. Converting the points but copying the width
// through unchanged wrote every stroke into the file at RENDER_SCALE times
// its intended thickness (1.5x), which is why ink drawn here came back
// visibly fatter in Obsidian's own PDF view — the file really did say 3
// points where 2 was meant. Scaling it in both directions keeps what's
// drawn, what's saved, and what other PDF software renders identical, and
// keeps thickness stable across a zoom re-render too (which round-trips
// annotations through PDF space at a different scale — see
// upgradeResolution).
function toCanvasSpace(annotation: Annotation, viewport: PageViewport): Annotation {
	const width = annotation.width * viewport.scale;
	if (annotation.kind === 'stroke') {
		return { ...annotation, width, points: annotation.points.map((p) => convert(viewport, p, 'toViewport')) };
	}
	return {
		...annotation,
		width,
		start: convert(viewport, annotation.start, 'toViewport'),
		end: convert(viewport, annotation.end, 'toViewport'),
	};
}

function toPdfSpace(annotation: Annotation, viewport: PageViewport): Annotation {
	const width = annotation.width / viewport.scale;
	if (annotation.kind === 'stroke') {
		return { ...annotation, width, points: annotation.points.map((p) => convert(viewport, p, 'toPdf')) };
	}
	return {
		...annotation,
		width,
		start: convert(viewport, annotation.start, 'toPdf'),
		end: convert(viewport, annotation.end, 'toPdf'),
	};
}

// pdf.js's viewport transform is already rotation-aware (it's the exact
// matrix used to render the page), so routing both directions through it
// here — rather than hand-deriving a flip/scale — keeps our canvas<->PDF
// coordinate mapping correct for rotated pages too, not just the common
// upright case.
function convert(viewport: PageViewport, point: Point, direction: 'toViewport' | 'toPdf'): Point {
	const result: unknown[] =
		direction === 'toViewport' ? viewport.convertToViewportPoint(point.x, point.y) : viewport.convertToPdfPoint(point.x, point.y);
	const [x, y] = result as [number, number];
	return { x, y };
}

// One line of real PDF text, in canvas space — used to snap a freehand
// highlighter stroke to straight segments (see snapHighlighterStroke)
// instead of committing it as drawn, and to report the words that stroke
// covered (see src/pdf/textLines.ts, which owns the grouping and clipping).

// pdf.js's text items carry their own transform in the page's raw PDF
// space (unscaled, unrotated — the same space annotation coordinates round
// -trip through via convert() above), not the rendered canvas's pixel
// space, so each one needs converting through the page's viewport just
// like a stroke or shape does. Grouped into lines by proximity of vertical
// center — a single visual line of text is usually split into several
// items (one per run of consistent font/style), not one item per line.
async function computeTextLines(page: PDFPageProxy, viewport: PageViewport): Promise<TextLine[]> {
	const content = await page.getTextContent();

	const boxes: PositionedBox[] = [];
	for (const item of content.items) {
		if (!('str' in item) || !item.str.trim()) continue;
		// pdf.js types `transform` loosely; it is always the six-element
		// matrix [a, b, c, d, e, f], whose last two entries are the item's
		// origin. Typed as a fixed-length tuple so those two read as the
		// numbers they are rather than as possibly-missing array entries.
		const [, , , , e, f] = item.transform as [number, number, number, number, number, number];
		// `f` is the text's *baseline*, not the bottom of its glyphs, so the
		// box runs from a descender's depth below it to the rest of the line
		// height above — see BASELINE_DESCENT_RATIO.
		const bottom = f - item.height * BASELINE_DESCENT_RATIO;
		const top = f + item.height * (1 - BASELINE_DESCENT_RATIO);
		const corners = [
			convert(viewport, { x: e, y: bottom }, 'toViewport'),
			convert(viewport, { x: e + item.width, y: bottom }, 'toViewport'),
			convert(viewport, { x: e, y: top }, 'toViewport'),
			convert(viewport, { x: e + item.width, y: top }, 'toViewport'),
		];
		const xs = corners.map((c) => c.x);
		const ys = corners.map((c) => c.y);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);
		// The string is kept, where it used to be read only to skip blanks and
		// then thrown away. Carrying it through is the whole of "extract
		// highlights to notes": the geometry that decides which lines a
		// stroke swept already knows which words those are.
		boxes.push({
			text: item.str,
			minX: Math.min(...xs),
			maxX: Math.max(...xs),
			centerY: (minY + maxY) / 2,
			height: Math.max(maxY - minY, 1),
		});
	}

	return groupIntoLines(boxes);
}

// pdf.js's half of the structure profile (see src/pdf/compatibility.ts).
// `page.view` is the raw MediaBox array, unrotated — the same space
// pdf-lib's getMediaBox reports in. A viewport would fold rotation into the
// dimensions and disagree with pdf-lib on every rotated page, which is
// exactly the false positive this check must not produce.
async function profileFromPdfJs(pdf: PDFDocumentProxy): Promise<StructureProfile> {
	const sampledPages: StructureProfile['sampledPages'] = [];
	for (const index of samplePageIndices(pdf.numPages)) {
		const page = await pdf.getPage(index + 1);
		const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
		sampledPages.push({
			index,
			page: { mediaBox: formatMediaBox(x1, y1, x2 - x1, y2 - y1), rotation: normalizeRotation(page.rotate) },
		});
	}
	return { pageCount: pdf.numPages, sampledPages };
}

// Sizes a page placeholder by width plus an aspect ratio, rather than by
// explicit width and height. `.inkling-pdf-page-placeholder` caps width at
// 100% of the view, and with a hard pixel height that cap squashed pages
// horizontally whenever a page was wider than the pane — measured in the
// running app at 685px wide against an unchanged 999px tall, for a page
// whose real proportions are 755x999. Deriving height from the ratio means
// a narrow pane (a phone, a split pane, a sidebar) scales pages down whole
// instead of distorting them, and still reserves correct space before a
// page has rendered. Annotation coordinates are unaffected either way:
// pointer input is mapped through each canvas's own backing-store scale
// (see src/annotate/pointer.ts), not assumed to be 1:1 with CSS pixels.
function sizePlaceholder(placeholder: HTMLElement, width: number, height: number): void {
	// Handed to the stylesheet as custom properties rather than set as
	// inline styles: the actual rules stay in styles.css (and stay
	// themeable), and only the two data-derived numbers cross over.
	placeholder.setCssProps({ '--inkling-page-width': `${width}px`, '--inkling-page-aspect': `${width} / ${height}` });
}

// Accepts both shapes this view can be handed a position in: `{ page: N }`,
// which main.ts sends when swapping over from the native view, and the
// `{ subpath: '#page=N' }` form Obsidian itself uses for PDF links like
// `[[book.pdf#page=42]]`.
function readPageFromEphemeralState(state: unknown): number | null {
	const source = state as { page?: unknown; subpath?: unknown } | null;

	const page = source?.page;
	if (typeof page === 'number' && Number.isFinite(page) && page >= 1) return page;

	if (typeof source?.subpath === 'string') {
		const matched = /#page=(\d+)/.exec(source.subpath);
		if (matched) return Number(matched[1]);
	}

	return null;
}

export class PdfAnnotateView extends FileView {
	private readonly controller: AnnotationController;
	private renderToken = 0;
	private pdf: PDFDocumentProxy | null = null;
	private observer: IntersectionObserver | null = null;
	private renderedPages = new Set<number>();
	// Pages already seeded from the file's own saved annotations — distinct
	// from renderedPages, which recycling (see releasePage) empties again.
	private readonly seededPages = new Set<number>();
	private visiblePages = new Set<number>();
	// Pages actually within the viewport, as opposed to visiblePages' padded
	// render-ahead set — see onIntersect.
	private readonly onScreenPages = new Set<number>();
	private currentPageNumber = 1;
	private disposeToolbar: (() => void) | null = null;
	private addingPage = false;

	// Per-page pdf.js viewport, kept around for the coordinate conversion
	// above — populated as pages render, cleared on teardown.
	private viewports = new Map<number, PageViewport>();
	// The PDF background canvas for each rendered page, and the pdf.js
	// render scale it's currently backed at — both needed by
	// upgradeResolution to re-render a page sharper once pinch-zoom (see
	// pointer.ts) makes the original RENDER_SCALE render look blurry.
	private pageCanvases = new Map<number, HTMLCanvasElement>();
	private renderedScales = new Map<number, number>();
	// Pages currently mid-upgradeResolution — guards against a second pinch
	// ending before the first page's re-render has finished.
	private readonly upgradingPages = new Set<number>();
	// Real PDF text, in canvas space, per page — populated alongside each
	// page's render (see computeTextLines) and used to snap freehand
	// highlighter strokes straight (see snapHighlighterStroke).
	private textLines = new Map<number, TextLine[]>();
	// Annotations read back from the file at open time, in PDF space,
	// seeded into the controller as each page mounts.
	private savedAnnotations = new Map<number, Annotation[]>();
	// Owns the pdf-lib document, parsed once at open time and kept alive off
	// the main thread for the life of the view, reused across every
	// debounced write instead of re-reading and re-parsing the whole file
	// from disk each time — on a large book, a full pdf-lib re-parse on
	// every autosave was real, repeated work that compounded over a long
	// note-taking session and is what "gets laggier and laggier" traced back
	// to. Running it in a worker (see annotationWriter.worker.ts) rather than
	// just caching it here on the main thread is what keeps pdf-lib's save()
	// — genuinely slow, seconds, for a page thick with strokes — from
	// stalling pointer input while the user is actively writing.
	private writer: AnnotationWriterClient | null = null;
	// Pages whose in-memory annotations have changed since the last save.
	private dirtyPages = new Set<number>();
	private writeDebounceHandle: number | null = null;
	// Armed alongside writeDebounceHandle but, unlike it, never reset by a
	// later edit. Continuous handwriting routinely has less than
	// WRITE_DEBOUNCE_MS between one stroke ending and the next starting,
	// which kept resetting the trailing timer before it ever fired — so
	// nothing reached disk until the user stopped for a real pause, and a
	// force-quit lost the whole session's ink.
	private maxWaitHandle: number | null = null;
	// The ceiling for this file specifically — see pdf/saveCadence.ts. Set
	// on load from the file's size; the default covers the window before a
	// file is open.
	private maxWriteInterval = maxWriteIntervalMs(0);
	// Consecutive save failures on the current file. One is worth retrying:
	// a transient adapter error, a file briefly locked by sync. Two in a row
	// is a property of the document, and retrying forever just means a
	// notice every interval for as long as the book stays open.
	private consecutiveWriteFailures = 0;
	// The outline/find panel and its outline area, held so teardown can
	// drop them and so a find can write into them from a walk that
	// outlives the keystroke that started it.
	private navPanel: HTMLElement | null = null;
	private navOutline: HTMLElement | null = null;
	// Supersedes an in-flight document search. Separate from renderToken:
	// a second search within the same file has to cancel the first, and
	// bumping the render token would cancel the whole page pipeline.
	private findToken = 0;
	// Tracked ourselves rather than trusting FileView's own `this.file` at
	// transition time — see onLoadFile's flush-before-teardown for why.
	private currentFile: TFile | null = null;
	// A page to jump to once this file's placeholders exist, set via
	// setEphemeralState (see main.ts's switchToInkling) — captured here since
	// it can arrive before onLoadFile has finished creating them, in which
	// case scrollToPage would have nothing to find yet.
	private pendingScrollToPage: number | null = null;
	// The "opening…" placeholder, held so it can be taken down again from
	// either of the two places that end the wait (pages ready, or a failure).
	private loadingEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, toolState: ToolState) {
		super(leaf);
		this.controller = new AnnotationController({
			// Shared with every other annotating surface, so the pen you set
			// up in a note is the pen you get in a PDF (see annotate/toolState).
			toolState,
			onAddPage: () => void this.addPage(),
			getCurrentPage: () => this.currentPageNumber,
			onAnnotationsChanged: (pageNumber) => this.markPageDirty(pageNumber),
			onZoomSettled: (pageNumber, scale) => void this.upgradeResolution(pageNumber, scale),
			onSnapHighlighterStroke: (pageNumber, points, color) => this.snapHighlighterStroke(pageNumber, points, color),
			onGoToPage: (pageNumber) => this.scrollToPage(pageNumber),
			onToggleNavigation: () => this.toggleNavigationPanel(),
		});
	}

	getViewType(): string {
		return VIEW_TYPE_PDF;
	}

	// For the palette commands in main.ts. The controller is private, and
	// should stay that way — a command reaching through the view into it
	// would be a second, undocumented way to drive the same state.
	undoAnnotation(): void {
		if (this.controller.isReadOnly()) return;
		this.controller.undo();
	}

	redoAnnotation(): void {
		if (this.controller.isReadOnly()) return;
		this.controller.redo();
	}

	async onOpen(): Promise<void> {
		// One-time per leaf, unlike onLoadFile (which reruns per file) — the
		// leaf's title-bar action row, not the toolbar built per-file below.
		this.addAction('book-open', 'Stop annotating (view only)', () => void this.exitEditMode());
		// On the document, not on contentEl: a keydown only reaches an
		// element that contains the focus, and nothing inside this view
		// takes focus — a canvas is not focusable and there is nothing to
		// type into. So listen globally and check that this view is the one
		// the user is actually looking at.
		this.registerDomEvent(document, 'keydown', (event) => this.handleKey(event));
	}

	// Bare letters are safe here in a way they would not be in a note: this
	// view holds no text to type into. The one place that will (the note
	// popover) is excluded below.
	private handleKey(event: KeyboardEvent): void {
		if (this.app.workspace.getActiveViewOfType(PdfAnnotateView) !== this) return;
		const target = event.target;
		if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea'))) return;

		const modified = event.ctrlKey || event.metaKey;
		const handled = modified ? this.handleModifiedKey(event) : this.handlePlainKey(event);
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	private handleModifiedKey(event: KeyboardEvent): boolean {
		switch (event.key.toLowerCase()) {
			case 'z':
				// Read-only means there is nothing of ours to undo: the file was
				// never written to this session.
				if (this.controller.isReadOnly()) return false;
				if (event.shiftKey) this.controller.redo();
				else this.controller.undo();
				return true;
			case 'y':
				if (this.controller.isReadOnly()) return false;
				this.controller.redo();
				return true;
			case '=':
			case '+':
				this.controller.zoomBy(KEYBOARD_ZOOM_STEP);
				return true;
			case '-':
				this.controller.zoomBy(1 / KEYBOARD_ZOOM_STEP);
				return true;
			case '0':
				this.controller.resetZoom();
				return true;
			default:
				return false;
		}
	}

	private handlePlainKey(event: KeyboardEvent): boolean {
		// Navigation works whatever state the document is in. Reading a book
		// Inkling refuses to write to is still reading a book.
		if (event.key === 'PageDown') {
			this.scrollToPage(Math.min(this.currentPageNumber + 1, this.controller.getPageCount()));
			return true;
		}
		if (event.key === 'PageUp') {
			this.scrollToPage(Math.max(this.currentPageNumber - 1, 1));
			return true;
		}

		if (this.controller.isReadOnly()) return false;

		const tool = TOOL_KEYS[event.key.toLowerCase()];
		if (tool) {
			this.controller.setTool(tool);
			return true;
		}

		// 1-6 pick the preset swatches, in the order they sit in the strip.
		const swatch = Number(event.key);
		if (Number.isInteger(swatch) && swatch >= 1 && swatch <= PRESET_COLORS.length) {
			const color = PRESET_COLORS[swatch - 1];
			if (color) {
				this.controller.setColor(color.value);
				return true;
			}
		}

		if (event.key === '[') {
			this.controller.setWidth(this.controller.getWidth() - 1);
			return true;
		}
		if (event.key === ']') {
			this.controller.setWidth(this.controller.getWidth() + 1);
			return true;
		}
		if (event.key === 'Delete' || event.key === 'Backspace') {
			if (!this.controller.hasSelection()) return false;
			this.controller.deleteSelection();
			return true;
		}

		return false;
	}

	// Hands this leaf back to Obsidian's native PDF view for the same file —
	// restores page number/zoom/outline and drops the editing machinery
	// (pdf-lib, the annotation controller/toolbar) this view needed. The
	// reverse direction (native -> Inkling) lives in main.ts, on a "pencil"
	// action it adds to core PDF view leaves. Carries the current page back
	// the same way that direction does, via ephemeral state, so leaving edit
	// mode doesn't lose your place either.
	private async exitEditMode(): Promise<void> {
		const file = this.currentFile ?? this.file;
		if (!file) return;
		// `{ subpath: '#page=N' }`, not `{ page: N }` — verified against the
		// running app: the core PDF view honours the subpath form (the same
		// one `[[file.pdf#page=5]]` links use) and ignores a bare page
		// number, so the earlier shape carried nothing over.
		await this.leaf.setViewState(
			{ type: CORE_PDF_VIEW_TYPE, state: { file: file.path } },
			{ subpath: `#page=${this.currentPageNumber}` },
		);
	}

	// Obsidian's ephemeral-state passthrough (see main.ts's switchToInkling)
	// — receives whatever page the native view had been showing. Undocumented
	// shape (the core PDF view isn't part of the public API), so this reads
	// defensively and simply does nothing if it doesn't look like what's
	// expected, rather than risk misinterpreting some other view's state.
	setEphemeralState(state: unknown): void {
		const page = readPageFromEphemeralState(state);
		if (page === null) return;
		this.pendingScrollToPage = page;
		// Works immediately if this file's placeholders already exist (this
		// fired after onLoadFile finished); otherwise onLoadFile itself
		// applies pendingScrollToPage once they do.
		this.scrollToPage(page);
	}

	async onLoadFile(file: TFile): Promise<void> {
		// teardown() below cancels the pending debounced write and clears
		// dirty-page tracking with no save of its own — onUnloadFile covers
		// the normal "switching files" case by flushing first, but nothing
		// guarantees onLoadFile is always preceded by onUnloadFile on this
		// same view instance (e.g. Obsidian re-navigating to a file already
		// open in this leaf). Flushing here too, unconditionally, closes
		// that gap so a still-debouncing edit can never be silently lost —
		// this is what "erase/edit works, then reverts on reopen" traced
		// back to.
		await this.flushAnnotationsIfDirty(this.currentFile);
		this.currentFile = file;

		const token = ++this.renderToken;
		this.teardown();
		this.contentEl.addClass('inkling-pdf-view');
		this.disposeToolbar = buildToolbar(this.contentEl, this.controller);
		this.buildNavigationPanel();

		// Everything below this point is asynchronous — reading the file,
		// parsing it in the writer worker, then opening it in pdf.js — and a
		// large document spends a noticeable stretch in it. Until now that
		// stretch showed an empty content area under a live toolbar, which
		// reads as "the plugin opened the file and it's blank" rather than
		// "still working". Removed the moment there are placeholders to look
		// at instead, and by showLoadError if we never get that far.
		this.showLoading();

		// The annotation-writer worker parses the file (off the main thread —
		// see its own comment for why) to: read back our own previously-saved
		// annotations (for the overlay); stay the doc instance every later
		// write reuses; and build the copy pdf.js should render from, with
		// only *our* annotations stripped out so its default annotation-
		// baking render still shows annotations from other PDF software
		// (Xodo, etc.) without doubling up with our own live overlay.
		this.maxWriteInterval = maxWriteIntervalMs(file.stat.size);
		this.consecutiveWriteFailures = 0;
		const bytes = await this.app.vault.readBinary(file);

		// `this.teardown()` above already terminated the previous file's
		// writer (if any) — this one is this load's own, kept local until we
		// know it's still wanted, since a newer onLoadFile racing this one
		// (rapid file-switching) would otherwise have its own fresh writer
		// clobbered by this call finishing late.
		// `writer` is constructed *inside* this try, not before it — its
		// constructor opens a Worker, which can itself throw synchronously
		// (confirmed via a real device: a cross-origin Worker construction
		// SecurityError, now worked around in resolveWorkerUrl, but a future
		// failure of some other kind should degrade the same way an open()
		// failure already does below, not silently abort the rest of this
		// file's load with the toolbar up and nothing else — see this
		// function's other comments for what that looked like.
		let writer: AnnotationWriterClient | null = null;
		let savedAnnotations: Map<number, Annotation[]>;
		let displayBytes: ArrayBuffer;
		// Left null/empty when open() fails: that means `writer` is null, so
		// nothing will be written to this file at all this session — there is
		// nothing for the gate to protect and no profile to check against.
		let profile: StructureProfile | null = null;
		let risky: string[] = [];
		try {
			writer = new AnnotationWriterClient();
			const opened = await writer.open(bytes);
			savedAnnotations = opened.savedAnnotations;
			displayBytes = opened.displayBytes;
			profile = opened.profile;
			risky = opened.risky;
		} catch (error) {
			console.error('Inkling: could not read existing annotations from this file.', error);
			new Notice("Inkling: could not read this PDF's existing annotations — any already on it won't show up this time.");
			writer?.terminate();
			writer = null;
			savedAnnotations = new Map();
			// `bytes` was already transferred into (and detached by) the
			// worker above regardless of whether it then failed to parse —
			// re-read a fresh copy so pdf.js still has something to render.
			displayBytes = await this.app.vault.readBinary(file);
		}
		if (token !== this.renderToken) {
			writer?.terminate();
			return;
		}
		this.writer = writer;
		this.savedAnnotations = savedAnnotations;

		let pdf: PDFDocumentProxy;
		try {
			pdf = await withTimeout(getDocument({ data: displayBytes }).promise, PDF_LOAD_TIMEOUT_MS, 'Inkling: timed out opening this PDF.');
		} catch (error) {
			console.error('Inkling: failed to open this PDF for rendering.', error);
			new Notice('Inkling: could not open this PDF for annotating — try again, or reopen it in reading view.');
			this.showLoadError();
			return;
		}
		if (token !== this.renderToken) {
			await pdf.destroy();
			return;
		}
		this.pdf = pdf;

		// Whether pdf-lib can be trusted to rewrite this file at all. A
		// disagreement between the two parsers means pdf-lib's model of the
		// document is incomplete, and every save would serialize from that
		// incomplete model. Better to render the book and refuse to draw on
		// it than to quietly damage it.
		let refusal: string | null = risky.length > 0 ? `it contains ${risky.join(' and ')}` : null;
		if (!refusal && profile) {
			try {
				refusal = compareProfiles(profile, await profileFromPdfJs(pdf));
			} catch (error) {
				console.error('Inkling: could not check this PDF for editing safety.', error);
				refusal = 'its structure could not be checked';
			}
		}
		if (token !== this.renderToken) return;

		this.controller.setReadOnly(refusal !== null);
		if (refusal) this.showReadOnlyBanner(refusal);

		let metadata: Awaited<ReturnType<PDFDocumentProxy['getMetadata']>>;
		let firstPage: PDFPageProxy;
		try {
			// Both still depend on the same pdf.js worker that just parsed the
			// document above — a worker that went quiet mid-parse could just as
			// easily go quiet here instead, so these get the same guard.
			metadata = await withTimeout(pdf.getMetadata(), PDF_LOAD_TIMEOUT_MS, 'Inkling: timed out reading this PDF.');
			if (token !== this.renderToken) return;
			// Real textbooks/technical docs are hundreds of pages; rendering all
			// of them eagerly on open is what made switching PDFs slow. Use one
			// page's viewport to size every placeholder up front (most documents
			// share a page size), then only render a page once it actually
			// scrolls into view.
			firstPage = await withTimeout(pdf.getPage(1), PDF_LOAD_TIMEOUT_MS, 'Inkling: timed out reading this PDF.');
		} catch (error) {
			console.error('Inkling: failed to read this PDF for rendering.', error);
			new Notice('Inkling: could not open this PDF for annotating — try again, or reopen it in reading view.');
			this.showLoadError();
			return;
		}
		if (token !== this.renderToken) return;
		const keywords = (metadata.info as { Keywords?: string }).Keywords;
		this.controller.setCanManagePages(parseTemplateStyleFromKeywords(keywords) !== null);
		const estimatedViewport = firstPage.getViewport({ scale: RENDER_SCALE });

		// Stays subscribed to every placeholder for the life of the view
		// (never unobserved) — it doubles as the "which page is the user
		// currently on" signal that "Add page" needs, not just a
		// render-on-scroll trigger.
		const observer = new IntersectionObserver(
			(entries) => this.onIntersect(entries, token),
			// Roughly a page of lead in each direction, so a page has usually
			// finished rendering before it's scrolled into view rather than
			// arriving blank and filling in late — much more noticeable now
			// that a flick keeps gliding (see pointer.ts's momentum). Kept
			// under PAGE_RETAIN_MARGIN so pre-rendered pages aren't
			// immediately recycled again.
			{ root: this.contentEl, rootMargin: '1000px 0px' },
		);
		this.observer = observer;

		this.controller.setPageCount(pdf.numPages);
		this.clearLoading();
		// Not awaited: an outline is a convenience, and resolving every
		// destination on a deeply nested one is a per-entry pdf.js call no
		// reader should wait behind to see page 1.
		void this.loadOutline(pdf, token);

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const placeholder = this.contentEl.createDiv({
				cls: 'inkling-pdf-page-placeholder',
			});
			placeholder.dataset[PAGE_NUMBER_ATTR] = String(pageNumber);
			sizePlaceholder(placeholder, estimatedViewport.width, estimatedViewport.height);
			// A small page number in the corner of the sheet. A sibling of
			// the zoomable `.inkling-page-content` rather than a child, so
			// pinch-zooming a page doesn't blow the number up with it, and
			// pointer-events: none in styles.css so it can never swallow a
			// stroke that starts on top of it.
			placeholder.createDiv({ cls: 'inkling-page-number', text: String(pageNumber) });
			observer.observe(placeholder);
		}

		// Covers setEphemeralState firing *before* this — its own immediate
		// scrollToPage call would have found no placeholders yet at that
		// point, since this is what creates them.
		if (this.pendingScrollToPage != null) {
			this.scrollToPage(this.pendingScrollToPage);
			this.pendingScrollToPage = null;
		}
	}

	async onUnloadFile(): Promise<void> {
		this.renderToken++;
		await this.flushAnnotationsIfDirty(this.currentFile);
		this.currentFile = null;
		this.teardown();
	}

	// The leaf itself going away, as opposed to teardown()'s per-file reset:
	// the controller is built once per leaf, and it holds a subscription to
	// the plugin-wide ToolState, which outlives every view over it. Without
	// this, each PDF leaf ever opened would stay reachable from that state
	// for the rest of the session.
	async onClose(): Promise<void> {
		this.controller.destroy();
	}

	private teardown() {
		this.observer?.disconnect();
		this.observer = null;
		this.renderedPages.clear();
		this.seededPages.clear();
		this.visiblePages.clear();
		this.onScreenPages.clear();
		this.currentPageNumber = 1;
		// Back to a single page, so the toolbar's readout can't briefly show
		// the *previous* file's length while the next one is still loading.
		this.controller.setPageCount(1);
		this.viewports.clear();
		this.pageCanvases.clear();
		this.renderedScales.clear();
		this.upgradingPages.clear();
		this.textLines.clear();
		this.pendingScrollToPage = null;
		// Bumped so an in-flight document search stops walking a file that
		// is no longer open.
		this.findToken++;
		this.navPanel = null;
		this.navOutline = null;
		if (this.writeDebounceHandle !== null) {
			window.clearTimeout(this.writeDebounceHandle);
			this.writeDebounceHandle = null;
		}
		if (this.maxWaitHandle !== null) {
			window.clearTimeout(this.maxWaitHandle);
			this.maxWaitHandle = null;
		}
		this.dirtyPages.clear();
		this.writer?.terminate();
		this.writer = null;
		void this.pdf?.destroy();
		this.pdf = null;
		this.controller.unmountAll();
		this.disposeToolbar?.();
		this.disposeToolbar = null;
		this.contentEl.empty();
		// Already gone with the emptied contentEl — this just stops us
		// holding a detached node until the next load replaces it.
		this.loadingEl = null;
	}

	private onIntersect(entries: IntersectionObserverEntry[], token: number) {
		// The observer's own notion of "visible" is deliberately padded by a
		// page in each direction (see its rootMargin) so pages render before
		// they're scrolled to. That padding makes it the wrong thing to
		// derive the *current* page from — it would name a page still a
		// screen away, sending "Add page" and the page handed back on exit
		// to somewhere the reader isn't. This unpadded check answers that
		// separately, from rects the entries already carry (no extra layout
		// work beyond the container's own rect).
		const containerRect = this.contentEl.getBoundingClientRect();

		for (const entry of entries) {
			const placeholder = entry.target as HTMLElement;
			const pageNumber = Number(placeholder.dataset[PAGE_NUMBER_ATTR]);

			if (entry.isIntersecting) {
				this.visiblePages.add(pageNumber);
				if (!this.renderedPages.has(pageNumber)) {
					this.renderedPages.add(pageNumber);
					void this.renderPage(placeholder, pageNumber, token);
				}
			} else {
				this.visiblePages.delete(pageNumber);
			}

			const rect = entry.boundingClientRect;
			if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
				this.onScreenPages.add(pageNumber);
			} else {
				this.onScreenPages.delete(pageNumber);
			}
		}

		const previousPageNumber = this.currentPageNumber;
		if (this.onScreenPages.size > 0) {
			this.currentPageNumber = Math.min(...this.onScreenPages);
		} else if (this.visiblePages.size > 0) {
			this.currentPageNumber = Math.min(...this.visiblePages);
		}
		// The toolbar's page readout is the only thing watching this, and
		// scrolling isn't something the controller can observe for itself —
		// so tell it, but only on an actual change, since this handler runs
		// on every intersection callback while scrolling.
		if (this.currentPageNumber !== previousPageNumber) this.controller.refreshUi();

		this.releaseDistantPages();
	}

	// Tears scrolled-far-away pages back down to bare placeholders — see
	// PAGE_RETAIN_MARGIN. Their layout footprint is unchanged (the
	// placeholder keeps the explicit size set when it rendered), so this
	// never shifts the scroll position out from under the reader.
	private releaseDistantPages(): void {
		if (this.visiblePages.size === 0) return;

		const lowest = Math.min(...this.visiblePages) - PAGE_RETAIN_MARGIN;
		const highest = Math.max(...this.visiblePages) + PAGE_RETAIN_MARGIN;

		for (const pageNumber of [...this.renderedPages]) {
			if (pageNumber >= lowest && pageNumber <= highest) continue;
			// A pinch-zoomed page's zoom/pan lives on the very element this
			// would remove (and in controller state keyed to that mount), so
			// leave those alone rather than silently resetting someone's zoom
			// on a page they're likely to come back to.
			if (this.controller.getPageZoom(pageNumber) !== 1) continue;
			this.releasePage(pageNumber);
		}
	}

	private releasePage(pageNumber: number): void {
		const placeholder = this.contentEl.querySelector<HTMLElement>(
			`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
		);
		placeholder?.querySelector('.inkling-page-content')?.remove();

		this.controller.unmountPage(pageNumber);
		this.renderedPages.delete(pageNumber);
		this.pageCanvases.delete(pageNumber);

		// `viewports` and `renderedScales` deliberately survive: a still-dirty
		// page needs its viewport to convert annotations back to PDF space at
		// save time (without it flushAnnotations would skip the page and lose
		// the edit), and keeping the scale means re-rendering reuses the exact
		// canvas space the stored annotations are already in. They're small —
		// the canvases were the memory that mattered.
	}

	private async renderPage(placeholder: HTMLElement, pageNumber: number, token: number) {
		const pdf = this.pdf;
		if (!pdf) return;

		const page = await pdf.getPage(pageNumber);
		if (token !== this.renderToken) return;

		// Re-rendering a page that was recycled (see releasePage) reuses the
		// scale it last had, not the default: annotations for that page are
		// still held in the controller's store in *that* render's canvas
		// space, so coming back at a different scale would put every stroke
		// in the wrong place. It also means a page sharpened for zoom comes
		// back sharp.
		const scale = this.renderedScales.get(pageNumber) ?? RENDER_SCALE;
		const viewport = page.getViewport({ scale });

		// Laid out at the base scale regardless of how densely it's actually
		// rendered — same split upgradeResolution relies on, where a sharper
		// re-render raises only the canvas's backing-store resolution and
		// never its CSS size, so nothing reflows.
		const layoutViewport = scale === RENDER_SCALE ? viewport : page.getViewport({ scale: RENDER_SCALE });
		sizePlaceholder(placeholder, layoutViewport.width, layoutViewport.height);

		// A separate transformable layer inside the placeholder's fixed-size
		// (and, per styles.css, clipped) box — pinch-zoom/pan (see pointer.ts)
		// scales and translates this element, not the placeholder itself, so
		// zooming into one page never changes its footprint in the scrolling
		// list of pages or overlaps its neighbors. The pdf page canvas and
		// both annotation layers all live inside it, so they zoom and pan
		// together as one picture.
		const content = placeholder.createDiv({ cls: 'inkling-page-content' });

		const canvas = content.createEl('canvas', { cls: 'inkling-pdf-page' });
		canvas.width = viewport.width;
		canvas.height = viewport.height;

		try {
			// pdf.js bakes /Annots onto this same canvas by default
			// (AnnotationMode.ENABLE) — left on so *foreign* annotations (from
			// other PDF software, e.g. Xodo) are still visible while editing.
			// Our own never reach this render at all: `pdf` above was opened
			// from the annotation-writer worker's displayBytes, which already
			// has only *our* annotations stripped out (see its comment), so
			// they render exclusively — and always currently — through our
			// own live overlay instead.
			await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
		} catch (error) {
			// Expected when the view is torn down (file switched/closed) while
			// a scrolled-past page was still rendering — the in-flight task
			// gets cancelled along with the rest of the document.
			if (!(error instanceof RenderingCancelledException)) {
				console.error(`Inkling: failed to render PDF page ${pageNumber}.`, error);
				return;
			}
		}

		if (token !== this.renderToken) return;
		this.viewports.set(pageNumber, viewport);
		this.pageCanvases.set(pageNumber, canvas);
		this.renderedScales.set(pageNumber, RENDER_SCALE);
		this.controller.mountPage(pageNumber, content, viewport.width, viewport.height);

		// Only ever on a page's first render. A recycled page (see
		// releasePage) coming back would otherwise be re-seeded from the
		// file's original contents, overwriting everything drawn on it this
		// session — mountPage above already redrew it from the store, which
		// is the live truth for a page that's been mounted before.
		if (!this.seededPages.has(pageNumber)) {
			this.seededPages.add(pageNumber);
			const saved = this.savedAnnotations.get(pageNumber);
			if (saved && saved.length > 0) {
				this.controller.seedPage(pageNumber, saved.map((a) => toCanvasSpace(a, viewport)));
			}
		}

		// Not awaited — a highlighter stroke drawn before this resolves just
		// falls back to committing as freehand (see snapHighlighterStroke),
		// rather than holding up the page's actual render/mount on text
		// extraction it may never even need.
		computeTextLines(page, viewport)
			.then((lines) => {
				if (token === this.renderToken) this.textLines.set(pageNumber, lines);
			})
			.catch((error: unknown) => {
				console.error(`Inkling: failed to read text content for PDF page ${pageNumber}.`, error);
			});
	}

	// Fired once a pinch-zoom gesture on a page settles (see
	// AnnotationController's onZoomSettled) — the original render is a
	// fixed-resolution raster, so CSS-transform zoom past it just shows that
	// same raster larger and blurrier past a point. Re-rendering the page at
	// a resolution matching how zoomed-in the user actually is fixes that —
	// the CSS size stays exactly the same (only the canvas's backing-store
	// pixel density increases), so this never causes any layout shift.
	private async upgradeResolution(pageNumber: number, zoomScale: number): Promise<void> {
		if (!this.pdf || this.upgradingPages.has(pageNumber)) return;

		const currentScale = this.renderedScales.get(pageNumber) ?? RENDER_SCALE;
		const targetScale = Math.min(RENDER_SCALE * zoomScale, RENDER_SCALE * MAX_ZOOM);
		// Not worth a re-render for a marginal gain — and never for one that
		// would make things *blurrier* (e.g. the user zoomed back out).
		if (targetScale <= currentScale * 1.15) return;

		const canvas = this.pageCanvases.get(pageNumber);
		const oldViewport = this.viewports.get(pageNumber);
		if (!canvas || !oldViewport) return;

		this.upgradingPages.add(pageNumber);
		const token = this.renderToken;
		try {
			const page = await this.pdf.getPage(pageNumber);
			if (token !== this.renderToken) return;

			const newViewport = page.getViewport({ scale: targetScale });
			canvas.width = newViewport.width;
			canvas.height = newViewport.height;
			await page.render({ canvas, viewport: newViewport, annotationMode: AnnotationMode.ENABLE }).promise;
			if (token !== this.renderToken) return;
			// Recycled out from under this while it rendered (see
			// releasePage): resizePage below would no-op with no mount to
			// resize, but the viewport/scale bookkeeping after it would still
			// be updated — leaving this page's stored annotations in the old
			// canvas space while its recorded viewport claimed the new one,
			// which would misplace every stroke on save.
			if (!this.renderedPages.has(pageNumber)) return;

			// Existing strokes are in the *old* render's canvas-space — round
			// them through PDF space (invariant regardless of render scale)
			// into the new one, via the same two helpers used for saving.
			const reprojected = this.controller
				.getPageAnnotations(pageNumber)
				.map((a) => toCanvasSpace(toPdfSpace(a, oldViewport), newViewport));
			this.controller.resizePage(pageNumber, newViewport.width, newViewport.height, reprojected);

			this.viewports.set(pageNumber, newViewport);
			this.renderedScales.set(pageNumber, targetScale);
		} catch (error) {
			if (!(error instanceof RenderingCancelledException)) {
				console.error(`Inkling: failed to sharpen PDF page ${pageNumber} for zoom.`, error);
			}
		} finally {
			this.upgradingPages.delete(pageNumber);
		}
	}

	// See AnnotationControllerOptions.onSnapHighlighterStroke — replaces a
	// freehand highlighter path with one straight segment per real text line
	// it swept over (clipped to however much of that line's width the
	// stroke actually covered), so dragging over text comes out straight
	// instead of following the pen's natural wobble. Returns null (falling
	// back to the raw freehand stroke) when this page's text hasn't been
	// read yet, or the stroke isn't over any text at all — a highlighter
	// used freehand in a margin or over a diagram works exactly as before.
	private snapHighlighterStroke(pageNumber: number, points: Point[], color: string): Annotation[] | null {
		const lines = this.textLines.get(pageNumber);
		if (!lines || lines.length === 0 || points.length === 0) return null;

		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
		const strokeMinX = Math.min(...xs);
		const strokeMaxX = Math.max(...xs);
		const strokeMinY = Math.min(...ys);
		const strokeMaxY = Math.max(...ys);

		const hits = lines.filter((line) => {
			const halfHeight = line.height / 2;
			return (
				line.centerY + halfHeight >= strokeMinY &&
				line.centerY - halfHeight <= strokeMaxY &&
				line.maxX >= strokeMinX &&
				line.minX <= strokeMaxX
			);
		});
		if (hits.length === 0) return null;

		return hits.map((line): Annotation => {
			const from = Math.max(line.minX, strokeMinX);
			const to = Math.min(line.maxX, strokeMaxX);
			// The words this segment covers, taken from the very geometry
			// that decided which lines the stroke swept. No new interaction,
			// no text layer, no second pass — the highlighter gesture is
			// exactly what it was, and it now knows what it highlighted.
			const quote = quoteBetween(line, from, to);
			return {
				id: createId(),
				kind: 'stroke',
				tool: 'highlighter',
				color,
				width: line.height,
				points: [
					{ x: from, y: line.centerY },
					{ x: to, y: line.centerY },
				],
				// Omitted rather than stored empty: an absent quote means
				// "recompute me", and an empty one would mean "this covers no
				// words", which is a different and wrong claim.
				...(quote ? { quote } : {}),
			};
		});
	}

	private markPageDirty(pageNumber: number): void {
		this.dirtyPages.add(pageNumber);

		if (this.writeDebounceHandle !== null) window.clearTimeout(this.writeDebounceHandle);
		this.writeDebounceHandle = window.setTimeout(() => this.flushCurrentFileIfAny(), WRITE_DEBOUNCE_MS);

		// Deliberately NOT reset here the way writeDebounceHandle above is.
		// Only armed when nothing's already pending, so it fires a fixed time
		// after the *first* unsaved edit in a batch, regardless of how many
		// more edits reset the trailing debounce in the meantime.
		if (this.maxWaitHandle === null) {
			this.maxWaitHandle = window.setTimeout(() => this.flushCurrentFileIfAny(), this.maxWriteInterval);
		}
	}

	private flushCurrentFileIfAny(): void {
		if (!this.currentFile) return;
		// Even off the main thread (see AnnotationWriterClient), a save still
		// takes real wall-clock time — starting one exactly while the user has
		// a pen down would mean the stroke they're mid-way through can't
		// commit until it comes back, which reads as the same kind of "won't
		// let me write" stall this whole worker move was meant to fix. Defer
		// to the next check instead of forcing it mid-gesture; the retry is
		// cheap and short-lived since gestures normally last well under a
		// second.
		if (this.controller.isGestureActive()) {
			window.setTimeout(() => this.flushCurrentFileIfAny(), 250);
			return;
		}
		void this.flushAnnotations(this.currentFile);
	}

	// `file` is passed explicitly rather than read from `this.file` /
	// `this.currentFile` internally — callers mid-transition (onLoadFile in
	// particular) need this flush to target the file that's on its way
	// *out*, which may already differ from whichever of those two the
	// caller has moved on to by the time this runs.
	private async flushAnnotationsIfDirty(file: TFile | null): Promise<void> {
		if (this.writeDebounceHandle !== null) {
			window.clearTimeout(this.writeDebounceHandle);
			this.writeDebounceHandle = null;
		}
		if (this.maxWaitHandle !== null) {
			window.clearTimeout(this.maxWaitHandle);
			this.maxWaitHandle = null;
		}
		if (file && this.dirtyPages.size > 0) await this.flushAnnotations(file);
	}

	private async flushAnnotations(file: TFile): Promise<void> {
		if (this.writeDebounceHandle !== null) {
			window.clearTimeout(this.writeDebounceHandle);
			this.writeDebounceHandle = null;
		}
		if (this.maxWaitHandle !== null) {
			window.clearTimeout(this.maxWaitHandle);
			this.maxWaitHandle = null;
		}
		if (this.dirtyPages.size === 0 || !this.writer) return;

		const pageNumbers = [...this.dirtyPages];
		this.dirtyPages.clear();

		try {
			const pages = pageNumbers.flatMap((pageNumber) => {
				const viewport = this.viewports.get(pageNumber);
				if (!viewport) return [];
				const annotations = this.controller.getPageAnnotations(pageNumber).map((a) => toPdfSpace(a, viewport));
				this.savedAnnotations.set(pageNumber, annotations);
				return [{ pageNumber, annotations }];
			});

			// The actual pdf-lib mutate+save happens off the main thread in
			// annotationWriter.worker.ts — see its comment and this view's
			// `writer` field for why that matters for a densely annotated file.
			const updatedBytes = await this.writer.write(pages);
			await writeBinarySafely(this.app.vault, file, updatedBytes);
			this.consecutiveWriteFailures = 0;
		} catch (error) {
			console.error('Inkling: failed to save annotations.', error);
			new Notice('Inkling: could not save annotations to this file.');
			// Re-marked dirty first, deliberately: the work stays pending, so
			// if the file later saves — this session or the next — nothing has
			// been thrown away.
			for (const pageNumber of pageNumbers) this.dirtyPages.add(pageNumber);

			this.consecutiveWriteFailures += 1;
			if (this.consecutiveWriteFailures >= 2 && !this.controller.isReadOnly()) {
				// A systematic problem — a document pdf-lib cannot round-trip
				// that the open gate did not catch — would otherwise produce
				// a notice every interval for as long as the book is open.
				this.controller.setReadOnly(true);
				this.showReadOnlyBanner('saving to it keeps failing');
				new Notice("Inkling: this PDF isn't saving, so editing has been turned off. Your ink from this session is still on screen.");
			}
		}
	}

	private async addPage(): Promise<void> {
		const file = this.currentFile;
		if (!file || this.addingPage) return;
		this.addingPage = true;

		try {
			// Add Page does its own read-modify-write of the file below —
			// make sure any not-yet-saved ink is flushed first, or it would
			// be silently dropped when this insert reloads the view from a
			// version of the file that never had it.
			await this.flushAnnotationsIfDirty(file);

			const bytes = await this.app.vault.readBinary(file);
			const pdfDoc = await PDFDocument.load(bytes);

			// currentPageNumber is 1-based; as a 0-based insertion index that
			// is exactly "right after the page the user is currently on".
			const insertIndex = Math.min(this.currentPageNumber, pdfDoc.getPageCount());
			const style = readTemplateStyle(pdfDoc);
			const newPage = pdfDoc.insertPage(insertIndex, PAGE_SIZE);
			applyTemplateStyle(newPage, style);

			const updatedBytes = await pdfDoc.save();
			await writeBinarySafely(this.app.vault, file, toArrayBuffer(updatedBytes));

			const newPageNumber = insertIndex + 1;
			await this.onLoadFile(file);
			this.scrollToPage(newPageNumber);
		} catch (error) {
			console.error('Inkling: failed to add a page.', error);
			new Notice('Inkling: could not add a page to this note.');
		} finally {
			this.addingPage = false;
		}
	}

	// ---- Navigation panel (outline + find) ----

	// Built once per file load, alongside the toolbar, and hidden until
	// asked for — so a reader who never opens it sees exactly the layout
	// they saw before this existed.
	private buildNavigationPanel(): void {
		const panel = this.contentEl.createDiv({ cls: 'inkling-nav-panel' });
		panel.hidden = true;
		this.navPanel = panel;

		const findRow = panel.createDiv({ cls: 'inkling-nav-find' });
		const input = findRow.createEl('input', { cls: 'inkling-nav-find-input' });
		input.type = 'search';
		input.placeholder = 'Find in document';
		input.setAttribute('aria-label', 'Find in document');
		const status = panel.createDiv({ cls: 'inkling-nav-status' });
		const results = panel.createDiv({ cls: 'inkling-nav-results' });

		input.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			void this.runFind(input.value, status, results);
		});

		this.navOutline = panel.createDiv({ cls: 'inkling-nav-outline' });
	}

	private toggleNavigationPanel(): void {
		const panel = this.navPanel;
		if (!panel) return;
		panel.hidden = !panel.hidden;
		if (!panel.hidden) panel.querySelector<HTMLInputElement>('.inkling-nav-find-input')?.focus();
	}

	// pdf.js states a destination either as an explicit array or as a name
	// that has to be looked up first, and either can dangle. Anything that
	// fails resolves to null and is dropped from the list rather than shown
	// as an entry that does nothing when clicked.
	private async resolveDestination(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
		try {
			const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
			const ref: unknown = Array.isArray(explicit) ? explicit[0] : null;
			if (ref === null || typeof ref !== 'object') return null;
			return (await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1;
		} catch {
			return null;
		}
	}

	private async loadOutline(pdf: PDFDocumentProxy, token: number): Promise<void> {
		let entries: OutlineEntry[] = [];
		try {
			entries = await flattenOutline(await pdf.getOutline(), (dest) => this.resolveDestination(pdf, dest));
		} catch (error) {
			console.error('Inkling: could not read this PDF outline.', error);
			return;
		}
		if (token !== this.renderToken) return;

		const host = this.navOutline;
		if (!host) return;
		host.empty();
		// A document with no outline hides the section entirely rather than
		// showing an empty list under a heading, which reads as broken.
		if (entries.length === 0) return;

		host.createDiv({ cls: 'inkling-nav-heading', text: 'Outline' });
		for (const entry of entries) {
			const pageNumber = entry.pageNumber;
			if (pageNumber === null) continue;
			const row = host.createEl('button', { cls: 'inkling-nav-entry', text: entry.title });
			row.type = 'button';
			row.setCssProps({ '--inkling-nav-depth': String(entry.depth) });
			row.addEventListener('click', () => this.scrollToPage(pageNumber));
		}
	}

	// Walks pages in order from the one being read, so the first result is
	// usually the nearest one. Incremental and interruptible: on a long
	// scanned book this is genuinely slow and may find nothing at all, and a
	// reader has to be able to keep reading — or change their mind — while
	// it runs.
	private async runFind(query: string, status: HTMLElement, results: HTMLElement): Promise<void> {
		const pdf = this.pdf;
		results.empty();
		const needle = query.trim();
		if (!pdf || !needle) {
			status.setText('');
			return;
		}

		// A second search supersedes the first, and so does switching files.
		const findToken = ++this.findToken;
		const renderToken = this.renderToken;
		let found = 0;

		for (let offset = 0; offset < pdf.numPages; offset++) {
			if (findToken !== this.findToken || renderToken !== this.renderToken) return;
			const pageNumber = ((this.currentPageNumber - 1 + offset) % pdf.numPages) + 1;

			let text = '';
			try {
				const content = await (await pdf.getPage(pageNumber)).getTextContent();
				text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
			} catch {
				// A page whose text will not extract — a scan with no text layer,
				// a damaged stream — is simply not searched.
				continue;
			}
			if (findToken !== this.findToken || renderToken !== this.renderToken) return;

			const matches = findMatches(text, needle);
			if (matches > 0) {
				found += matches;
				const row = results.createEl('button', {
					cls: 'inkling-nav-entry',
					text: `Page ${pageNumber} — ${matches} ${matches === 1 ? 'match' : 'matches'}`,
				});
				row.type = 'button';
				row.addEventListener('click', () => this.scrollToPage(pageNumber));
			}
			status.setText(`Searched ${offset + 1} of ${pdf.numPages} pages, ${found} found`);
		}

		status.setText(found === 0 ? `No matches for "${needle}"` : `${found} matches`);
	}

	// Leaves something visible instead of the blank/black screen a failed
	// load used to produce — the toolbar (already built by the time any of
	// this can fail) stays up, but with an explanation in place of pages
	// that never rendered, rather than nothing at all.
	private showLoadError(): void {
		this.clearLoading();
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message' });
		setIcon(box.createDiv({ cls: 'inkling-pdf-message-icon' }), 'file-warning');
		box.createDiv({
			cls: 'inkling-pdf-message-text',
			text: "Inkling couldn't open this PDF. Try reopening it, or view it in reading mode.",
		});
	}

	// Sits above the pages rather than replacing them: the document is
	// perfectly readable, and its existing annotations still display. Only
	// writing to it is off the table, and this says why.
	private showReadOnlyBanner(reason: string): void {
		// One banner, not one per reason. The open gate and the repeated-
		// failure path can both reach this, and two stacked notices saying
		// different things about the same file would read as a bug.
		if (this.contentEl.querySelector('.inkling-pdf-readonly')) return;
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message inkling-pdf-readonly' });
		setIcon(box.createDiv({ cls: 'inkling-pdf-message-icon' }), 'file-warning');
		box.createDiv({
			cls: 'inkling-pdf-message-text',
			text: `Inkling can't safely annotate this PDF, because ${reason}. You can read it and see annotations already on it, but editing is turned off so the file isn't damaged.`,
		});
	}

	// A spinner and a line of text while the file is being read and parsed —
	// see the call in onLoadFile for why the wait needed something in it.
	private showLoading(): void {
		this.clearLoading();
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message inkling-pdf-loading' });
		box.createDiv({ cls: 'inkling-pdf-spinner' });
		box.createDiv({ cls: 'inkling-pdf-message-text', text: 'Opening for annotation…' });
		this.loadingEl = box;
	}

	private clearLoading(): void {
		this.loadingEl?.remove();
		this.loadingEl = null;
	}

	private scrollToPage(pageNumber: number): void {
		const placeholder = this.contentEl.querySelector<HTMLElement>(
			`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
		);
		placeholder?.scrollIntoView({ block: 'center' });
	}
}
