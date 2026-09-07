import { vi } from 'vitest';
import { MarkdownView, TFile, notices, resetObsidianStubs } from './obsidian';
import { installSurfaceStubs, makePointerEvent, type PointerOptions } from './surface';
import { registerInkBlock } from '../../src/markdown/inkBlock';
import {
	INK_BLOCK_LANGUAGE,
	emptyInkBlock,
	inkBlockMarkdown,
	parseInkBlock,
} from '../../src/markdown/inkBlockFormat';
import { ToolState } from '../../src/annotate/toolState';
import type { ToolType } from '../../src/annotate/types';
import type { Plugin } from 'obsidian';

// A note full of live ink blocks, running outside Obsidian.
//
// surface.ts covers the controller — a stroke reaching the store. This
// covers everything above it: a stroke reaching the *file*. Both bugs that
// lost real work lived in that gap, and neither could be seen from below.
//
// The vault, the workspace and the editor here are all backed by one string
// of note contents, so a test can draw and then read what would be on disk.

// How long inkBlock.ts waits before writing (WRITE_DEBOUNCE_MS), plus room
// for the async write itself to settle.
const WRITE_SETTLE_MS = 900;

interface FakeLeaf {
	view: unknown;
}

// The block bodies a note's ```inkling fences hold, in order.
function fenceBodies(contents: string): string[] {
	const lines = contents.split('\n');
	const bodies: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trimStart() ?? '';
		if (!line.startsWith('```') || !line.includes(INK_BLOCK_LANGUAGE)) continue;
		let close = index + 1;
		while (close < lines.length && !(lines[close]?.trimStart() ?? '').startsWith('```')) close++;
		bodies.push(lines.slice(index + 1, close).join('\n'));
		index = close;
	}
	return bodies;
}

export interface MountedBlock {
	el: HTMLElement;
	/** Whether this block currently has its drawing canvases attached. */
	isMounted(): boolean;
	/** Report this block visible, as an IntersectionObserver eventually would. */
	reveal(): void;
	/**
	 * Clicks the block's pencil toggle, which is the only thing that opens
	 * a block to ink — a block nobody has asked to edit refuses it, so that
	 * a pen passing over a note cannot leave a stray mark. Clicked rather
	 * than reached past, because the wiring between the button and the
	 * controller's read-only flag is exactly what this harness is for.
	 */
	openForEditing(): void;
	/** Whether this block's surface currently accepts ink. */
	isOpenForEditing(): boolean;
	/** A complete pen gesture on this block's surface: down, moves, up. */
	drawStroke(points: Array<[number, number]>, options?: PointerOptions): void;
	/** One pointer event, for gestures a test needs to inspect midway. */
	pointer(type: string, x: number, y: number, options?: PointerOptions): void;
}

export interface TestNote {
	path: string;
	/** The note as it would be on disk right now. */
	contents(): string;
	/** The JSON body of the nth ```inkling fence. */
	fenceBody(index: number): string;
	/** Stroke annotations stored in the nth fence — what a reload would see. */
	strokeCountIn(index: number): number;
	block(index: number): MountedBlock;
	blockCount(): number;
	/** Run the debounced write and let it settle. */
	flushWrites(): Promise<void>;
	/** Advance the plugin's timers, for retries that outlast a write. */
	advance(ms: number): Promise<void>;
	/** Tear the rendered section down, as scrolling away or closing does. */
	unmount(): void;
	/** Re-run the post-processor over the note's current contents. */
	rerender(): void;
	/** Edit the file behind the plugin's back, as sync or the user would. */
	setContents(next: string): void;
	/** Saves that went into the editor while it was in reading view. */
	discardedEditorWrites(): number;
	/** How many times the save path read the note one line at a time. */
	getLineCalls(): number;
	/** Everything the plugin has told the user, in order. */
	notices(): readonly string[];
}

export interface MountNoteOptions {
	path?: string;
	/**
	 * One entry per ink block. `id` is stamped into the fence; omitting it
	 * produces a block with no id, which is how blocks written before ids
	 * existed behave — and how two empty blocks become indistinguishable.
	 */
	blocks?: { id?: string }[];
	/** Full note text, if the default (blocks separated by prose) won't do. */
	contents?: string;
	/** Whether a markdown view is open on this note. */
	openInEditor?: boolean;
	/** Reading view reports 'preview'; Live Preview and source both report 'source'. */
	mode?: 'source' | 'preview';
	/**
	 * Whether an IntersectionObserver reports back before the test looks.
	 *
	 * A real one never does: its callback is delivered after layout, on a
	 * later frame. The default here fires immediately because most tests only
	 * want a mounted surface to draw on, but a block being rebuilt after its
	 * own save is precisely the case where that frame is visible to the user,
	 * so it has to be possible to model the wait.
	 */
	deferIntersection?: boolean;
	/**
	 * The plugin-wide tool. Defaults to the pen: the shared default is
	 * 'select', which suits a PDF opened to be read, and a surface built to
	 * be drawn on in a test wants a pen — leaving it unset is how the first
	 * run of the surface tests came to assert against lasso gestures.
	 */
	tool?: ToolType;
	blockWidth?: number;
	blockHeight?: number;
}

