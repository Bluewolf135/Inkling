import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, Plugin, setIcon, setTooltip, TFile } from 'obsidian';
import {
	AnnotationController,
	buildToolbar,
	capturePointer,
	findScrollParent,
	HistoryStack,
	scaleAnnotationUniform,
	ToolState,
	type Annotation,
} from '../annotate';
import { createId } from '../annotate/id';
import {
	INK_BLOCK_LANGUAGE,
	InkBlockData,
	findInkBlockById,
	findUniqueInkBlockByBody,
	emptyInkBlock,
	inkBlockMarkdown,
	parseInkBlock,
	serializeInkBlock,
} from './inkBlockFormat';

// Batches rapid successive strokes into one write, the same reasoning as
// the PDF view's own debounce: every save rewrites a region of the user's
// note, and handwriting arrives as a burst of short strokes.
const WRITE_DEBOUNCE_MS = 800;

// How long to wait before retrying a write that landed mid-gesture. Saving
// rewrites the block's source, which makes Obsidian re-render it — doing
// that under a pen still on the surface would yank the drawing surface out
// from under the stroke in progress.
const GESTURE_RETRY_MS = 250;

// How long to wait before trying again when the block cannot be found
// in its own note, and how many times. A note being actively edited can
// briefly not contain the fence a save is looking for — the user is
// midway through cutting and pasting a section, say. Retrying rather
// than giving up is what stops a transient state from needing a
// re-render to recover from.
const LOCATE_RETRY_MS = 1200;
const LOCATE_RETRIES = 4;

// How long to keep restoring the note's scroll position after a save. See
// keepScrollPosition — the scroll that has to be undone happens *after* the
// edit that caused it, and in reading view after the re-render later still,
// so one synchronous reset is not enough. Short enough that a deliberate
// scroll begun in the same breath as a pen-lift is at worst briefly
// interrupted.
const SCROLL_RESTORE_MS = 120;

// Undo histories kept across the re-render a block’s own save causes.
//
// A block’s controller is destroyed and rebuilt roughly a second after
// the pen comes up, and the history used to go with it — so undo could
// never reach past your last pause, on the one surface people draw on
// most. Keeping it out here, and handing it back to the rebuilt
// controller, is the same move ToolState made for the pen itself.
//
// Keyed by note path, block id, and the scale the entries were recorded
// at: an entry holds coordinates, so replaying one recorded at a
// different surface resolution would put the ink back in the wrong place.
// A window resized mid-session starts a fresh history rather than a
// subtly wrong one.
interface RetainedHistory {
	history: HistoryStack;
	scale: number;
}

const retainedHistories = new Map<string, RetainedHistory>();

// Bounded so a long session over a big vault cannot accumulate one per
// block ever rendered. Map preserves insertion order, so the oldest goes
// first — and losing an undo history for a block nobody has touched in a
// hundred blocks is not a loss anyone notices.
const MAX_RETAINED_HISTORIES = 32;

function retainedHistoryFor(key: string): RetainedHistory {
	const existing = retainedHistories.get(key);
	if (existing) return existing;

	const retained: RetainedHistory = { history: new HistoryStack(), scale: 1 };
	retainedHistories.set(key, retained);
	while (retainedHistories.size > MAX_RETAINED_HISTORIES) {
		const oldest = retainedHistories.keys().next().value;
		if (oldest === undefined) break;
		retainedHistories.delete(oldest);
	}
	return retained;
}

// How much sharper than the note’s column a block’s canvas may be backed.
//
// The surface is stored 800 units wide and shown at whatever width the
// note’s column happens to be, so backing the canvas at the stored size —
// which is what it used to do — stretched it, by about 2.25x on a
// high-DPI desktop. Ink came out visibly soft on exactly the screens
// people read on.
//
// Capped because the cost is real: a canvas is width x height x 4 bytes,
// twice over (see PageMount), for every block in the note.
const MAX_SURFACE_SCALE = 3;

// How far outside the viewport a block mounts its canvases. Wide enough
// that scrolling at a normal speed always meets a block that is already
// drawn, rather than a blank sheet filling in late.
const SURFACE_MOUNT_MARGIN = '400px 0px';

// How far outside it a block gives them up again — deliberately much
// further out than it mounts at.
//
// One margin for both meant a block sitting right on the boundary
// mounted and released on every small scroll, and each cycle allocates
// two canvases, redraws every stroke, and throws it all away again. A
// scroll that rocks back and forth by a few dozen pixels — which is
// what reading looks like — did that repeatedly.
//
// The gap between the two is the hysteresis: crossing in is not the same
// place as crossing back out, so nothing oscillates. The cost is that a
// block up to 1200px away still holds its canvases, which is the memory
// Phase E set out to bound; three times the mount margin keeps that well
// short of what it was before, when every block in the note held them.
const SURFACE_RELEASE_MARGIN = '1200px 0px';

// Ink that was drawn but could not be written to the note, kept alive
// across the re-render that would otherwise throw it away.
//
// A block that fails to save leaves the drawing on screen and nothing in
// the file. That looks fine — until anything re-renders the note, at
// which point the block reloads from the file and the work is simply
// gone. This is what that failure cost in practice, and it is not
// acceptable for a save to be able to lose work quietly.
//
// Module-level for the same reason the open-tool-strip set is: an
// InkBlockView does not survive its own note's re-render, so anything
// meant to outlive one cannot live on it. Keyed by note path and block
// id, so two blocks — or two notes — cannot collide.
const unsavedInk = new Map<string, InkBlockData>();

