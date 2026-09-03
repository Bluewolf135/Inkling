import { Point } from './types';

export interface GestureHandlers {
	onStart(point: Point, event: PointerEvent): void;
	onMove(point: Point, event: PointerEvent): void;
	onEnd(point: Point, event: PointerEvent): void;
	onCancel(event: PointerEvent): void;
	// Fired on every pen/mouse pointermove — hovering or mid-gesture alike —
	// plus once with `null` when the pointer leaves the canvas. Lets a tool
	// (the eraser's outline, currently) track where the pointer is without
	// needing an active gesture. Optional since most tools don't care.
	onHover?(point: Point | null): void;
	// Fired on every pinch-zoom move, and once more at the end — lets a live
	// zoom-level indicator (the toolbar's) stay current throughout the
	// gesture, not just once it settles.
	onZoomChange?(scale: number): void;
	// Fired once when a pinch-zoom gesture ends (never mid-pinch — a
	// zoom-triggered PDF re-render is real work, so it only ever happens
	// once the user's fingers actually settle), with the page's current
	// zoom scale. Lets the PDF-specific view re-render that page at a
	// matching resolution so it — and the ink on it — stay sharp instead of
	// just being a blown-up copy of the original lower-resolution render.
	onZoomEnd?(scale: number): void;
}

// A real stylus tip's contact patch is a couple of CSS pixels at most; a
// palm or a knuckle resting on the glass is tens of pixels wide. Some
// Android vendors/WebViews misreport an accidental palm touch as
// `pointerType: 'pen'` instead of `'touch'` (a known real-world gap in an
// otherwise spec-following stack — see the plan's Architecture notes on
// stylus behavior varying across devices), so contact-geometry size is a
// second, independent signal on top of pointerType. Devices that can't
// measure contact geometry report width/height as 1, so this only ever
// rejects an implausibly large "pen" contact, never a normal one.
const MAX_PLAUSIBLE_PEN_CONTACT_PX = 40;

// Pinch-zoom lets writing be more precise than the page's base render scale
// would otherwise allow: zooming in means the same physical pen movement
// covers fewer canvas pixels, so strokes drawn while zoomed come out finer.
// Keyed by each page's `.inkling-page-content` wrapper element (see
// pdfView.ts) rather than closed over per attachPointerGestures call, so
// zoom state survives independently of — and outlives — any single
// gesture, and each page keeps its own.
interface Zoom {
	scale: number;
	x: number;
	y: number;
}

const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const zoomState = new WeakMap<HTMLElement, Zoom>();

function getZoom(content: HTMLElement): Zoom {
	return zoomState.get(content) ?? { scale: MIN_ZOOM, x: 0, y: 0 };
}

