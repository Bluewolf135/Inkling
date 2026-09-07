import { AnnotationController } from '../../src/annotate/controller';
import type { Annotation, Point } from '../../src/annotate/types';

// A drawing surface that runs outside Obsidian, so the wiring between the
// controller, the pointer layer and the renderer can be tested.
//
// Every bug that cost real work on 2026-09-06 shared a shape: correct logic
// wired to something that quietly ignored it — an IntersectionObserver
// rooted at the viewport, an editor write into a buffer nothing persists, a
// `hidden` attribute an author rule outranks. None threw, and all of them
// passed a suite that tests pure functions thoroughly. What the suite could
// not do was mount anything and watch what happened.
//
// This is deliberately small. The controller path — controller, pointer,
// render, store, eraser, geometry, stroke — imports nothing from the
// Obsidian API at all; the only thing it borrows is `createEl`. So the gap
// between "runs in a test" and "runs in the app" is a canvas, a Path2D, a
// PointerEvent and one DOM helper, all faked here.

interface DrawCall {
	op: string;
	args: unknown[];
}

interface FakeContext {
	canvas: { width: number; height: number };
	calls: DrawCall[];
}

// Every method render.ts reaches for. Recorded rather than executed: the
// question these tests ask is "what was the renderer asked to draw", which
// pixels would only obscure.
const CONTEXT_METHODS = [
	'save',
	'restore',
	'clearRect',
	'beginPath',
	'closePath',
	'moveTo',
	'lineTo',
	'quadraticCurveTo',
	'bezierCurveTo',
	'arc',
	'ellipse',
	'rect',
	'fill',
	'stroke',
	'fillRect',
	'strokeRect',
	'setLineDash',
	'setTransform',
	'translate',
	'scale',
] as const;

function makeContext(canvas: HTMLCanvasElement): FakeContext {
	const calls: DrawCall[] = [];
	const ctx = { canvas, calls } as unknown as FakeContext & Record<string, unknown>;
	for (const op of CONTEXT_METHODS) {
		ctx[op] = (...args: unknown[]) => {
			calls.push({ op, args });
		};
	}
	return ctx;
}

class FakePath2D {
	readonly calls: DrawCall[] = [];
	moveTo(...args: unknown[]): void {
		this.calls.push({ op: 'moveTo', args });
	}
	lineTo(...args: unknown[]): void {
		this.calls.push({ op: 'lineTo', args });
	}
	quadraticCurveTo(...args: unknown[]): void {
		this.calls.push({ op: 'quadraticCurveTo', args });
	}
	closePath(): void {
		this.calls.push({ op: 'closePath', args: [] });
	}
}

export interface PointerOptions {
	pointerId?: number;
	pointerType?: string;
	pressure?: number;
	isPrimary?: boolean;
}

class FakePointerEvent extends Event {
	pointerId: number;
	pointerType: string;
	pressure: number;
	isPrimary: boolean;
	width = 1;
	height = 1;
	clientX: number;
	clientY: number;

	constructor(type: string, init: PointerOptions & { clientX: number; clientY: number }) {
		super(type, { bubbles: true, cancelable: true });
		this.pointerId = init.pointerId ?? 1;
		this.pointerType = init.pointerType ?? 'pen';
		this.pressure = init.pressure ?? 0.5;
		this.isPrimary = init.isPrimary ?? true;
		this.clientX = init.clientX;
		this.clientY = init.clientY;
	}
}

// Installs everything the controller path expects a browser to have and
// jsdom does not. Idempotent, so a test file can call it once at the top.
export function installSurfaceStubs(): void {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: Element, tag: string, info?: { cls?: string }): HTMLElement {
			const child = this.ownerDocument.createElement(tag);
			if (info?.cls) child.className = info.cls;
			this.appendChild(child);
			return child;
		};
	}

	const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
	canvasProto.getContext = function (this: HTMLCanvasElement): FakeContext {
		const held = this as unknown as { __ctx?: FakeContext };
		// Cached the way a real canvas caches it, because whether a context
		// has been acquired *at all* is one of the things worth asserting:
		// an overlay is only meant to allocate one once something needs
		// drawing on it.
		held.__ctx ??= makeContext(this);
		return held.__ctx;
	};

	const scope = globalThis as unknown as Record<string, unknown>;
	scope.Path2D ??= FakePath2D;
	scope.PointerEvent ??= FakePointerEvent;

	// Synchronous, so a test never has to wait a frame to see the result of
	// a gesture. The controller batches overlay repaints into one per frame.
	scope.requestAnimationFrame = (cb: FrameRequestCallback): number => {
		cb(performance.now());
		return 0;
	};
	scope.cancelAnimationFrame = (): void => undefined;
}

export interface TestSurface {
	controller: AnnotationController;
	host: HTMLElement;
	width: number;
	height: number;
	annotations(): Annotation[];
	/** Whether the overlay canvas has had a 2D context taken from it yet. */
	overlayAcquired(): boolean;
	baseCalls(): DrawCall[];
	pointer(type: string, x: number, y: number, options?: PointerOptions): void;
	/** A complete pen gesture: down, moves, up. */
	drawStroke(points: Array<[number, number]>, options?: PointerOptions): void;
}

const PAGE = 1;

export function mountTestSurface(width = 800, height = 450): TestSurface {
	installSurfaceStubs();

	const host = document.createElement('div');
	document.body.appendChild(host);

	const controller = new AnnotationController({ getCurrentPage: () => PAGE });
	// The shared default is the select tool, which suits a PDF opened to be
	// read. A surface built to be drawn on in a test wants the pen, and
	// leaving it unset is how the first run of these tests came to assert
	// against lasso gestures without noticing.
	controller.setTool('pen');
	controller.mountPage(PAGE, host, width, height);

	const canvases = host.querySelectorAll('canvas');
	const overlay = canvases[1] as HTMLCanvasElement;

	// The surface reports its displayed size as its backing size, so a test
	// works in the same units the file does and no scale is in the way.
	for (const canvas of Array.from(canvases)) {
		canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });
	}

	const target = overlay;
	const pointer = (type: string, x: number, y: number, options: PointerOptions = {}): void => {
		target.dispatchEvent(new FakePointerEvent(type, { ...options, clientX: x, clientY: y }));
	};

	return {
		controller,
		host,
		width,
		height,
		annotations: () => controller.getPageAnnotations(PAGE),
		overlayAcquired: () => (overlay as unknown as { __ctx?: unknown }).__ctx !== undefined,
		baseCalls: () => ((canvases[0] as unknown as { __ctx?: FakeContext }).__ctx?.calls ?? []),
		pointer,
		drawStroke: (points, options = {}) => {
			const [first, ...rest] = points;
			if (!first) return;
			pointer('pointerdown', first[0], first[1], options);
			for (const [x, y] of rest) pointer('pointermove', x, y, options);
			const last = points[points.length - 1] ?? first;
			pointer('pointerup', last[0], last[1], options);
		},
	};
}

export function pointsOf(annotation: Annotation | undefined): Point[] {
	return annotation && annotation.kind === 'stroke' ? annotation.points : [];
}
