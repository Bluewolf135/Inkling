// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { openPdfView } from '../harness/pdfView';

// A zoom sharpens a page by re-rendering it at a higher scale, which puts
// its canvas pixels closer together. A pen width counted in canvas pixels
// then draws thinner on the page than the same pen did a moment before —
// one page of a handwritten note ended up with 319 strokes at 1.19pt and 395
// at 0.92pt, from one pen, split exactly at a zoom.
//
// The width a stroke is saved with, in PDF points, is what has to hold still.

beforeEach(() => {
	document.body.innerHTML = '';
});

const line: Array<[number, number]> = [
	[100, 100],
	[200, 140],
	[300, 100],
];

async function savedWidth(scales: { base: number; rendered: number }): Promise<number> {
	const view = openPdfView();
	view.setPenWidth(3);
	view.mountDrawablePage(1, scales).drawStroke(line);
	await view.view.flushPendingWrites();
	return view.writes.flat()[0]?.annotations[0]?.width ?? Number.NaN;
}

describe('a pen stroke in the PDF view', () => {
	it('saves the same width on a page a zoom has sharpened as on one it has not', async () => {
		const unzoomed = await savedWidth({ base: 2, rendered: 2 });
		const sharpened = await savedWidth({ base: 2, rendered: 3 });

		expect(sharpened).toBeCloseTo(unzoomed);
	});

	it('draws an unzoomed page exactly as it always has', async () => {
		expect(await savedWidth({ base: 2, rendered: 2 })).toBeCloseTo(1.5);
	});
});
