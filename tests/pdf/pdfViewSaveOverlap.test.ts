// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Annotation } from '../../src/annotate';
import { openPdfView } from '../harness/pdfView';

// 2026-09-26, on the tablet: a stroke drawn while the previous one was still
// saving came back as "could not save annotations to this file", and the
// stroke was gone. Waiting a few seconds between strokes avoided it.
//
// A save of a large book takes seconds there — the worker re-reads the whole
// candidate file to verify it — and the next stroke's debounce fired a second
// save while the first was in flight. The two shared one append session: the
// second was built on a file length the first was about to change, and a
// commit could fold the wrong bytes into the session's idea of the disk. Two
// full rewrites finishing out of order would put the older one on disk last.
//
// One save at a time. A save asked for mid-flight runs after, and carries
// everything dirtied meanwhile.

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

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('a save asked for while one is in flight', () => {
	it('waits for the one in flight, then saves what was drawn meanwhile', async () => {
		const releases: Array<() => void> = [];
		const view = openPdfView({ writeDone: () => new Promise<void>((resolve) => releases.push(resolve)) });
		const internals = view.view as unknown as { writer: { write: { mock: { calls: unknown[] } }; commit: { mock: { calls: unknown[] } } } };

		view.showPage(1, 1, [stroke('first')]);
		view.markDirty(1);
		const first = view.view.flushPendingWrites();
		await Promise.resolve();
		expect(internals.writer.write.mock.calls).toHaveLength(1);

		// Drawn while the first save is still being written.
		view.showPage(1, 1, [stroke('first'), stroke('second')]);
		view.markDirty(1);
		const second = view.view.flushPendingWrites();
		for (let i = 0; i < 10; i++) await Promise.resolve();

		// Not started: it would be built against a file the first is changing.
		expect(internals.writer.write.mock.calls).toHaveLength(1);

		releases.shift()?.();
		await first;
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(internals.writer.commit.mock.calls).toHaveLength(1);
		expect(internals.writer.write.mock.calls).toHaveLength(2);

		releases.shift()?.();
		await second;
		expect(internals.writer.commit.mock.calls).toHaveLength(2);
		expect(view.writes[1]?.[0]?.annotations.map((a) => a.id)).toEqual(['first', 'second']);
	});

	// Add page reads the file straight after this, and closing the view
	// terminates the writer: neither may happen under a save still landing,
	// even when nothing new is waiting behind it.
	it('is waited for by a flush with nothing new to save', async () => {
		const releases: Array<() => void> = [];
		const view = openPdfView({ writeDone: () => new Promise<void>((resolve) => releases.push(resolve)) });
		const internals = view.view as unknown as { writer: { commit: { mock: { calls: unknown[] } } } };

		view.showPage(1, 1, [stroke('a')]);
		view.markDirty(1);
		void view.view.flushPendingWrites();
		await Promise.resolve();

		let settled = false;
		const flush = view.view.flushPendingWrites().then(() => (settled = true));
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(settled).toBe(false);

		releases.shift()?.();
		await flush;
		expect(internals.writer.commit.mock.calls).toHaveLength(1);
	});

	it('saves once more, not once per request, for several asked for mid-flight', async () => {
		const releases: Array<() => void> = [];
		const view = openPdfView({ writeDone: () => new Promise<void>((resolve) => releases.push(resolve)) });

		view.showPage(1, 1, [stroke('a')]);
		view.markDirty(1);
		const first = view.view.flushPendingWrites();
		await Promise.resolve();

		const waiting: Promise<void>[] = [];
		for (const id of ['b', 'c', 'd']) {
			view.showPage(1, 1, [stroke(id)]);
			view.markDirty(1);
			waiting.push(view.view.flushPendingWrites());
		}

		releases.shift()?.();
		await first;
		for (let i = 0; i < 10; i++) await Promise.resolve();
		releases.shift()?.();
		await Promise.all(waiting);

		expect(view.writes).toHaveLength(2);
		expect(view.writes[1]?.[0]?.annotations.map((a) => a.id)).toEqual(['d']);
	});
});
