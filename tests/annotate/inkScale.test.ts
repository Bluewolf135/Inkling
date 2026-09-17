// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mountTestSurface } from '../harness/surface';

// A pen's width is a number on the toolbar, and a stroke's width is in the
// canvas pixels of the page it lands on. The two were the same number, which
// holds only while a page is never backed at a different resolution — and
// the PDF view re-backs a page, denser, every time it is zoomed far enough
// to need sharpening.
//
// On 2026-09-16 that split one page of handwriting, drawn with one pen, into
// two widths: 319 strokes at 1.19pt before a zoom and 395 at 0.92pt after
// it, the ratio of the two render scales. The writing visibly thinned
// mid-page.
//
// So the host says how many canvas pixels a unit of pen width is on a page,
// and the controller asks at the moment ink is made.

beforeEach(() => {
	document.body.innerHTML = '';
});

const line: Array<[number, number]> = [
	[100, 100],
	[200, 140],
	[300, 100],
];

describe('pen width on a page backed at another resolution', () => {
	it('is the toolbar width on a page with no scale of its own', () => {
		const surface = mountTestSurface();
		surface.controller.setWidth(3);

		surface.drawStroke(line);

		expect(surface.annotations()[0]?.width).toBe(3);
	});

	it('is scaled into that page’s canvas pixels', () => {
		const surface = mountTestSurface(800, 450, { getInkScale: () => 1.5 });
		surface.controller.setWidth(3);

		surface.drawStroke(line);

		expect(surface.annotations()[0]?.width).toBe(4.5);
	});

	it('follows the page when its resolution changes between strokes', () => {
		let scale = 1;
		const surface = mountTestSurface(800, 450, { getInkScale: () => scale });
		surface.controller.setWidth(3);

		surface.drawStroke(line);
		scale = 1.3;
		surface.drawStroke([
			[100, 300],
			[300, 320],
		]);

		const [first, second] = surface.annotations().map((a) => a.width);
		expect(first).toBe(3);
		expect(second).toBeCloseTo(3.9);
	});
});
