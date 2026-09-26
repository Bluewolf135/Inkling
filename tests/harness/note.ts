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
import { parseInkFile, readInkFileBlock } from '../../src/markdown/inkFile';
import { inkFileName } from '../../src/markdown/inkFilePath';
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
	/**
	 * The same, but announced — what a real vault does when a file changes
	 * on disk. `setContents` models an edit nothing told the plugin about;
	 * this models one it was told about, which is the only way a block can
	 * revisit a decision it made when it rendered.
	 */
	sync(next: string): Promise<void>;
	/** Let every ink file store finish what it has queued, and the promises after it. */
	settle(): Promise<void>;
	/** Runs "Insert ink annotation block" in this note's editor, and lets it settle. */
	runInsertCommand(): Promise<void>;
	/** An ink file's text, or undefined when there is none. */
	inkFile(path: string): string | undefined;
	/** Change an ink file behind the plugin's back. */
	setInkFile(path: string, text: string): void;
	/** Change an ink file and announce it, as a sync landing would. */
	syncInkFile(path: string, text: string): Promise<void>;
	/** Delete an ink file and announce it. */
	deleteInkFile(path: string): Promise<void>;
	/**
	 * Runs at the start of every write to an ink file until cleared with null
	 * — a sync landing mid-save when it changes the file, a failing disk when
	 * it throws.
	 */
	interceptInkWrites(hook: ((path: string) => void) | null): void;
	/** Stroke annotations in one block of an ink file, or -1 when it cannot be read. */
	inkStrokeCount(path: string, id: string): Promise<number>;
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
	/**
	 * The plugin setting that decides whether a block offers a caption to
	 * write. Off by default, which is how the plugin ships.
	 */
	blockCaptions?: boolean;
	/** Ink files in the vault beside the note, by path. */
	inkFiles?: Record<string, string>;
	/** Where the insert command puts a new block's ink file. Defaults to Ink/<note>.ink. */
	inkFilePathFor?: (notePath: string) => string;
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
	const inkFiles = new Map(Object.entries(options.inkFiles ?? {}));
	let inkWriteHook: ((path: string) => void) | null = null;

	// Vault events, only as far as anything under test listens to them.
	// A block that could not be read watches for its own note changing, so
	// that a banner cannot outlive the damage that caused it — which is
	// exactly what happened after a sync conflict resolved itself.
	type VaultListener = { event: string; cb: (file: TFile) => void };
	const listeners: VaultListener[] = [];

	const fire = (event: string, target: TFile): void => {
		for (const listener of [...listeners]) {
			if (listener.event === event) listener.cb(target);
		}
	};

	const vault = {
		getAbstractFileByPath: (wanted: string) => (wanted === path ? file : null),
		getFileByPath: (wanted: string) => (wanted === path ? file : inkFiles.has(wanted) ? new TFile(wanted) : null),
		// Every folder exists. Nothing under test depends on creating one.
		getFolderByPath: (wanted: string) => ({ path: wanted }),
		createFolder: async () => undefined,
		read: async (target: TFile) => {
			if (target.path === path) return contents;
			const text = inkFiles.get(target.path);
			if (text === undefined) throw new Error(`no such file: ${target.path}`);
			return text;
		},
		create: async (target: string, data: string) => {
			if (target === path || inkFiles.has(target)) throw new Error(`file already exists: ${target}`);
			inkFiles.set(target, data);
			const created = new TFile(target);
			fire('create', created);
			return created;
		},
		process: async (target: TFile, fn: (data: string) => string) => {
			if (target.path === path) {
				contents = fn(contents);
				return contents;
			}
			inkWriteHook?.(target.path);
			const current = inkFiles.get(target.path);
			if (current === undefined) throw new Error(`no such file: ${target.path}`);
			const next = fn(current);
			if (next !== current) {
				inkFiles.set(target.path, next);
				// Obsidian reports the plugin's own writes back to it, and the
				// store has to cope with hearing about them. The note's own
				// writes are not reported, as before this harness held ink files.
				fire('modify', target);
			}
			return next;
		},
		cachedRead: async (target: TFile) => {
			if (target.path !== path) throw new Error(`no such file: ${target.path}`);
			return contents;
		},
		adapter: {
			stat: async (wanted: string) => {
				const text = wanted === path ? contents : inkFiles.get(wanted);
				return text === undefined ? null : { type: 'file', ctime: 0, mtime: 0, size: new TextEncoder().encode(text).length };
			},
		},
		on: (event: string, cb: (file: TFile) => void): VaultListener => {
			const ref = { event, cb };
			listeners.push(ref);
			return ref;
		},
		offref: (ref: VaultListener) => {
			const at = listeners.indexOf(ref);
			if (at >= 0) listeners.splice(at, 1);
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
			to: { line: number; ch: number } = from,
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
		// Where replaceSelection writes: the end of the note.
		getCursor: () => {
			const lines = contents.split('\n');
			return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
		},
	};

	const leaves: FakeLeaf[] = options.openInEditor
		? [{ view: new MarkdownView(file, editor, mode) }]
		: [];

	let processor: BlockProcessor | null = null;
	const commands = new Map<string, { id: string; editorCallback?: (editor: unknown, ctx: unknown) => void }>();
	const plugin = {
		app: {
			vault,
			workspace: { getLeavesOfType: (type: string) => (type === 'markdown' ? leaves : []) },
		},
		registerMarkdownCodeBlockProcessor: (_language: string, cb: BlockProcessor) => {
			processor = cb;
		},
		addCommand: (command: { id: string; editorCallback?: (editor: unknown, ctx: unknown) => void }) => {
			commands.set(command.id, command);
		},
		registerEvent: () => undefined,
	};

	const toolState = new ToolState();
	toolState.setTool(options.tool ?? 'pen');
	const registration = registerInkBlock(plugin as unknown as Plugin, toolState, {
		captionsEnabled: () => options.blockCaptions ?? false,
		inkFilePathFor: (notePath) => Promise.resolve(options.inkFilePathFor ? options.inkFilePathFor(notePath) : `Ink/${inkFileName(notePath)}`),
	});
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

	// Ink file work runs on real streams (deflate is not a timer), so it is
	// awaited rather than advanced past, a few rounds deep because a store
	// settling can start a block saving.
	const settle = async (): Promise<void> => {
		for (let round = 0; round < 5; round++) {
			await registration.whenIdle();
			await vi.advanceTimersByTimeAsync(0);
		}
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
			await settle();
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
		sync: async (next: string) => {
			contents = next;
			fire('modify', file);
			// Reading a file is asynchronous, so a listener has not finished
			// reacting by the time it returns. Settled here rather than in
			// every test that changes a file.
			await vi.advanceTimersByTimeAsync(0);
		},
		settle,
		runInsertCommand: async () => {
			const insert = commands.get('insert-ink-block')?.editorCallback;
			if (!insert) throw new Error('registerInkBlock did not register the insert command');
			insert(editor, { file });
			await settle();
		},
		inkFile: (inkPath) => inkFiles.get(inkPath),
		setInkFile: (inkPath, text) => {
			inkFiles.set(inkPath, text);
		},
		syncInkFile: async (inkPath, text) => {
			const existed = inkFiles.has(inkPath);
			inkFiles.set(inkPath, text);
			fire(existed ? 'modify' : 'create', new TFile(inkPath));
			await settle();
		},
		deleteInkFile: async (inkPath) => {
			inkFiles.delete(inkPath);
			fire('delete', new TFile(inkPath));
			await settle();
		},
		interceptInkWrites: (hook) => {
			inkWriteHook = hook;
		},
		inkStrokeCount: async (inkPath, id) => {
			const read = parseInkFile(inkFiles.get(inkPath) ?? '');
			if (read.kind !== 'readable') return -1;
			const block = await readInkFileBlock(read.contents.blocks.get(id));
			return block.kind === 'decoded' ? block.block.annotations.filter((a) => a.kind === 'stroke').length : -1;
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
