// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { HIGHLIGHTER_OPACITY } from '../../src/annotate/types';
import { mountTestSurface, type TestSurface } from '../harness/surface';

// Wiring, not logic. That highlights and ink render separately is already
// covered as a pure function; what this asks is whether the controller
// actually gives them separate canvases, in the right order, at the right
// time — because a highlight painted onto the ink layer looks exactly like
// a highlight until you notice it is not multiplied into the page.

let surface: TestSurface;

const HIGHLIGHT = '.inkling-annotation-highlight';

function layers(): string[] {
	return Array.from(surface.host.querySelectorAll('canvas')).map((c) => c.className);
}

function drawCallsOn(selector: string): string[] {
	const canvas = surface.host.querySelector<HTMLCanvasElement>(selector);
	if (!canvas) return [];
	const held = canvas as unknown as { __ctx?: { calls: Array<{ op: string }> } };
	return (held.__ctx?.calls ?? []).map((call) => call.op);
}

beforeEach(() => {
	document.body.innerHTML = '';
	surface = mountTestSurface(800, 450);
});

describe('the highlight layer', () => {
	it('does not exist until something is highlighted', () => {
		surface.drawStroke([[10, 10], [80, 12], [140, 14]]);
		expect(surface.host.querySelector(HIGHLIGHT)).toBeNull();
		// A canvas costs width x height x 4 bytes the moment it exists, and
		// most pages of most books carry no highlight at all.
		expect(layers()).toHaveLength(2);
	});

	it('appears the first time the highlighter is used', () => {
		surface.controller.setTool('highlighter');
		surface.drawStroke([[10, 10], [80, 12], [140, 14]]);
		expect(surface.host.querySelector(HIGHLIGHT)).not.toBeNull();
		expect(layers()).toHaveLength(3);
	});

	it('carries the opacity the stylesheet multiplies it by', () => {
		surface.controller.setTool('highlighter');
		surface.drawStroke([[10, 10], [140, 14]]);

		// styles.css reads this as var(--inkling-highlight-opacity) and has
		// no fallback, on purpose: the number lives in one place. Unset, the
		// declaration is invalid and every highlight composites at full
		// strength.
		const canvas = surface.host.querySelector<HTMLCanvasElement>(HIGHLIGHT);
		expect(canvas?.style.getPropertyValue('--inkling-highlight-opacity')).toBe(String(HIGHLIGHTER_OPACITY));
	});

	it('sits underneath the ink, so a pen stroke over a highlight stays on top', () => {
		surface.controller.setTool('highlighter');
		surface.drawStroke([[10, 10], [140, 14]]);

		const classes = layers();
		expect(classes[0]).toContain('inkling-annotation-highlight');
		expect(classes[1]).toContain('inkling-annotation-base');
		expect(classes[2]).toContain('inkling-annotation-overlay');
	});

	it('takes the highlight off the ink layer rather than drawing it twice', () => {
		surface.controller.setTool('highlighter');
		surface.drawStroke([[10, 10], [140, 14]]);

		expect(drawCallsOn(HIGHLIGHT)).toContain('stroke');
		// The base layer is repainted (cleared) but must not paint the
		// highlight itself — drawn on both, it would be composited twice and
		// the un-multiplied copy would sit over the words.
		expect(drawCallsOn('.inkling-annotation-base')).not.toContain('stroke');
	});

	it('repaints empty when the last highlight is erased', () => {
		surface.controller.setTool('highlighter');
		surface.drawStroke([[10, 10], [140, 14]]);

		const before = drawCallsOn(HIGHLIGHT).filter((op) => op === 'stroke').length;
		expect(before).toBeGreaterThan(0);

		surface.controller.clearCurrentPage();

		// The layer is kept once created, so erasing has to repaint it empty.
		// Left to the `annotations.some(isHighlight)` check alone it would
		// simply not be redrawn, and the erased highlight would stay visible.
		const canvas = surface.host.querySelector<HTMLCanvasElement>(HIGHLIGHT);
		const held = canvas as unknown as { __ctx: { calls: Array<{ op: string }> } };
		const since = held.__ctx.calls.slice(held.__ctx.calls.map((c) => c.op).lastIndexOf('clearRect'));
		expect(since.filter((c) => c.op === 'stroke')).toHaveLength(0);
	});
});
