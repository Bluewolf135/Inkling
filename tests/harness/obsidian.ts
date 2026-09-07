// A runtime for the `obsidian` module, which ships none.
//
// The published package is type definitions only — `"main": ""` — so any
// source file importing from it simply cannot be loaded under vitest. That
// is the whole reason the integration harness stopped at the controller:
// everything above it (inkBlock.ts, pdfView.ts, main.ts) imports the
// Obsidian API, and the controller path was tested precisely because it was
// the largest slice that does not.
//
// vitest.config.ts aliases `obsidian` here. Typechecking is unaffected:
// tsc still resolves the real obsidian.d.ts for src/, so production code is
// held to the real API and this file only has to satisfy the parts of it
// the tests actually execute.
//
// The classes matter as much as the functions. `instanceof TFile` and
// `instanceof MarkdownView` are how inkBlock.ts decides whether it may
// write, and an identity check only works when the production code and the
// test construct the same class — which they do, because both resolve
// through this one module.

// Everything a Notice was ever used to say, in order. Tests assert on this
// rather than on a spy: a save that fails silently and a save that fails
// loudly are different bugs, and the user being *told* is the behaviour
// worth pinning.
export const notices: string[] = [];

export class Notice {
	constructor(public readonly message: string) {
		notices.push(message);
	}
	hide(): void {
		// Nothing to hide in a test; kept so production code can call it.
	}
}

export abstract class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.split('/').pop() ?? this.path;
	}
}

export class TFile extends TAbstractFile {
	get basename(): string {
		return this.name.replace(/\.[^.]+$/, '');
	}
	get extension(): string {
		return this.name.split('.').pop() ?? '';
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

// Obsidian's Component lifecycle, only as deep as a render child uses it.
// `load` is what a post-processor context calls when it adopts a child, and
// `unload` is what tearing the section down calls — the pair that decides
// whether a block's pending write gets flushed or dropped.
export class Component {
	private loaded = false;
	private readonly children: Component[] = [];

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
	}
	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of this.children.splice(0)) child.unload();
		this.onunload();
	}
	onload(): void {
		// Overridden by subclasses.
	}
	onunload(): void {
		// Overridden by subclasses.
	}
	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		child.load();
		return child;
	}
	register(_cb: () => void): void {
		// Not exercised by anything under test.
	}
	registerEvent(_ref: unknown): void {
		// Not exercised by anything under test.
	}
}

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

// The two things inkBlock.ts asks a markdown view: which file it is showing
// and whether it is in reading mode. `getMode` is the one that matters —
// returning 'preview' is how the harness reproduces the reading-view bug,
// where an editor write went into a buffer nothing persists.
export class MarkdownView {
	constructor(
		public file: TFile | null,
		public editor: unknown,
		private readonly mode: 'source' | 'preview' = 'source',
	) {}
	getMode(): 'source' | 'preview' {
		return this.mode;
	}
}

export class Plugin extends Component {}

// Recorded rather than rendered. Obsidian's own setIcon leaves an empty
// <svg> behind for a name the running build does not know, which is a blank
// button and no error — the failure that cost this plugin its block toggle
// twice on a phone. A test cannot tell a good name from a bad one, but it
// can tell that an icon was asked for at all.
export const iconRequests: { name: string; el: HTMLElement }[] = [];

export function setIcon(el: HTMLElement, name: string): void {
	iconRequests.push({ name, el });
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('data-icon', name);
	el.appendChild(svg);
}

export function setTooltip(el: HTMLElement, tooltip: string): void {
	el.setAttribute('aria-label', tooltip);
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function resetObsidianStubs(): void {
	notices.length = 0;
	iconRequests.length = 0;
}