// The pencil on the block's tool toggle, drawn here rather than asked for
// from the host.
//
// This button lost its icon twice on a phone — first pencil-ruler, then
// pen-tool — while every icon in the tool strip beside it drew correctly.
// The icon set belongs to Obsidian, it is not the same on mobile as on
// desktop, and a plugin has no way to ask which names a given build knows:
// setIcon leaves an empty <svg> for one it does not, which is a blank
// button and no error. Guessing at a name old enough to be safe is a guess
// that can only be checked by shipping it to a device.
//
// Two paths cost nothing and cannot go missing. Shaped and styled like a
// Lucide glyph — stroke, round caps, currentColor — so it still sits with
// the rest of the app's chrome, and sized in the stylesheet in absolute
// units so no theme variable can collapse it either.
function drawPencil(host: HTMLElement): void {
	const svg = host.createSvg('svg', {
		cls: 'inkling-block-toggle-icon',
		attr: {
			viewBox: '0 0 24 24',
			fill: 'none',
			stroke: 'currentColor',
			'stroke-width': '2',
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
			'aria-hidden': 'true',
		},
	});
	svg.createSvg('path', { attr: { d: 'M12 20h9' } });
	svg.createSvg('path', { attr: { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' } });
}

function recoveryKey(sourcePath: string, blockId: string): string {
	return `${sourcePath}::${blockId}`;
}

// Blocks whose canvases were attached a moment ago, by note path and block id.
//
// This exists for one case: a block rebuilt by its own save. Saving rewrites
// the fence, Obsidian re-renders that section, and the block is destroyed and
// rebuilt about a second after the pen comes up — which is already why the
// tool strip, the undo history and the note's scroll position are all kept
// outside the view that owns them.
//
// The rebuilt block is created at full size, because the aspect ratio holds
// the space, but its canvases wait on an IntersectionObserver reporting it
// visible, and that report comes a frame or more later. For that window the
// block is correctly sized and completely empty, so the ink disappears and
// comes back: the flash people notice after writing, and worse on a tablet,
// where a higher pixel ratio makes the canvases slower to attach.
//
// Deferring is right for every other block — a note holding thirty-nine of
// them must not allocate seventy-eight canvases to be scrolled past — and
// wrong only for the one the user is drawing in, which is certainly on screen
// because they are looking at it.
const recentlyMounted = new Map<string, number>();

// Long enough to cover the write debounce and the re-render it causes, short
// enough that a block scrolled away from and returned to still gets the
// ordinary deferred treatment.
const REMOUNT_WINDOW_MS = 5000;

// Bounded like the retained histories above, and for the same reason.
const MAX_RECENTLY_MOUNTED = 32;

function markRecentlyMounted(key: string): void {
	// Deleted first so re-setting moves it to the end, which is what makes
	// the eviction below drop the least recently mounted.
	recentlyMounted.delete(key);
	recentlyMounted.set(key, Date.now());
	if (recentlyMounted.size > MAX_RECENTLY_MOUNTED) {
		const oldest = recentlyMounted.keys().next().value;
		if (oldest !== undefined) recentlyMounted.delete(oldest);
	}
}

function wasRecentlyMounted(key: string): boolean {
	const at = recentlyMounted.get(key);
	if (at === undefined) return false;
	if (Date.now() - at <= REMOUNT_WINDOW_MS) return true;
	recentlyMounted.delete(key);
	return false;
}

// How much sharper than its stored size a block canvas should be backed,
// given the element it has to fill and the screen it is on.
function surfaceScale(containerEl: HTMLElement, storedWidth: number): number {
	const cssWidth = containerEl.clientWidth;
	if (!cssWidth || storedWidth <= 0) return 1;
	const density = window.devicePixelRatio || 1;
	// Never *below* the stored size: shrinking the backing store to fit a
	// narrow phone column would throw away detail the file already holds,
	// and the ink would come back coarser than it was drawn.
	return Math.min(Math.max((cssWidth * density) / storedWidth, 1), MAX_SURFACE_SCALE);
}

// Only the block’s own single drawing surface is ever mounted into a given
// controller, so the page-keyed API the controller shares with the PDF view
// (where the key is a real page number) always gets the same key here.
const BLOCK_PAGE = 1;

// Blocks the user has opened for editing, by note path and block id.
//
// Module-level for the same reason tool state is plugin-level: an
// InkBlockView does not survive its own save. Writing a block rewrites the
// fence, Obsidian re-renders that section, and the render child — toolbar
// and all — is torn down and rebuilt about a second after the pen comes up.
// Without this, every stroke would close the block you were drawing in.
//
// Keyed by id rather than by the fence's starting line, which is what this
// used to use. A line number is only identity for as long as nothing above
// the block moves, and prose edited above one left an entry pointing at
// whichever block now starts on that line. That was worth living with when
// the cost was a tool strip opening uninvited; it is not now that the same
// entry decides which block accepts ink.
const openToolStrips = new Set<string>();

// Manual resizing, via the drag handle along a block's bottom edge.
//
// Height only, never width. The surface always spans the note's column, so
// the stored width is what fixes the scale between stored coordinates and
// screen pixels — changing it would rescale every stroke already drawn
// rather than give more room. Height is free to change because it only adds
// or removes space below; nothing already drawn moves.
//
// Shrinking past existing ink is allowed and non-destructive: strokes are
// kept in full and simply fall outside the visible area, so dragging back
// down brings them straight back.
const MIN_BLOCK_HEIGHT = 120;
const MAX_BLOCK_HEIGHT = 4000;

// One live ink block in a rendered note. Instances are created per render —
// Obsidian re-runs the post-processor whenever the block's section is
// re-rendered — so everything here is torn down through the render child
// below rather than assumed to live as long as the file is open.
class InkBlockView {
	private readonly controller: AnnotationController;
	private data: InkBlockData;
	private disposeToolbar: (() => void) | null = null;
	private writeHandle: number | null = null;
	private readonly toolbarHost: HTMLElement;
	// Assigned in the constructor; held because resizing (see applyHeight)
	// restates the aspect ratio that gives this element its height.
	private readonly surfaceEl!: HTMLElement;
	private detached = false;
	// Set when the source held something this build couldn't fully read, in
	// which case this block renders but never saves — see the banner below.
	private readOnly = false;

	// Identifies this block across the re-render its own save causes — see
	// openToolStrips. Null when the block's position can't be read, in which
	// case the tool strip simply isn't remembered.
	private readonly stripKey: string;

	// This block's own identity in the note, and the exact text it rendered
	// from — the two things a save checks before overwriting a fence. See
	// locate/findUniqueInkBlockByBody for why "it's an ink block" was not
	// enough.
	private readonly blockId: string;
	private renderedSource: string;
	// One report per view, not one per save: a mismatch repeats on every
	// debounce tick for as long as the note is open.
	private reportedMismatch = false;
	// Consecutive failures to find this block in its own note. Reset on
	// every successful save.
	private locateFailures = 0;

	// How many surface units there are per stored unit. The block is
	// stored 800 wide whatever screen drew it; the canvas is backed at
	// the width it is actually shown at, times the display density, so
	// ink is drawn at the resolution it is looked at. Everything the
	// controller holds is in surface units, everything in the file is in
	// stored units, and this is the only thing between them.
	// How many surface units there are per stored unit — measured when the
	// surface is actually mounted, because at construction the block is
	// not in the layout yet and reports a width of zero. Everything the
	// controller holds is in surface units, everything in the file is in
	// stored units, and this is the only thing between them.
	private scale = 1;
	private readonly retained: RetainedHistory;
	// The element the canvases are mounted into, and whether they
	// currently are. See watchVisibility.
	private readonly contentEl: HTMLElement;
	private observers: IntersectionObserver[] = [];
	// The drag handle along the block's bottom edge, shown only while the
	// tool strip is open. See setResizeHandleVisible.
	private resizeHandleEl: HTMLElement | null = null;
	// The pending frame in watchVisibility, so detaching before it runs
	// cannot leave a callback pointing at a torn-down block.
	private watchHandle: number | null = null;
	private mounted = false;
	// Whether the file’s annotations have been handed to the store yet.
	// Once they have, the store is the live truth and a remount must not
	// overwrite it.
	private seeded = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		source: string,
		toolState: ToolState,
	) {
		const { data, malformed } = parseInkBlock(source);
		// A block written before ids existed picks one up the first time it
		// saves; until then it is located by its exact source text instead.
		this.blockId = data.id ?? createId();
		this.renderedSource = source.trim();

		// Ink from a save that failed before this block was re-rendered is
		// strictly newer than what the file holds — the file is what the
		// failed save was trying to update. Adopting it here, and saving
		// again below, is what turns a failed save into a delayed one
		// rather than into lost work.
		const rescued = unsavedInk.get(recoveryKey(ctx.sourcePath, this.blockId));
		this.data = rescued ? { ...rescued, id: this.blockId } : { ...data, id: this.blockId };

		// The same key the recovery map uses, and for the same reason: it is
		// the one name for this block that survives its own save.
		this.stripKey = recoveryKey(ctx.sourcePath, this.blockId);

		this.retained = retainedHistoryFor(recoveryKey(ctx.sourcePath, this.blockId));

		this.controller = new AnnotationController({
			toolState,
			// Kept outside the controller so undo survives this block being
			// rebuilt by its own save. See retainedHistories.
			history: this.retained.history,
			getCurrentPage: () => BLOCK_PAGE,
			onAnnotationsChanged: () => this.scheduleWrite(),
		});
		// No pages to add or remove inside a note — that's a handwritten-note
		// concept, and the toolbar hides the control when this is false.
		this.controller.setCanManagePages(false);
		// Ready to write immediately. The shared default is the select tool,
		// which suits the PDF view (where you often open a file to read, and
		// reach for a tool deliberately) but not a block you added
		// specifically to handwrite into — landing in select mode there
		// means a stylus does nothing at all until the toolbar is opened.
		// A suggestion, not an assignment: this runs again on every save's
		// re-render, and forcing the pen there would snatch the lasso back
		// from anyone who had deliberately switched to it.
		this.controller.suggestTool('pen');

		containerEl.addClass('inkling-ink-block');
		this.toolbarHost = containerEl.createDiv({ cls: 'inkling-ink-block-toolbar-host' });

		// Mirrors the PDF view's placeholder > content > canvases nesting:
		// the gesture layer finds a page's zoomable wrapper and its clipping
		// box by walking up from the canvas it's attached to, so pinch-zoom
		// and panning work here for free by matching that shape.
		const surface = containerEl.createDiv({ cls: 'inkling-ink-block-surface' });
		this.surfaceEl = surface;
		const content = surface.createDiv({ cls: 'inkling-ink-block-content' });

		// Width comes from the note's own column; the stored size sets the
		// proportions. Pointer input is mapped through the canvas backing
		// scale (see annotate/pointer.ts), so a block drawn on a phone and
		// reopened on a desktop still puts every stroke where it was drawn.
		surface.setCssProps({ '--inkling-block-aspect': `${this.data.width} / ${this.data.height}` });
		this.contentEl = content;
		// Deferred until the block is near the screen — see watchVisibility.
		// The surface keeps its size regardless, from the aspect ratio above,
		// so nothing reflows when the canvases come and go.
		this.watchVisibility();

		if (malformed) {
			// Deliberately never saves over it: a block this build can't fully
			// read is far more likely to be from a newer version of the
			// plugin, or damaged in a way the original could still recover,
			// than something worth replacing with what little parsed.
			this.readOnly = true;
			const banner = this.containerEl.createDiv({ cls: 'inkling-ink-block-banner' });
			setIcon(banner.createDiv({ cls: 'inkling-ink-block-banner-icon' }), 'alert-triangle');
			banner.createDiv({
				cls: 'inkling-ink-block-banner-text',
				text: "Inkling couldn't read this ink block completely, so it won't be saved over. It may have been written by a newer version of the plugin.",
			});
		}

		// Deliberately after mountPage/seedPage above, so the rescued ink is
		// on screen before the save that persists it is attempted.
		if (rescued && !this.readOnly) this.scheduleWrite();

		// Blocks open closed to editing, and the toggle below is what opens
		// them. A note is read far more often than it is drawn in, and a
		// surface that takes ink the moment anything touches it is a surface
		// that collects stray marks from a stylus resting on the way past —
		// on the one screen, a tablet, where the pen is also how you scroll.
		//
		// This is separate from `this.readOnly` above, which means the block
		// must *never* be written because we could not fully read it. That
		// one is permanent and the toggle cannot lift it; this one is the
		// user's to change whenever they like.
		this.controller.setReadOnly(true);

		this.buildToolbarToggle();
		// A read-only block never saves, so offering a handle that appears to
		// resize it and then silently forgets would be worse than not having
		// one.
		if (!this.readOnly) this.buildResizeHandle();
	}

	private buildToolbarToggle(): void {
		// An icon button, matching the tool strip it opens — a lone "Tools"
		// text button sitting above every ink block in a note read like a
		// piece of the note's own content rather than plugin chrome.
		const toggle = this.toolbarHost.createEl('button', { cls: 'inkling-ink-block-toggle' });
		toggle.type = 'button';
		drawPencil(toggle);
		// Stated up front rather than left to setOpen below, which no-ops
		// when asked for the state it's already in: a collapsed toggle still
		// has to announce itself as collapsed, not as un-expandable.
		toggle.setAttribute('aria-expanded', 'false');

		const setOpen = (open: boolean) => {
			if (open === (this.disposeToolbar !== null)) return;
			if (open) {
				// Built on demand, not for every block on screen: a note can
				// hold many of these, and a full tool strip apiece would crowd
				// out the writing they're meant to sit alongside.
				this.disposeToolbar = buildToolbar(this.toolbarHost, this.controller);
			} else {
				this.disposeToolbar?.();
				this.disposeToolbar = null;
			}

			// What the button is actually for. The strip is the visible half;
			// this is the half that decides whether the surface takes ink at
			// all, so a block nobody has asked to edit cannot collect a stray
			// mark from a pen on its way past.
			//
			// A block we could not fully read stays closed to writing whatever
			// this says — that decision is not the user's to reverse, because
			// what would be written over is what we failed to understand.
			this.controller.setReadOnly(!open || this.readOnly);

			const label = open ? 'Done editing this block' : 'Edit this block';
			setTooltip(toggle, label);
			toggle.setAttribute('aria-label', label);
			toggle.toggleClass('is-active', open);
			toggle.setAttribute('aria-expanded', String(open));
			this.setResizeHandleVisible(open);
		};

		// Never a no-op on the first call, whatever setOpen decides below:
		// the label has to say something before anything is toggled.
		setTooltip(toggle, 'Edit this block');
		toggle.setAttribute('aria-label', 'Edit this block');

		toggle.addEventListener('click', () => {
			const open = this.disposeToolbar === null;
			setOpen(open);
			// Recorded only on a real click. A strip that came and went with a
			// re-render must not count as the user having opened or closed
			// anything.
			if (open) openToolStrips.add(this.stripKey);
			else openToolStrips.delete(this.stripKey);
		});

		setOpen(openToolStrips.has(this.stripKey));
	}

	// Applies a new drawing-surface height. Both parts have to move
	// together: the aspect ratio is what gives the surface its on-screen
	// height, and the canvases' backing store is what gives the drawing
	// space its extra room. Width is untouched, so the coordinate-to-screen
	// scale is unchanged and nothing already drawn shifts or resizes.
	private applyHeight(height: number): void {
		const clamped = Math.round(Math.min(Math.max(height, MIN_BLOCK_HEIGHT), MAX_BLOCK_HEIGHT));
		if (clamped === this.data.height) return;

		this.data = { ...this.data, height: clamped };
		this.surfaceEl.setCssProps({ '--inkling-block-aspect': `${this.data.width} / ${clamped}` });
		// Goes through the store's live-update path, so a resize counts as
		// exactly that rather than an edit: no history entry of its own, and
		// no change notification recursing back into the save path.
		this.controller.resizePage(
			BLOCK_PAGE,
			this.data.width * this.scale,
			clamped * this.scale,
			this.controller.getPageAnnotations(BLOCK_PAGE),
		);
	}

	// Shows or hides the resize handle along with the tool strip.
	//
	// The handle spans the block's whole bottom edge, which put a drag target
	// between every block and the prose under it. Scrolling a note by dragging
	// — which is how a note gets read on a touchscreen — caught it, and the
	// block stretched instead of the page moving.
	//
	// Resizing is a deliberate act and a rare one, so it now lives behind the
	// same "Tools" toggle the pens do: no strip open, no handle to catch. A
	// block being read has nothing draggable on it at all.
	private setResizeHandleVisible(visible: boolean): void {
		if (!this.resizeHandleEl) return;
		this.resizeHandleEl.hidden = !visible;
		this.surfaceEl.toggleClass('inkling-has-handle', visible);
	}

	private buildResizeHandle(): void {
		const handle = this.containerEl.createDiv({ cls: 'inkling-ink-block-handle' });
		this.resizeHandleEl = handle;
		// Lets the surface square off the corners the handle joins on to.
		// Set here rather than found with a :has() selector, since this is
		// the code that decides the handle exists at all.
		//
		// Built once but shown only while the tool strip is open, and the
		// strip's own state decides which — a block whose strip the user left
		// open comes back with its handle, and every other block comes back
		// without one. See setResizeHandleVisible.
		this.setResizeHandleVisible(this.disposeToolbar !== null);
		handle.setAttribute('aria-label', 'Drag to resize this ink block');
		setTooltip(handle, 'Drag to resize');

		let drag: { pointerId: number; startY: number; startHeight: number } | null = null;
		// Coalesces a burst of pointermoves into one resize per frame —
		// re-backing two canvases and repainting every stroke on each move
		// event would make dragging stutter on a long drawing.
		let pendingHeight: number | null = null;
		let frame: number | null = null;

		const flush = () => {
			frame = null;
			if (pendingHeight === null) return;
			this.applyHeight(pendingHeight);
			pendingHeight = null;
		};

		handle.addEventListener('pointerdown', (event: PointerEvent) => {
			drag = { pointerId: event.pointerId, startY: event.clientY, startHeight: this.data.height };
			capturePointer(handle, event.pointerId);
			// Stops the drag from also scrolling the note on touch, the same
			// reason the drawing canvases set touch-action: none.
			event.preventDefault();
		});

		handle.addEventListener('pointermove', (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			// The handle moves in CSS pixels but height is stored in the
			// surface's own coordinate space, so the drag distance has to be
			// converted through the current on-screen scale — otherwise a
			// drag moves the edge by a different amount than the pointer on
			// every screen width but one.
			const cssWidth = this.surfaceEl.getBoundingClientRect().width;
			const perCssPixel = cssWidth > 0 ? this.data.width / cssWidth : 1;
			pendingHeight = drag.startHeight + (event.clientY - drag.startY) * perCssPixel;
			frame ??= window.requestAnimationFrame(flush);
		});

		const end = (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			drag = null;
			if (frame !== null) {
				window.cancelAnimationFrame(frame);
				frame = null;
			}
			flush();
			this.scheduleWrite();
		};

		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	// ---- Surface mounting ----

	// A block only holds canvases while it is somewhere near the screen.
	//
	// Measured on the note that prompted this: fourteen blocks, and every
	// one of them mounted a base and an overlay canvas whether or not
	// anyone was looking at it — 38 MB of backing store at the stored size,
	// and 118 MB once those canvases were backed at display resolution.
	// Parsing all fourteen blocks, by contrast, takes 9 ms. The JSON was
	// never the problem; the canvases were.
	//
	// This is the same trade the PDF view makes for pages, for the same
	// reason and with the same margin: render ahead of the reader so a
	// block is ready before it is seen, and let go of the ones they have
	// scrolled well past.
	// Waits for the block to be in the layout, then watches it.
	//
	// The wait is the point. An IntersectionObserver's root has to be the
	// element that actually scrolls — Obsidian's `.markdown-preview-view`,
	// not the viewport — and at construction time this block is not in the
	// document yet, so there is nothing to find. That is the same reason
	// mountSurface measures its width when it mounts rather than here.
	//
	// Getting the root wrong is not a small miss: a margin measured against
	// the viewport buys nothing at all, because an ancestor that scrolls
	// clips the block to empty long before the viewport does. Observed with
	// a block 73px below the fold and a 400px margin — `isIntersecting` was
	// false against the viewport and true against the scroller. So the
	// look-ahead below only exists when the root is right, and without it a
	// block mounts at the instant it becomes visible and is drawn late.
	private watchVisibility(): void {
		let framesLeft = 5;

		// Whether this is a block coming straight back from its own save. See
		// recentlyMounted: it is the one case where waiting to be told the
		// block is visible shows the user an empty block instead of their ink.
		const remounting = wasRecentlyMounted(recoveryKey(this.ctx.sourcePath, this.blockId));

		const start = (): void => {
			if (this.detached) return;

			// Retried rather than assumed: one frame is normally enough, but
			// a block inside a folded section or an inactive tab can take
			// longer to land. Falling back to the viewport after a few tries
			// is a worse look-ahead, never a broken block.
			if (!this.surfaceEl.isConnected && framesLeft-- > 0) {
				this.watchHandle = window.requestAnimationFrame(start);
				return;
			}
			this.watchHandle = null;

			const root = findScrollParent(this.surfaceEl);

			// Straight back on screen, without waiting for the observer's first
			// report. Guarded on a measurable width because that is what
			// mountSurface scales the canvases by: a block inside a folded
			// section measures zero, and mounting it now would back it at the
			// stored size and leave it there. Those wait, as they always did.
			if (remounting && this.surfaceEl.clientWidth > 0) this.mountSurface();

			// Two observers rather than one, because mounting and releasing
			// happen at different distances and a single observer only has
			// the one boundary. Each ignores the edge that is not its own.
			const mount = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) this.mountSurface();
				},
				{ root, rootMargin: SURFACE_MOUNT_MARGIN },
			);
			const release = new IntersectionObserver(
				(entries) => {
					if (entries.every((entry) => !entry.isIntersecting)) this.releaseSurface();
				},
				{ root, rootMargin: SURFACE_RELEASE_MARGIN },
			);

			for (const observer of [mount, release]) {
				observer.observe(this.surfaceEl);
				this.observers.push(observer);
			}
		};

		// A remount skips the frame's wait entirely when the element is
		// already in the document, which on a re-render it usually is.
		if (remounting && this.surfaceEl.isConnected) {
			start();
			return;
		}
		this.watchHandle = window.requestAnimationFrame(start);
	}

	private mountSurface(): void {
		if (this.mounted || this.detached) return;
		this.mounted = true;

		// Measured here rather than in the constructor: a block is not in
		// the layout when its post-processor runs, so it reports a width of
		// zero and every canvas came out backed at the stored size — which
		// is exactly the softness this was meant to fix.
		const previous = this.scale;
		this.scale = surfaceScale(this.surfaceEl, this.data.width);
		const width = this.data.width * this.scale;
		const height = this.data.height * this.scale;

		this.controller.mountPage(BLOCK_PAGE, this.contentEl, width, height);

		if (!this.seeded) {
			// Only ever on the first mount. mountPage repaints from the store,
			// which is the live truth once anything has been drawn, so
			// reseeding on a remount would put the file’s version back and
			// throw away every stroke made since.
			this.seeded = true;
			this.controller.seedPage(BLOCK_PAGE, this.toSurface(this.data.annotations));
		} else if (Math.abs(previous - this.scale) > 0.001) {
			// The column changed width, or the note moved to another screen.
			// Everything in the store is in the old surface units and has to
			// come with it.
			const factor = this.scale / previous;
			this.controller.resizePage(
				BLOCK_PAGE,
				width,
				height,
				this.controller.getPageAnnotations(BLOCK_PAGE).map((a) => scaleAnnotationUniform(a, factor)),
			);
			// History entries hold coordinates in the scale they were
			// recorded at, so replaying one now would put ink back in the
			// wrong place. Losing undo is the lesser of the two.
			this.retained.history.clear();
		}
		this.retained.scale = this.scale;
		markRecentlyMounted(recoveryKey(this.ctx.sourcePath, this.blockId));
	}

	private releaseSurface(): void {
		if (!this.mounted) return;
		// Never mid-stroke: unmounting would take the surface out from under
		// a pen that is still down. A gesture cannot outlast a scroll by
		// much, so the next callback picks it up.
		if (this.controller.isGestureActive()) return;
		this.mounted = false;
		// The store keeps this page’s annotations, so remounting redraws them
		// without touching the file.
		this.controller.unmountPage(BLOCK_PAGE);
	}

	private scheduleWrite(): void {
		if (this.detached || this.readOnly) return;
		if (this.writeHandle !== null) window.clearTimeout(this.writeHandle);
		this.writeHandle = window.setTimeout(() => void this.write(), WRITE_DEBOUNCE_MS);
	}

	// Saving a block rewrites the note, and any document change makes the
	// editor scroll its cursor back into view. Drawing with a stylus never
	// moves that cursor — it stays wherever it was last placed, which for a
	// note you opened and drew in is usually the very top — so every autosave
	// yanked the note back up to it a couple of seconds after the user
	// stopped writing, which is the whole time a debounced save takes to
	// fire. Reading view has the same symptom by a different route: the
	// re-render resets the preview scroller.
	//
	// So: remember where the note actually is, and put it back. Repeatedly,
	// for a moment, because the scroll being undone happens after the edit
	// returns rather than during it.
	private keepScrollPosition(): () => void {
		const scroller = findScrollParent(this.containerEl);
		if (!scroller) return () => undefined;
		const { scrollTop, scrollLeft } = scroller;

		return () => {
			const deadline = performance.now() + SCROLL_RESTORE_MS;
			const restore = () => {
				// Only ever corrects a jump away from where the note was. A
				// scroller already sitting where it should be is left alone, so
				// this can't fight the user for control of it.
				if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
				if (scroller.scrollLeft !== scrollLeft) scroller.scrollLeft = scrollLeft;
				if (performance.now() < deadline) window.requestAnimationFrame(restore);
			};
			restore();
		};
	}

	private async write(): Promise<void> {
		this.writeHandle = null;
		if (this.detached || this.readOnly) return;

		// Saving re-renders this block; doing that mid-stroke would destroy
		// the surface the stroke is being drawn on. Gestures are short, so
		// waiting one out costs nothing.
		if (this.controller.isGestureActive()) {
			this.writeHandle = window.setTimeout(() => void this.write(), GESTURE_RETRY_MS);
			return;
		}

		// The store is only the truth once it has been seeded. A block that
		// has never been mounted — one recovering unsaved ink while still
		// scrolled off screen, most importantly — has an *empty* store, and
		// writing that would erase the drawing this save exists to protect.
		if (this.seeded) {
			this.data = { ...this.data, annotations: this.toStored(this.controller.getPageAnnotations(BLOCK_PAGE)) };
		}
		const serialized = serializeInkBlock(this.data);

		// Held from here on, not only on failure. Every path below can end
		// without writing — a note that closed mid-debounce, a fence that has
		// moved, a vault error — and each of those used to leave the drawing
		// on screen and nothing in the file, which the next re-render then
		// discarded. Stashing first and clearing on success means the only
		// way to lose ink is to lose the session.
		const key = recoveryKey(this.ctx.sourcePath, this.blockId);
		unsavedInk.set(key, this.data);

		const restoreScroll = this.keepScrollPosition();

		const editor = this.findOpenEditor();
		if (editor) {
			// Through the editor, not the file, whenever the note is open:
			// this lands as an ordinary edit in the same document the user is
			// working in — one undo step, no external-modification reload,
			// and no fight with unsaved changes the editor hasn’t flushed to
			// disk yet.
			// One call, not one per line. Reading the document a line at a
			// time costs a tree lookup and a string slice apiece, which was
			// tolerable at 409 lines and is not at 7,788 — the count on the
			// largest note in the vault once stored JSON began wrapping. This
			// runs on the main thread while the pen is still moving.
			const lines = editor.getValue().split('\n');

			const range = this.locate(lines);
			if (!range) {
				this.handleLocateFailure();
				return;
			}

			editor.replaceRange(
				`${serialized}\n`,
				{ line: range.lineStart + 1, ch: 0 },
				{ line: range.lineEnd, ch: 0 },
			);
			this.renderedSource = serialized;
			this.locateFailures = 0;
			unsavedInk.delete(key);
			restoreScroll();
			return;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		try {
			let wrote = false;
			await this.plugin.app.vault.process(file, (contents) => {
				const lines = contents.split('\n');
				const range = this.locate(lines);
				if (!range) return contents;
				lines.splice(range.lineStart + 1, range.lineEnd - range.lineStart - 1, serialized);
				wrote = true;
				return lines.join('\n');
			});
			if (!wrote) {
				this.handleLocateFailure();
				return;
			}
			this.renderedSource = serialized;
			this.locateFailures = 0;
			unsavedInk.delete(key);
			restoreScroll();
		} catch (error) {
			console.error('Inkling: failed to save an ink block.', error);
			new Notice('Inkling: could not save this ink block. Your drawing is still on screen and will be saved again shortly.');
		}
	}

	// Stored units to surface units and back. The only two places the two
	// spaces meet: everything the controller sees is surface, everything
	// in the file is stored.
	private toSurface(annotations: Annotation[]): Annotation[] {
		if (this.scale === 1) return annotations;
		return annotations.map((annotation) => scaleAnnotationUniform(annotation, this.scale));
	}

	private toStored(annotations: Annotation[]): Annotation[] {
		if (this.scale === 1) return annotations;
		return annotations.map((annotation) => scaleAnnotationUniform(annotation, 1 / this.scale));
	}

	// Where this block’s fence actually is in `lines`.
	//
	// By id first, because that answers the question directly. Obsidian’s
	// getSectionInfo is a report of where a block is, and in a note holding
	// several it is a report that can be wrong — which is how one block’s
	// drawing was written into another’s, and how refusing that write then
	// lost the drawing instead.
	//
	// For the one case an id search cannot answer — a block that has never
	// been saved, and so carries no id in the file yet — the note is searched
	// for the fence holding this view's exact text instead. getSectionInfo is
	// not consulted at all any more, and that is the fix for a second way
	// this lost work.
	//
	// It used to be the fallback, with its reported range checked against
	// that same text before writing. The check could not do the job it was
	// given: two ink blocks nobody has drawn in yet are the same fifty-five
	// bytes of empty JSON, so an empty block compared equal to *any* other
	// empty block, a misreported range sailed through, and one block's
	// drawing was written into another block's fence — which reads, from the
	// outside, as the work in the first block disappearing the moment the
	// second one was touched.
	//
	// Searching for a uniquely-matching fence answers the question directly
	// and refuses when the answer is ambiguous, which a failed save turns
	// into ink kept rather than ink misplaced.
	private locate(lines: readonly string[]): { lineStart: number; lineEnd: number } | null {
		const byId = findInkBlockById(lines, this.blockId);
		if (byId) return byId;

		return findUniqueInkBlockByBody(lines, this.renderedSource);
	}

	// The block is not where it should be. The drawing is already stashed
	// (see write), so nothing is lost either way — but a retry usually
	// resolves it without the user ever knowing, and only a run of
	// failures is worth telling them about.
	private handleLocateFailure(): void {
		this.locateFailures += 1;
		if (this.locateFailures <= LOCATE_RETRIES) {
			if (this.writeHandle !== null) window.clearTimeout(this.writeHandle);
			this.writeHandle = window.setTimeout(() => void this.write(), LOCATE_RETRY_MS);
			return;
		}
		this.reportMismatch();
	}

	// Refusing to save is the safe outcome, but a silent one would look like
	// ink vanishing, so say so once. The block's own next render re-seeds
	// from the file and picks the work back up.
	private reportMismatch(): void {
		if (this.reportedMismatch) return;
		this.reportedMismatch = true;
		console.error(
			`Inkling: could not find ink block ${this.blockId} in ${this.ctx.sourcePath} to save it. ` +
				'The drawing is still on screen and is held in memory, and will be written the next time the note renders. ' +
				'If the block was deleted from the note, that is expected.',
		);
		new Notice('Inkling: an ink block could not be saved yet. Your drawing is safe — leave the note open.');
	}

	// Any open editor on this note, not just the focused one — drawing on a
	// canvas doesn't necessarily move focus to the note's editor, and a note
	// can be open in a split alongside the one being looked at.
	// The editor to save through, or null to go to the file instead.
	//
	// A view in reading mode is skipped, and that is not a nicety: an edit
	// made through its editor is silently discarded. Measured in the running
	// app — replaceRange on a reading-mode view changed the buffer, left
	// `dirty` false, never reached disk, and was gone the moment the view
	// re-synced from the file.
	//
	// That made this the worst kind of failure. The write did not throw, so
	// the save counted itself a success, cleared the recovery entry that
	// exists to survive a failed save, and left the ink on screen with
	// nothing in the file — until the next re-render, which took it. Exactly
	// the "it glitched and it was gone" this plugin already has one fix for;
	// that fix addressed a save that could not find its block, and this is a
	// save that finds it and writes somewhere that does not last.
	//
	// Live Preview reports 'source' here, the same as source mode, so only
	// reading view takes the file path below — which is the path that works
	// regardless of what is open.
	private findOpenEditor() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== this.ctx.sourcePath) continue;
			if (view.getMode() === 'preview') continue;
			return view.editor;
		}
		return null;
	}

	detach(): void {
		if (this.watchHandle !== null) {
			window.cancelAnimationFrame(this.watchHandle);
			this.watchHandle = null;
		}
		for (const observer of this.observers) observer.disconnect();
		this.observers = [];
		if (this.writeHandle !== null) {
			window.clearTimeout(this.writeHandle);
			this.writeHandle = null;
			// Flush before tearing down, or ink drawn in the last moment
			// before a re-render (scrolling far enough away is enough to
			// cause one) would be lost.
			void this.write();
		}
		this.detached = true;
		this.disposeToolbar?.();
		this.disposeToolbar = null;
		// destroy, not unmountAll: this controller is one of many built over
		// the plugin-wide ToolState, and only this drops its subscription to
		// it. Every save rebuilds this view, so a controller left subscribed
		// would be a controller leaked per save.
		this.controller.destroy();
	}
}