function defaultContents(blocks: { id?: string }[], width: number, height: number): string {
	const parts = ['# Notes', ''];
	blocks.forEach((block, index) => {
		parts.push(`Paragraph ${index + 1}.`, '');
		parts.push(inkBlockMarkdown({ ...emptyInkBlock(), ...(block.id ? { id: block.id } : {}), width, height }), '');
	});
	return parts.join('\n');
}

export function mountNote(options: MountNoteOptions = {}): TestNote {
	installSurfaceStubs();
	installNoteStubs(options.deferIntersection ?? false);
	resetObsidianStubs();

	// Only the timers inkBlock.ts schedules writes on. Leaving
	// requestAnimationFrame and performance alone matters: the surface stubs
	// make rAF synchronous so a gesture resolves within the call that made
	// it, and faking it here would undo that.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

	const path = options.path ?? 'Note.md';
	const width = options.blockWidth ?? 800;
	const height = options.blockHeight ?? 450;
	const blocks = options.blocks ?? [{ id: 'ink-only' }];

	let contents = options.contents ?? defaultContents(blocks, width, height);
	// Writes that reached the editor while it was in reading view, and so
	// went nowhere. Any number above zero is the bug.
	let discardedEditorWrites = 0;
	let getLineCalls = 0;
	const file = new TFile(path);

	const vault = {
		getAbstractFileByPath: (wanted: string) => (wanted === path ? file : null),
		process: async (target: TFile, fn: (data: string) => string) => {
			if (target.path !== path) throw new Error(`no such file: ${target.path}`);
			contents = fn(contents);
			return contents;
		},
	};

	type BlockProcessor = (source: string, el: HTMLElement, ctx: unknown) => void;

	const mode = options.mode ?? 'source';

	// An editor over the same string the vault holds, so the two write paths
	// cannot silently disagree about what the note says.
	//
	// Except in reading view, where it deliberately throws the write away.
	// That is not the harness being unhelpful — it is what Obsidian does,
	// and modelling it is the entire point: a block saved from reading view
	// went through the editor into a buffer nothing persists, the save
	// counted itself a success, cleared the recovery entry, and the next
	// re-render took the drawing with it. An editor stub that accepted the
	// write would make that bug invisible here, exactly as it was in the app.
	const editor = {
		lineCount: () => contents.split('\n').length,
		// Counted, because reading a note one line at a time is a real cost
		// that grew 19-fold when stored JSON started wrapping, and it is
		// exactly the kind of regression that comes back silently.
		getLine: (line: number) => {
			getLineCalls += 1;
			return contents.split('\n')[line] ?? '';
		},
		getValue: () => contents,
		replaceRange: (
			text: string,
			from: { line: number; ch: number },
			to: { line: number; ch: number },
		) => {
			const lines = contents.split('\n');
			const offsetOf = (position: { line: number; ch: number }): number => {
				let offset = 0;
				for (let index = 0; index < position.line && index < lines.length; index++) {
					offset += (lines[index]?.length ?? 0) + 1;
				}
				return offset + position.ch;
			};
			if (mode === 'preview') {
				discardedEditorWrites += 1;
				return;
			}
			const start = offsetOf(from);
			const end = offsetOf(to);
			contents = contents.slice(0, start) + text + contents.slice(end);
		},
		replaceSelection: (text: string) => {
			contents += text;
		},
	};

	const leaves: FakeLeaf[] = options.openInEditor
		? [{ view: new MarkdownView(file, editor, mode) }]
		: [];

	let processor: BlockProcessor | null = null;
	const plugin = {
		app: {
			vault,
			workspace: { getLeavesOfType: (type: string) => (type === 'markdown' ? leaves : []) },
		},
		registerMarkdownCodeBlockProcessor: (_language: string, cb: BlockProcessor) => {
			processor = cb;
		},
		addCommand: () => undefined,
	};

	const toolState = new ToolState();
	toolState.setTool(options.tool ?? 'pen');
	registerInkBlock(plugin as unknown as Plugin, toolState);
	// Read back through a closure. The only assignment TypeScript can see in
	// straight-line code is the `null` above — the one that matters happens
	// inside a callback handed to production code — so reading it directly
	// narrows to `never`. Inside a function the captured variable starts from
	// its declared type again, which is both true and what we want.
	const run = ((): BlockProcessor => {
		if (!processor) throw new Error('registerInkBlock did not register a code block processor');
		return processor;
	})();

	// A scrolling ancestor, because that is what findScrollParent looks for
	// and what an IntersectionObserver's root has to be.
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.overflowY = 'auto';
	document.body.appendChild(scroller);

	let children: { unload: () => void }[] = [];
	let mounted: MountedBlock[] = [];

	const render = (): void => {
		for (const child of children) child.unload();
		children = [];
		mounted = [];
		scroller.replaceChildren();

		fenceBodies(contents).forEach((body) => {
			const el = document.createElement('div');
			scroller.appendChild(el);
			const ctx = {
				sourcePath: path,
				addChild: (child: { load: () => void; unload: () => void }) => {
					children.push(child);
					child.load();
				},
			};
			run(body, el, ctx);
			mounted.push(makeMountedBlock(el, width, height));
		});
	};

	render();

	const block = (index: number): MountedBlock => {
		const found = mounted[index];
		if (!found) throw new Error(`no ink block at index ${index}; the note rendered ${mounted.length}`);
		return found;
	};

	return {
		path,
		contents: () => contents,
		fenceBody: (index) => fenceBodies(contents)[index] ?? '',
		strokeCountIn: (index) => {
			const body = fenceBodies(contents)[index] ?? '';
			return parseInkBlock(body).data.annotations.filter((a) => a.kind === 'stroke').length;
		},
		block,
		blockCount: () => mounted.length,
		flushWrites: async () => {
			await vi.advanceTimersByTimeAsync(WRITE_SETTLE_MS);
		},
		advance: async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
		},
		unmount: () => {
			for (const child of children) child.unload();
			children = [];
		},
		rerender: render,
		setContents: (next: string) => {
			contents = next;
		},
		discardedEditorWrites: () => discardedEditorWrites,
		getLineCalls: () => getLineCalls,
		notices: () => notices,
	};
}