function applyZoom(content: HTMLElement, zoom: Zoom): void {
	zoomState.set(content, zoom);
	content.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

function distance(a: Point, b: Point): number {
	return Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// However far zoomed content is panned, its edges can never be dragged
// past the viewport's own edges — otherwise panning could leave blank
// space showing on one side with no way back except zooming out again.
function clampTranslate(x: number, y: number, scale: number, width: number, height: number): Point {
	return {
		x: clamp(x, width * (1 - scale), 0),
		y: clamp(y, height * (1 - scale), 0),
	};
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
	let node = el.parentElement;
	while (node) {
		const style = getComputedStyle(node);
		if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

// Flick-to-scroll (momentum), and the constants governing how it decays.
// Touch panning here is implemented by hand rather than left to the browser
// (see attachPointerGestures' comment for why), and hand-rolled panning
// stops dead the instant a finger lifts — no glide, which is most of what
// made scrolling in edit mode feel worse than the native PDF view. These
// restore the part the browser would otherwise have done.
//
// Module scope, not per-canvas: gestures are attached per page, but a flick
// started on one page keeps scrolling across others, and *any* new touch
// anywhere has to stop it — the way tapping a scrolling page halts it
// everywhere else.
const MOMENTUM_FRICTION = 0.94; // per 16ms frame; ~1s of glide
const MOMENTUM_MIN_VELOCITY = 0.05; // px/ms — below this, stop
const MOMENTUM_START_VELOCITY = 0.15; // px/ms — a slow release just stops
// Velocity is smoothed across moves so one erratic final sample (common as
// a finger lifts) can't throw the whole flick.
const VELOCITY_SMOOTHING = 0.7;

let momentumFrame: number | null = null;

function stopMomentum(): void {
	if (momentumFrame === null) return;
	window.cancelAnimationFrame(momentumFrame);
	momentumFrame = null;
}

function startMomentum(scrollParent: HTMLElement, velocity: number): void {
	stopMomentum();
	if (Math.abs(velocity) < MOMENTUM_START_VELOCITY) return;

	let current = velocity;
	let previous = performance.now();

	const step = (now: number) => {
		momentumFrame = null;
		// Scaled by real elapsed time so the glide covers the same distance
		// whether the display runs at 60Hz or 120Hz (tablets often do).
		const elapsed = Math.min(now - previous, 64);
		previous = now;

		const before = scrollParent.scrollTop;
		scrollParent.scrollTop = before - current * elapsed;
		// Hit the top or bottom — nothing left to glide through.
		if (scrollParent.scrollTop === before) return;

		current *= Math.pow(MOMENTUM_FRICTION, elapsed / 16);
		if (Math.abs(current) < MOMENTUM_MIN_VELOCITY) return;
		momentumFrame = window.requestAnimationFrame(step);
	};

	momentumFrame = window.requestAnimationFrame(step);
}

// Palm rejection: touch pans/scrolls the page, pen and mouse draw — required
// for both Apple Pencil and S Pen. Real-device testing (Samsung S Pen) found
// that relying on native `touch-action`-driven panning for the touch side
// isn't reliable enough here: `touch-action: pan-y` doesn't just permit
// touch to pan, it authorizes the browser to recognize a vertical pan from
// *any* pointer's movement, and toggling it dynamically per-gesture still
// let a downward pen stroke get taken over mid-draw on that device. So
// `touch-action` on the canvas is `none` unconditionally (see styles.css)
// and touch panning is implemented by hand below instead of leaned on the
// browser for — full, deterministic control instead of depending on
// cross-device native-gesture-recognition timing.
export function attachPointerGestures(el: HTMLCanvasElement, getHandlers: () => GestureHandlers | null): () => void {
	let activePointerId: number | null = null;
	let touchPan: {
		pointerId: number;
		startY: number;
		scrollTop: number;
		scrollParent: HTMLElement;
		// Last sample, for the flick velocity handed to startMomentum below.
		lastY: number;
		lastTime: number;
		velocity: number;
	} | null = null;
	// Every currently-down touch's latest screen position — tracked
	// independently of touchPan/pinch so a second touch joining mid-gesture
	// always has both points available to compute a starting pinch distance
	// and midpoint from.
	const touches = new Map<number, Point>();
	let pinch: { ids: [number, number]; startDistance: number; startScale: number; anchor: Point; content: HTMLElement; placeholder: HTMLElement } | null = null;

	// event.clientX/Y are in CSS pixels relative to the canvas's rendered
	// (possibly shrunk-to-fit, e.g. by the page placeholder's max-width:
	// 100% on a narrow phone screen) size — but every stroke coordinate is
	// stored, and every draw call issued, in the canvas's *backing-store*
	// pixel space (canvas.width/height, set from the pdf.js viewport). On
	// desktop those two sizes are usually equal so this was invisible; on a
	// phone where the page is scaled down to fit, skipping this conversion
	// put every stroke closer to the canvas's top-left origin than the
	// actual touch point, worse the further out you drew — exactly the
	// "appears diagonally above the pen tip, inconsistently" symptom.
	const toPoint = (event: PointerEvent): Point => {
		const rect = el.getBoundingClientRect();
		const scaleX = rect.width === 0 ? 1 : el.width / rect.width;
		const scaleY = rect.height === 0 ? 1 : el.height / rect.height;
		return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
	};

	const isImplausiblePenContact = (event: PointerEvent): boolean =>
		event.pointerType === 'pen' && (event.width > MAX_PLAUSIBLE_PEN_CONTACT_PX || event.height > MAX_PLAUSIBLE_PEN_CONTACT_PX);

	const startTouchPan = (event: PointerEvent): void => {
		// Only one pointer drives panning at a time — a second one (e.g. an
		// incidental palm-edge contact) is ignored rather than fighting the
		// first for control.
		if (touchPan) return;
		const scrollParent = findScrollParent(el);
		if (!scrollParent) return;
		touchPan = {
			pointerId: event.pointerId,
			startY: event.clientY,
			scrollTop: scrollParent.scrollTop,
			scrollParent,
			lastY: event.clientY,
			lastTime: event.timeStamp,
			velocity: 0,
		};
		try {
			el.setPointerCapture(event.pointerId);
		} catch (error) {
			console.error('Inkling: setPointerCapture failed; continuing without it.', error);
		}
		event.preventDefault();
	};

	// A second touch joining an existing one hands off from single-finger
	// scroll-pan to two-finger pinch-zoom/pan instead — the two are mutually
	// exclusive, never simultaneous.
	const startPinch = (): void => {
		if (touchPan) {
			try {
				el.releasePointerCapture(touchPan.pointerId);
			} catch {
				// Already released (e.g. the pointer that had capture is the
				// one still down) — nothing left to clean up.
			}
			touchPan = null;
		}
		const content = el.parentElement;
		const placeholder = content?.parentElement;
		if (!content || !placeholder) return;

		const ids = [...touches.keys()] as [number, number];
		const p1 = touches.get(ids[0]);
		const p2 = touches.get(ids[1]);
		if (!p1 || !p2) return;

		const rect = placeholder.getBoundingClientRect();
		const mid = midpoint(p1, p2);
		const zoom = getZoom(content);
		// The content-space (i.e. pre-transform) point currently sitting
		// under the fingers' midpoint — held fixed on screen for the rest of
		// the gesture by solving the same transform for translate on every
		// subsequent move below.
		const anchor: Point = {
			x: (mid.x - rect.left - zoom.x) / zoom.scale,
			y: (mid.y - rect.top - zoom.y) / zoom.scale,
		};
		pinch = { ids, startDistance: distance(p1, p2), startScale: zoom.scale, anchor, content, placeholder };
	};

	const onPointerDown = (event: PointerEvent) => {
		if (isImplausiblePenContact(event)) return;

		// Any contact at all halts a glide in progress — including a pen
		// coming down to write, so ink never lands on a page still sliding
		// under the tip.
		stopMomentum();

		if (event.pointerType === 'touch') {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (touches.size === 2) {
				startPinch();
				try {
					el.setPointerCapture(event.pointerId);
				} catch (error) {
					console.error('Inkling: setPointerCapture failed; continuing without it.', error);
				}
				event.preventDefault();
			} else if (touches.size === 1) {
				startTouchPan(event);
			}
			return;
		}

		// A gesture is already in progress on a different pointer (e.g. a
		// palm registering as a second, spurious pointer mid-stroke) —
		// ignore it rather than hijacking the active one.
		if (activePointerId !== null) return;
		const handlers = getHandlers();
		if (!handlers) return;

		activePointerId = event.pointerId;
		try {
			// Stylus pointer-capture behavior varies across Android
			// vendors/WebViews in practice (see the plan's Architecture
			// notes) — a capture failure shouldn't abort the whole gesture,
			// just lose the "keeps tracking outside the element" benefit.
			el.setPointerCapture(event.pointerId);
		} catch (error) {
			console.error('Inkling: setPointerCapture failed; continuing without it.', error);
		}
		event.preventDefault();
		handlers.onStart(toPoint(event), event);
	};

	const onPointerMove = (event: PointerEvent) => {
		if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
		}

		if (pinch && pinch.ids.includes(event.pointerId)) {
			const p1 = touches.get(pinch.ids[0]);
			const p2 = touches.get(pinch.ids[1]);
			if (p1 && p2) {
				const rect = pinch.placeholder.getBoundingClientRect();
				const mid = midpoint(p1, p2);
				const scale = clamp((distance(p1, p2) / pinch.startDistance) * pinch.startScale, MIN_ZOOM, MAX_ZOOM);
				const translate = clampTranslate(
					mid.x - rect.left - pinch.anchor.x * scale,
					mid.y - rect.top - pinch.anchor.y * scale,
					scale,
					rect.width,
					rect.height,
				);
				applyZoom(pinch.content, { scale, x: translate.x, y: translate.y });
				getHandlers()?.onZoomChange?.(scale);
			}
			event.preventDefault();
			return;
		}

		if (touchPan && event.pointerId === touchPan.pointerId) {
			touchPan.scrollParent.scrollTop = touchPan.scrollTop - (event.clientY - touchPan.startY);

			// Tracked against the previous *sample*, not the gesture start, so
			// this reflects how fast the finger is moving right now — which is
			// what decides the flick — rather than its average over the drag.
			const elapsed = event.timeStamp - touchPan.lastTime;
			if (elapsed > 0) {
				const sample = (event.clientY - touchPan.lastY) / elapsed;
				touchPan.velocity = touchPan.velocity * (1 - VELOCITY_SMOOTHING) + sample * VELOCITY_SMOOTHING;
				touchPan.lastY = event.clientY;
				touchPan.lastTime = event.timeStamp;
			}
			return;
		}
		if (event.pointerType !== 'touch') getHandlers()?.onHover?.(toPoint(event));
		if (event.pointerId !== activePointerId) return;
		getHandlers()?.onMove(toPoint(event), event);
	};

	const onPointerLeave = (event: PointerEvent) => {
		if (event.pointerType === 'touch') return;
		getHandlers()?.onHover?.(null);
	};

	const endGesture = (event: PointerEvent, cancelled: boolean) => {
		if (event.pointerType === 'touch') touches.delete(event.pointerId);

		// Ends the whole pinch as soon as either finger lifts, rather than
		// trying to seamlessly hand off to single-finger pan with the other —
		// simpler, and a deliberate two-finger gesture ending with one finger
		// still down is rare enough not to be worth the extra state.
		if (pinch && pinch.ids.includes(event.pointerId)) {
			const scale = getZoom(pinch.content).scale;
			pinch = null;
			getHandlers()?.onZoomChange?.(scale);
			getHandlers()?.onZoomEnd?.(scale);
			return;
		}
		if (touchPan && event.pointerId === touchPan.pointerId) {
			// A cancelled pan (the browser taking the gesture over, a palm
			// landing) shouldn't fling the page — only a real lift does.
			if (!cancelled) startMomentum(touchPan.scrollParent, touchPan.velocity);
			touchPan = null;
			return;
		}
		if (event.pointerId !== activePointerId) return;
		activePointerId = null;
		const handlers = getHandlers();
		if (cancelled) handlers?.onCancel(event);
		else handlers?.onEnd(toPoint(event), event);
	};

	const onPointerUp = (event: PointerEvent) => endGesture(event, false);
	const onPointerCancel = (event: PointerEvent) => endGesture(event, true);

	el.addEventListener('pointerdown', onPointerDown);
	el.addEventListener('pointermove', onPointerMove);
	el.addEventListener('pointerup', onPointerUp);
	el.addEventListener('pointercancel', onPointerCancel);
	el.addEventListener('pointerleave', onPointerLeave);

	return () => {
		stopMomentum();
		el.removeEventListener('pointerdown', onPointerDown);
		el.removeEventListener('pointermove', onPointerMove);
		el.removeEventListener('pointerup', onPointerUp);
		el.removeEventListener('pointercancel', onPointerCancel);
		el.removeEventListener('pointerleave', onPointerLeave);
	};
}
