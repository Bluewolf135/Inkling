// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { openPdfView } from '../harness/pdfView';

// "The current page" drives the page readout, the zoom readout, what the
// zoom buttons zoom and where Add page inserts. It was taken from an
// IntersectionObserver padded by a screen in each direction, which only
// reports a page when it crosses that padding — so the "is it actually on
// screen" check inside it ran at the wrong moments, and a page stayed
// current long after it had scrolled away. In a two-page handwritten note,
// page 1 never left the padded zone at all: zooming page 2 zoomed it, but
// the readout asked page 1, found no zoom, and hid itself.

// Frames run when the test says, as they would a moment after the scroll.
const frames: FrameRequestCallback[] = [];
function nextFrame(): void {
	for (const frame of frames.splice(0)) frame(performance.now());
}

beforeEach(() => {
	document.body.innerHTML = '';
	frames.length = 0;
	window.requestAnimationFrame = (cb) => frames.push(cb);
	window.cancelAnimationFrame = () => undefined;
});

describe('the current page', () => {
	it('is the page filling most of the view, not the first with a sliver showing', async () => {
		const view = openPdfView();
		await view.open();

		// Page 1's last 200px above page 2's first 800.
		view.scrollPagesTo({ pages: 2, height: 1000, viewportHeight: 1000, scrollTop: 800 });
		nextFrame();

		expect(view.currentPage()).toBe(2);
	});

	it('follows scrolling back up again', async () => {
		const view = openPdfView();
		await view.open();

		view.scrollPagesTo({ pages: 3, height: 1000, viewportHeight: 1000, scrollTop: 1900 });
		nextFrame();
		expect(view.currentPage()).toBe(3);

		view.scrollPagesTo({ pages: 3, height: 1000, viewportHeight: 1000, scrollTop: 300 });
		nextFrame();
		expect(view.currentPage()).toBe(1);
	});
});
