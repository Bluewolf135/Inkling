// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate';
import { openPdfView } from '../harness/pdfView';

// 2026-09-16: a page of handwriting — 714 strokes — was written over with an
// empty page the moment "Stop annotating" was pressed. The file kept its
// history (every save is appended), so the sequence could be read straight
// out of it: eight saves that grew the page, then a ninth, 873 bytes long,
// that set its annotations to nothing.
//
// Leaving the view closes it. Obsidian's FileView does its unload work —
// `onUnloadFile`, where this view flushes pending ink and tears down — from
// inside its own `onClose`. The view overrode `onClose` without calling it,
// so no flush happened; its own `onClose` destroyed the controller, which
// empties the annotation store; and the save debounce, never cancelled,
// fired a moment later and saved what the store now said: nothing.

const stroke = (id: string): Annotation => ({
	id,
	kind: 'stroke',
	tool: 'pen',
	color: '#1e1e1e',
	width: 3,
	points: [
		{ x: 10, y: 10 },
		{ x: 40, y: 40 },
	],
});

function openViewWithUnsavedInk() {
	const view = openPdfView();
	view.showPage(2, 1, [stroke('ink-1'), stroke('ink-2')]);
	view.markDirty(2);
	return view;
}

describe('closing the PDF view with ink not yet saved', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('saves that ink before the view goes away', async () => {
		const { close, writes } = openViewWithUnsavedInk();

		await close();
		await vi.runAllTimersAsync();

		expect(writes.flat().filter((w) => w.pageNumber === 2).map((w) => w.annotations.length)).toEqual([2]);
	});

	it('never saves the page again after it is gone, and least of all as empty', async () => {
		const { close, writes } = openViewWithUnsavedInk();

		await close();
		await vi.runAllTimersAsync();

		const emptied = writes.flat().filter((w) => w.annotations.length === 0);
		expect(emptied).toEqual([]);
	});

	it('lets the writer go, rather than keeping a worker alive for a closed view', async () => {
		const { close, isTerminated } = openViewWithUnsavedInk();

		await close();

		expect(isTerminated()).toBe(true);
	});
});