// Binds a block's lifetime to the rendered element, so one that scrolls out
// of the rendered region — or a note that closes — takes its controller,
// toolbar and pending write down with it.
class InkBlockChild extends MarkdownRenderChild {
	private view: InkBlockView | null = null;

	constructor(
		containerEl: HTMLElement,
		private readonly create: () => InkBlockView,
	) {
		super(containerEl);
	}

	onload(): void {
		this.view = this.create();
	}

	onunload(): void {
		this.view?.detach();
		this.view = null;
	}
}

export function registerInkBlock(plugin: Plugin, toolState: ToolState): void {
	plugin.registerMarkdownCodeBlockProcessor(INK_BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(new InkBlockChild(el, () => new InkBlockView(plugin, ctx, el, source, toolState)));
	});

	plugin.addCommand({
		id: 'insert-ink-block',
		name: 'Insert ink annotation block',
		// Command palette only, per the plan — no ribbon icon, so it's
		// reachable the same way on desktop and mobile.
		editorCallback: (editor) => {
			// Stamped with its id up front, so a note full of freshly inserted
			// blocks — which are otherwise byte-identical — can still tell
			// itself apart at save time. Two blocks with no id and no ink in
			// them are the same bytes, and so cannot be told apart at all —
			// see findUniqueInkBlockByBody.
			// Trailing newline so the cursor ends up on a fresh line after
			// the block rather than inside the fence.
			editor.replaceSelection(`${inkBlockMarkdown({ ...emptyInkBlock(), id: createId() })}\n`);
		},
	});
}
