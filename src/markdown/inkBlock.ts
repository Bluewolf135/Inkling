import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, Plugin, setIcon, setTooltip, TFile } from 'obsidian';
import { AnnotationController, buildToolbar, capturePointer, findScrollParent, ToolState } from '../annotate';
import { createId } from '../annotate/id';
import {
	INK_BLOCK_LANGUAGE,
	InkBlockData,
	findInkBlockById,
	emptyInkBlock,
	inkBlockMarkdown,
	parseInkBlock,
	readInkBlockId,
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

function recoveryKey(sourcePath: string, blockId: string): string {
	return `${sourcePath}::${blockId}`;
}

// Only the block’s own single drawing surface is ever mounted into a given
// controller, so the page-keyed API the controller shares with the PDF view
// (where the key is a real page number) always gets the same key here.
const BLOCK_PAGE = 1;

// Blocks whose tool strip the user has opened, by note path and starting
// line. Module-level for the same reason tool state is plugin-level: an
// InkBlockView does not survive its own save. Writing a block rewrites the
// fence, Obsidian re-renders that section, and the render child — toolbar
// and all — is torn down and rebuilt, so a strip opened before writing
// vanished about a second after the pen came up. Remembering it out here
// means the rebuilt block opens with the strip the user left open.
//
// A save replaces the block's body with a single line and so never moves
// its own fence, which is what makes the line number usable as identity
// across exactly the case this exists for. Editing prose *above* a block
// does move it, and can leave an entry pointing at whatever block now
// starts on that line; the cost is a tool strip opening somewhere it wasn't
// asked for, one click to dismiss, which is not worth a block-id field in
// everyone's notes to avoid.
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
	private readonly stripKey: string | null;

	// This block's own identity in the note, and the exact text it rendered
	// from — the two things a save checks before overwriting a fence. See
	// matchesThisBlock for why "it's an ink block" was not enough.
	private readonly blockId: string;
	private renderedSource: string;
	// One report per view, not one per save: a mismatch repeats on every
	// debounce tick for as long as the note is open.
	private reportedMismatch = false;
	// Consecutive failures to find this block in its own note. Reset on
	// every successful save.
	private locateFailures = 0;

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		source: string,
		toolState: ToolState,
	) {
		const { data, malformed } = parseInkBlock(source);
		// A block written before ids existed picks one up the first time it
		// saves; until then matchesThisBlock falls back to the source text.
		this.blockId = data.id ?? createId();
		this.renderedSource = source.trim();

		// Ink from a save that failed before this block was re-rendered is
		// strictly newer than what the file holds — the file is what the
		// failed save was trying to update. Adopting it here, and saving
		// again below, is what turns a failed save into a delayed one
		// rather than into lost work.
		const rescued = unsavedInk.get(recoveryKey(ctx.sourcePath, this.blockId));
		this.data = rescued ? { ...rescued, id: this.blockId } : { ...data, id: this.blockId };

		const section = ctx.getSectionInfo(containerEl);
		this.stripKey = section ? `${ctx.sourcePath}::${section.lineStart}` : null;

		this.controller = new AnnotationController({
			toolState,
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

		// Width comes from the note's own column width; the stored size sets
		// the proportions and the canvas's backing resolution. Pointer input
		// is mapped through that backing scale (see annotate/pointer.ts), so
		// a block drawn on a phone and reopened on a desktop still puts every
		// stroke where it was drawn.
		surface.setCssProps({ '--inkling-block-aspect': `${this.data.width} / ${this.data.height}` });
		this.controller.mountPage(BLOCK_PAGE, content, this.data.width, this.data.height);
		this.controller.seedPage(BLOCK_PAGE, this.data.annotations);

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
		setIcon(toggle, 'pencil-ruler');
		if (toggle.childElementCount === 0) toggle.setText('Tools');
		setTooltip(toggle, 'Show drawing tools');
		toggle.setAttribute('aria-label', 'Show drawing tools');
		// Stated up front rather than left to setOpen below, which no-ops
		// when asked for the state it's already in: a collapsed toggle still
		// has to announce itself as collapsed, not as un-expandable.
		toggle.setAttribute('aria-expanded', 'false');

		const setOpen = (open: boolean) => {
			if (open === (this.disposeToolbar !== null)) return;
			if (open) {
				// Built on demand, not for every block on screen: a note can
				// hold many of these, and a full tool strip apiece would crowd
				// out the writing they're meant to sit alongside. Drawing works
				// without it, using whatever tool is currently selected.
				this.disposeToolbar = buildToolbar(this.toolbarHost, this.controller);
			} else {
				this.disposeToolbar?.();
				this.disposeToolbar = null;
			}
			toggle.toggleClass('is-active', open);
			toggle.setAttribute('aria-expanded', String(open));
		};

		toggle.addEventListener('click', () => {
			const open = this.disposeToolbar === null;
			setOpen(open);
			// Recorded only on a real click. A strip that came and went with a
			// re-render must not count as the user having opened or closed
			// anything.
			if (this.stripKey === null) return;
			if (open) openToolStrips.add(this.stripKey);
			else openToolStrips.delete(this.stripKey);
		});

		setOpen(this.stripKey !== null && openToolStrips.has(this.stripKey));
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
		this.controller.resizePage(BLOCK_PAGE, this.data.width, clamped, this.controller.getPageAnnotations(BLOCK_PAGE));
	}

	private buildResizeHandle(): void {
		const handle = this.containerEl.createDiv({ cls: 'inkling-ink-block-handle' });
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
			const scale = cssWidth > 0 ? this.data.width / cssWidth : 1;
			pendingHeight = drag.startHeight + (event.clientY - drag.startY) * scale;
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

		this.data = { ...this.data, annotations: this.controller.getPageAnnotations(BLOCK_PAGE) };
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
			const lineCount = editor.lineCount();
			const lines: string[] = [];
			for (let line = 0; line < lineCount; line++) lines.push(editor.getLine(line));

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

	// Where this block’s fence actually is in `lines`.
	//
	// By id first, because that answers the question directly. Obsidian’s
	// getSectionInfo is a report of where a block is, and in a note holding
	// several it is a report that can be wrong — which is how one block’s
	// drawing was written into another’s, and how refusing that write then
	// lost the drawing instead.
	//
	// getSectionInfo is still the fallback, for the one case an id search
	// cannot answer: a block that has never been saved, and so carries no id
	// in the file yet. There it is checked against the exact text this view
	// rendered from before anything is written.
	private locate(lines: readonly string[]): { lineStart: number; lineEnd: number } | null {
		const byId = findInkBlockById(lines, this.blockId);
		if (byId) return byId;

		const section = this.ctx.getSectionInfo(this.containerEl);
		if (!section) return null;
		if (section.lineEnd >= lines.length) return null;
		if (!this.matchesThisBlock(section.lineStart, section.lineEnd, (line) => lines[line])) return null;
		return { lineStart: section.lineStart, lineEnd: section.lineEnd };
	}

	// Confirms the lines about to be replaced really are *this* block's
	// fence, so a stale or mistaken position can never put one block's
	// drawing over another's, or over the user's prose.
	//
	// Checking the shape — an opening ```inkling and a closing ``` — is not
	// enough, and that was the bug: every ink block in a note has exactly
	// that shape, so when Obsidian's getSectionInfo handed a block the line
	// range of a *different* one (which it does in a note holding several),
	// the write sailed through and the drawing from one block turned up
	// duplicated in the one below it. Identity has to be checked, not just
	// kind.
	private matchesThisBlock(lineStart: number, lineEnd: number, lineAt: (line: number) => string | undefined): boolean {
		if (lineEnd <= lineStart) return false;
		const opening = lineAt(lineStart);
		const closing = lineAt(lineEnd);
		if (opening === undefined || closing === undefined) return false;
		if (!opening.trimStart().startsWith('```') || !opening.includes(INK_BLOCK_LANGUAGE)) return false;
		if (!closing.trimStart().startsWith('```')) return false;

		const body: string[] = [];
		for (let line = lineStart + 1; line < lineEnd; line++) {
			const text = lineAt(line);
			if (text === undefined) return false;
			body.push(text);
		}
		const source = body.join('\n');

		const id = readInkBlockId(source);
		if (id !== null) return id === this.blockId;
		// No id in that fence: a block from before ids existed, or one this
		// view has not yet stamped. Matching the exact text this view
		// rendered from is as specific as the older format allows, and it
		// still separates a block with ink in it from an empty neighbour.
		return source.trim() === this.renderedSource;
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
	private findOpenEditor() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === this.ctx.sourcePath) return view.editor;
		}
		return null;
	}

	detach(): void {
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
			// itself apart at save time. See InkBlockView.matchesThisBlock.
			// Trailing newline so the cursor ends up on a fresh line after
			// the block rather than inside the fence.
			editor.replaceSelection(`${inkBlockMarkdown({ ...emptyInkBlock(), id: createId() })}\n`);
		},
	});
}