function makeMountedBlock(el: HTMLElement, width: number, height: number): MountedBlock {
	let canvases: HTMLCanvasElement[] = [];
	let overlay: HTMLCanvasElement | undefined;

	// Re-read the canvases, which do not exist until the block mounts.
	const refresh = (): void => {
		canvases = Array.from(el.querySelectorAll('canvas'));
		sizeCanvases();
		overlay = canvases[1];
	};

	const sizeCanvases = (): void => {
		// The surface reports its displayed size as its backing size, so a test
		// works in stored units and no scale sits in the way.
		for (const canvas of canvases) {
			canvas.getBoundingClientRect = () => ({
				x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
			});
		}
	};

	refresh();
	const toggle = el.querySelector<HTMLButtonElement>('.inkling-ink-block-toggle');

	const pointer = (type: string, x: number, y: number, opts: PointerOptions = {}): void => {
		if (!overlay) throw new Error('this ink block has no drawing surface mounted');
		overlay.dispatchEvent(makePointerEvent(type, { ...opts, clientX: x, clientY: y }));
	};

	return {
		el,
		isMounted: () => el.querySelectorAll('canvas').length > 0,
		reveal: () => {
			revealElement(el);
			refresh();
		},
		pointer,
		openForEditing: () => {
			if (!toggle) throw new Error('this ink block rendered no edit toggle');
			if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
		},
		isOpenForEditing: () => toggle?.getAttribute('aria-expanded') === 'true',
		drawStroke: (points, opts = {}) => {
			const [first, ...rest] = points;
			if (!first) return;
			pointer('pointerdown', first[0], first[1], opts);
			for (const [x, y] of rest) pointer('pointermove', x, y, opts);
			const last = points[points.length - 1] ?? first;
			pointer('pointerup', last[0], last[1], opts);
		},
	};
}

let deferIntersection = false;

// Every live observer, so a test can report a block visible at the moment it
// chooses rather than only at the moment it was observed.
const observed: { callback: (entries: { isIntersecting: boolean; target: Element }[]) => void; target: Element }[] = [];

function revealElement(el: Element): void {
	for (const entry of observed) {
		if (entry.target === el || el.contains(entry.target)) {
			entry.callback([{ isIntersecting: true, target: entry.target }]);
		}
	}
}

// jsdom has no IntersectionObserver, and inkBlock.ts will not mount a
// block's canvases without one. Reporting an immediate intersection is the
// right default: a test that has gone to the trouble of mounting a note is
// asking about a block on screen.
function installNoteStubs(defer: boolean): void {
	const scope = globalThis as unknown as Record<string, unknown>;
	deferIntersection = defer;
	if (scope.IntersectionObserver) return;

	class StubIntersectionObserver {
		constructor(private readonly callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
		observe(target: Element): void {
			observed.push({ callback: this.callback, target });
			// A real observer delivers this after layout, on a later frame.
			if (deferIntersection) return;
			this.callback([{ isIntersecting: true, target }]);
		}
		unobserve(): void {
			// Nothing held to release.
		}
		disconnect(): void {
			for (let i = observed.length - 1; i >= 0; i--) {
				if (observed[i]?.callback === this.callback) observed.splice(i, 1);
			}
		}
		takeRecords(): [] {
			return [];
		}
	}
	scope.IntersectionObserver = StubIntersectionObserver;
}
