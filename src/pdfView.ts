import { FileView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { AnnotationMode, getDocument, RenderingCancelledException, type PageViewport, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { AnnotationController, buildToolbar, MAX_ZOOM, type Annotation, type Point } from './annotate';
import { createId } from './annotate/id';
import { AnnotationWriterClient } from './pdf/annotationWriterClient';
import { toArrayBuffer } from './binary';
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

// A ceiling on top of the trailing debounce above: continuous handwriting
// routinely has less than WRITE_DEBOUNCE_MS between one stroke ending and
// the next starting, which kept resetting the trailing timer before it
// ever fired — so nothing was actually saved to disk until the user
// stopped for a real pause, switched back to reading, or closed the file.
// A crash or force-quit mid-session (see the plan's real-device notes)
// would then lose the entire session's ink. This forces a save at least
// this often regardless of how continuously the user keeps writing.
const MAX_WRITE_INTERVAL_MS = 5000;

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
				reject(error);
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
// instead of committing it as drawn.
interface TextLine {
	minX: number;
	maxX: number;
	centerY: number;
	height: number;
}

// How far below a line's baseline its descenders (g, p, y) reach, as a
// fraction of the line height pdf.js reports. A text item's origin is its
// baseline, not the bottom of its glyphs; treating it as the bottom put the
// whole box — and so every snapped highlight — noticeably above the words.
// Measured against the running app rather than assumed: comparing each
// computed line centre to the actual centre of the rendered ink (row-wise
// dark-pixel profile, clustered into text bands) over 83 lines across three
// pages put the error at a consistent 0.17 of line height, always in the
// same direction (median 0.176, 10th-90th percentile 0.08-0.24).
const BASELINE_DESCENT_RATIO = 0.175;

// pdf.js's text items carry their own transform in the page's raw PDF
// space (unscaled, unrotated — the same space annotation coordinates round
// -trip through via convert() above), not the rendered canvas's pixel
// space, so each one needs converting through the page's viewport just
// like a stroke or shape does. Grouped into lines by proximity of vertical
// center — a single visual line of text is usually split into several
// items (one per run of consistent font/style), not one item per line.
async function computeTextLines(page: PDFPageProxy, viewport: PageViewport): Promise<TextLine[]> {
	const content = await page.getTextContent();

	interface Box {
		minX: number;
		maxX: number;
		centerY: number;
		height: number;
	}
	const boxes: Box[] = [];
	for (const item of content.items) {
		if (!('str' in item) || !item.str.trim()) continue;
		const [, , , , e, f] = item.transform;
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
		boxes.push({ minX: Math.min(...xs), maxX: Math.max(...xs), centerY: (minY + maxY) / 2, height: Math.max(maxY - minY, 1) });
	}
	boxes.sort((a, b) => a.centerY - b.centerY);

	const lines: TextLine[] = [];
	let current: Box[] = [];
	const flush = () => {
		if (current.length === 0) return;
		lines.push({
			minX: Math.min(...current.map((b) => b.minX)),
			maxX: Math.max(...current.map((b) => b.maxX)),
			centerY: current.reduce((sum, b) => sum + b.centerY, 0) / current.length,
			height: Math.max(...current.map((b) => b.height)),
		});
		current = [];
	};
	for (const box of boxes) {
		if (current.length > 0) {
			const avgCenterY = current.reduce((sum, b) => sum + b.centerY, 0) / current.length;
			const avgHeight = current.reduce((sum, b) => sum + b.height, 0) / current.length;
			if (Math.abs(box.centerY - avgCenterY) > avgHeight * 0.6) flush();
		}
		current.push(box);
	}
	flush();

	return lines;
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
	placeholder.style.width = `${width}px`;
	placeholder.style.aspectRatio = `${width} / ${height}`;
	placeholder.style.height = '';
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
	// later edit — see MAX_WRITE_INTERVAL_MS for why this ceiling exists.
	private maxWaitHandle: number | null = null;
	// Tracked ourselves rather than trusting FileView's own `this.file` at
	// transition time — see onLoadFile's flush-before-teardown for why.
	private currentFile: TFile | null = null;
	// A page to jump to once this file's placeholders exist, set via
	// setEphemeralState (see main.ts's switchToInkling) — captured here since
	// it can arrive before onLoadFile has finished creating them, in which
	// case scrollToPage would have nothing to find yet.
	private pendingScrollToPage: number | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.controller = new AnnotationController({
			onAddPage: () => void this.addPage(),
			getCurrentPage: () => this.currentPageNumber,
			onAnnotationsChanged: (pageNumber) => this.markPageDirty(pageNumber),
			onZoomSettled: (pageNumber, scale) => void this.upgradeResolution(pageNumber, scale),
			onSnapHighlighterStroke: (pageNumber, points, color) => this.snapHighlighterStroke(pageNumber, points, color),
		});
	}

	getViewType(): string {
		return VIEW_TYPE_PDF;
	}

	async onOpen(): Promise<void> {
		// One-time per leaf, unlike onLoadFile (which reruns per file) — the
		// leaf's title-bar action row, not the toolbar built per-file below.
		this.addAction('book-open', 'Stop annotating (view only)', () => void this.exitEditMode());
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

		// The annotation-writer worker parses the file (off the main thread —
		// see its own comment for why) to: read back our own previously-saved
		// annotations (for the overlay); stay the doc instance every later
		// write reuses; and build the copy pdf.js should render from, with
		// only *our* annotations stripped out so its default annotation-
		// baking render still shows annotations from other PDF software
		// (Xodo, etc.) without doubling up with our own live overlay.
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
		let prunedBytes: ArrayBuffer | undefined;
		try {
			writer = new AnnotationWriterClient();
			const opened = await writer.open(bytes);
			savedAnnotations = opened.savedAnnotations;
			displayBytes = opened.displayBytes;
			prunedBytes = opened.prunedBytes;
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

		// Opening found and pruned Inkling objects orphaned by past sessions
		// (see pruneOrphanedInklingAnnotations) — write the shrunk file back
		// to disk right away rather than waiting for the user's next edit, so
		// a file that's already too large for a sync tool's limit doesn't
		// stay that way just because nothing changed this session.
		if (prunedBytes) {
			this.app.vault.modifyBinary(file, prunedBytes).catch((error: unknown) => {
				console.error('Inkling: could not write back pruned annotation data.', error);
			});
		}

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

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const placeholder = this.contentEl.createDiv({
				cls: 'inkling-pdf-page-placeholder',
			});
			placeholder.dataset[PAGE_NUMBER_ATTR] = String(pageNumber);
			sizePlaceholder(placeholder, estimatedViewport.width, estimatedViewport.height);
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

	private teardown() {
		this.observer?.disconnect();
		this.observer = null;
		this.renderedPages.clear();
		this.seededPages.clear();
		this.visiblePages.clear();
		this.onScreenPages.clear();
		this.currentPageNumber = 1;
		this.viewports.clear();
		this.pageCanvases.clear();
		this.renderedScales.clear();
		this.upgradingPages.clear();
		this.textLines.clear();
		this.pendingScrollToPage = null;
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

		if (this.onScreenPages.size > 0) {
			this.currentPageNumber = Math.min(...this.onScreenPages);
		} else if (this.visiblePages.size > 0) {
			this.currentPageNumber = Math.min(...this.visiblePages);
		}

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

		return hits.map(
			(line): Annotation => ({
				id: createId(),
				kind: 'stroke',
				tool: 'highlighter',
				color,
				width: line.height,
				points: [
					{ x: Math.max(line.minX, strokeMinX), y: line.centerY },
					{ x: Math.min(line.maxX, strokeMaxX), y: line.centerY },
				],
			}),
		);
	}

	private markPageDirty(pageNumber: number): void {
		this.dirtyPages.add(pageNumber);

		if (this.writeDebounceHandle !== null) window.clearTimeout(this.writeDebounceHandle);
		this.writeDebounceHandle = window.setTimeout(() => this.flushCurrentFileIfAny(), WRITE_DEBOUNCE_MS);

		// Deliberately NOT reset here the way writeDebounceHandle above is —
		// see MAX_WRITE_INTERVAL_MS. Only armed when nothing's already
		// pending, so it fires a fixed time after the *first* unsaved edit
		// in a batch, regardless of how many more edits reset the trailing
		// debounce in the meantime.
		if (this.maxWaitHandle === null) {
			this.maxWaitHandle = window.setTimeout(() => this.flushCurrentFileIfAny(), MAX_WRITE_INTERVAL_MS);
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
			await this.app.vault.modifyBinary(file, updatedBytes);
		} catch (error) {
			console.error('Inkling: failed to save annotations.', error);
			new Notice('Inkling: could not save annotations to this file.');
			for (const pageNumber of pageNumbers) this.dirtyPages.add(pageNumber);
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
			await this.app.vault.modifyBinary(file, toArrayBuffer(updatedBytes));

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

	// Leaves something visible instead of the blank/black screen a failed
	// load used to produce — the toolbar (already built by the time any of
	// this can fail) stays up, but with an explanation in place of pages
	// that never rendered, rather than nothing at all.
	private showLoadError(): void {
		this.contentEl.createDiv({
			cls: 'inkling-pdf-load-error',
			text: "Inkling couldn't open this PDF. Try reopening it, or view it in reading mode.",
		});
	}

	private scrollToPage(pageNumber: number): void {
		const placeholder = this.contentEl.querySelector<HTMLElement>(
			`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
		);
		placeholder?.scrollIntoView({ block: 'center' });
	}
}
