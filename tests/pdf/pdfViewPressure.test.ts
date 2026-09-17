// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { StrokeAnnotation } from '../../src/annotate/types';
import { openPdfView } from '../harness/pdfView';

// The PDF view converts every annotation between canvas space and PDF space
// on the way to a save, and it rebuilt each point as a bare {x, y} while
// doing it — so the pressure a stylus stroke was drawn with never reached
// the file. Every pen stroke in a 2,237-stroke handwritten note was saved
// with none, and came back on reopen at full, untapered width.
//
// The same conversion reprojects a page's ink when a zoom re-renders it
// sharper, which is why the writing visibly thickened the moment a page was
// zoomed.

const tapered: StrokeAnnotation = {
	id: 'ink-taper',
	kind: 'stroke',
	tool: 'pen',
	color: '#1e1e1e',
	width: 3,
	points: [
		{ x: 10, y: 10, p: 0.2 },
		{ x: 20, y: 20, p: 0.9 },
		{ x: 30, y: 30, p: 0.4 },
	],
};

describe('a pen stroke drawn with pressure, in the PDF view', () => {
	it('is saved with that pressure', async () => {
		const view = openPdfView();
		view.showPage(1, 2, [tapered]);
		view.markDirty(1);

		await view.view.flushPendingWrites();

		const saved = view.writes.flat()[0]?.annotations[0];
		const pressures = saved?.kind === 'stroke' ? saved.points.map((point) => point.p) : [];
		expect(pressures).toEqual([0.2, 0.9, 0.4]);
	});
});
