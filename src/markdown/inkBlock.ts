import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, Plugin, setIcon, setTooltip, TFile } from 'obsidian';
import { AnnotationController, buildToolbar, capturePointer } from '../annotate';
import {
	INK_BLOCK_LANGUAGE,
	InkBlockData,
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

// Only the block's own single drawing surface is ever mounted into a given
// controller, so the page-keyed API the controller shares with the PDF view
// (where the key is a real page number) always gets the same key here.
const BLOCK_PAGE = 1;

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

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		source: string,
	) {
		const { data, malformed } = parseInkBlock(source);
		this.data = data;

		this.controller = new AnnotationController({
			getCurrentPage: () => BLOCK_PAGE,
			onAnnotationsChanged: () => this.scheduleWrite(),
		});
		// No pages to add or remove inside a note — that's a handwritten-note
		// concept, and the toolbar hides the control when this is false.
		this.controller.setCanManagePages(false);
		// Ready to write immediately. The controller's own default is the
		// select tool, which suits the PDF view (where you often open a file
		// to read, and reach for a tool deliberately) but not a block you
		// added specifically to handwrite into — landing in select mode there
		// means a stylus does nothing at all until the toolbar is opened.
		this.controller.setTool('pen');

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
		surface.setCssProps({ '--inkling-block-aspect': `${data.width} / ${data.height}` });
		this.controller.mountPage(BLOCK_PAGE, content, data.width, data.height);
		this.controller.seedPage(BLOCK_PAGE, data.annotations);

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
		toggle.setAttribute('aria-expanded', 'false');
		toggle.addEventListener('click', () => {
			if (this.disposeToolbar) {
				this.disposeToolbar();
				this.disposeToolbar = null;
				toggle.removeClass('is-active');
				toggle.setAttribute('aria-expanded', 'false');
				return;
			}
			// Built on demand, not for every block on screen: a note can hold
			// many of these, and a full tool strip apiece would crowd out the
			// writing they're meant to sit alongside. Drawing works without
			// it, using whatever tool this block was last set to.
			this.disposeToolbar = buildToolbar(this.toolbarHost, this.controller);
			toggle.addClass('is-active');
			toggle.setAttribute('aria-expanded', 'true');
		});
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

		// Re-read the block's position at save time rather than trusting
		// where it was when this rendered: the note is live, and text above
		// may well have changed length since.
		const section = this.ctx.getSectionInfo(this.containerEl);
		if (!section) return;

		this.data = { ...this.data, annotations: this.controller.getPageAnnotations(BLOCK_PAGE) };
		const serialized = serializeInkBlock(this.data);

		const editor = this.findOpenEditor();
		if (editor) {
			// Through the editor, not the file, whenever the note is open:
			// this lands as an ordinary edit in the same document the user is
			// working in — one undo step, no external-modification reload,
			// and no fight with unsaved changes the editor hasn't flushed to
			// disk yet.
			if (!this.isBlockAt(section.lineStart, section.lineEnd, (line) => editor.getLine(line))) return;
			editor.replaceRange(
				`${serialized}\n`,
				{ line: section.lineStart + 1, ch: 0 },
				{ line: section.lineEnd, ch: 0 },
			);
			return;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		try {
			await this.plugin.app.vault.process(file, (contents) => {
				const lines = contents.split('\n');
				if (section.lineEnd >= lines.length) return contents;
				if (!this.isBlockAt(section.lineStart, section.lineEnd, (line) => lines[line])) return contents;
				lines.splice(section.lineStart + 1, section.lineEnd - section.lineStart - 1, serialized);
				return lines.join('\n');
			});
		} catch (error) {
			console.error('Inkling: failed to save an ink block.', error);
			new Notice('Inkling: could not save this ink block.');
		}
	}

	// Confirms the lines about to be replaced really are this block's fence,
	// so a stale position can never put stroke data over the user's prose.
	private isBlockAt(lineStart: number, lineEnd: number, lineAt: (line: number) => string | undefined): boolean {
		if (lineEnd <= lineStart) return false;
		const opening = lineAt(lineStart);
		const closing = lineAt(lineEnd);
		return (
			opening !== undefined &&
			closing !== undefined &&
			opening.trimStart().startsWith('```') &&
			opening.includes(INK_BLOCK_LANGUAGE) &&
			closing.trimStart().startsWith('```')
		);
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
		this.controller.unmountAll();
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

export function registerInkBlock(plugin: Plugin): void {
	plugin.registerMarkdownCodeBlockProcessor(INK_BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(new InkBlockChild(el, () => new InkBlockView(plugin, ctx, el, source)));
	});

	plugin.addCommand({
		id: 'insert-ink-block',
		name: 'Insert ink annotation block',
		// Command palette only, per the plan — no ribbon icon, so it's
		// reachable the same way on desktop and mobile.
		editorCallback: (editor) => {
			// Trailing newline so the cursor ends up on a fresh line after
			// the block rather than inside the fence.
			editor.replaceSelection(`${inkBlockMarkdown(emptyInkBlock())}\n`);
		},
	});
}
