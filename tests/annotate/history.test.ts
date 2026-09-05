import { describe, expect, it, vi } from 'vitest';
import { HistoryStack } from '../../src/annotate/history';
import { AnnotationStore } from '../../src/annotate/store';
import type { Annotation } from '../../src/annotate/types';

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] };
}

function makeStore(history: HistoryStack) {
	const changed = vi.fn();
	const committed = vi.fn();
	return { store: new AnnotationStore(history, changed, committed), changed, committed };
}

describe('HistoryStack', () => {
	it('has nothing to undo or redo when empty', () => {
		const history = new HistoryStack();
		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(false);
		expect(history.undo()).toBeUndefined();
		expect(history.redo()).toBeUndefined();
	});

	it('hands back the entry to reverse, and moves it to the redo stack', () => {
		const history = new HistoryStack();
		history.push({ pageNumber: 1, before: [], after: [stroke('a')] });

		const undone = history.undo();
		expect(undone?.before).toEqual([]);
		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(true);

		expect(history.redo()?.after).toEqual([stroke('a')]);
		expect(history.canUndo).toBe(true);
	});

	it('drops the redo stack once new work is committed', () => {
		// Redoing onto a different branch of history is not something anyone
		// means to do.
		const history = new HistoryStack();
		history.push({ pageNumber: 1, before: [], after: [stroke('a')] });
		history.undo();
		expect(history.canRedo).toBe(true);

		history.push({ pageNumber: 1, before: [], after: [stroke('b')] });
		expect(history.canRedo).toBe(false);
	});
});

describe('AnnotationStore with history', () => {
	it('undoes and redoes a committed gesture', () => {
		const history = new HistoryStack();
		const { store } = makeStore(history);

		const before = store.getPage(1);
		store.setPageLive(1, [stroke('a')]);
		store.commitGesture(1, before);

		expect(store.applyUndo()).toBe(1);
		expect(store.getPage(1)).toEqual([]);

		expect(store.applyRedo()).toBe(1);
		expect(store.getPage(1)).toEqual([stroke('a')]);
	});

	it('reports nothing when there is nothing to undo', () => {
		const { store } = makeStore(new HistoryStack());
		expect(store.applyUndo()).toBeUndefined();
		expect(store.applyRedo()).toBeUndefined();
	});

	it('does not record a gesture that changed nothing', () => {
		const history = new HistoryStack();
		const { store, committed } = makeStore(history);
		const before = store.getPage(1);
		store.commitGesture(1, before);
		expect(history.canUndo).toBe(false);
		expect(committed).not.toHaveBeenCalled();
	});

	it('lets a *different* store apply an entry the first one recorded', () => {
		// The property the whole change exists for. A Markdown ink block is
		// destroyed and rebuilt by its own save, roughly a second after the
		// pen comes up; its history used to hold closures over the store it
		// came from, so carrying it across that rebuild would have meant an
		// undo that mutated a discarded object while the surface on screen
		// sat unchanged.
		const history = new HistoryStack();
		const { store: first } = makeStore(history);

		const before = first.getPage(1);
		first.setPageLive(1, [stroke('a')]);
		first.commitGesture(1, before);

		// The block re-renders: a brand-new store, seeded from the file, over
		// the same retained history.
		const { store: second } = makeStore(history);
		second.seedPage(1, [stroke('a')]);

		expect(second.applyUndo()).toBe(1);
		expect(second.getPage(1)).toEqual([]);
		expect(first.getPage(1)).toEqual([stroke('a')]);
	});

	it('keeps undoing back through several gestures after a rebuild', () => {
		const history = new HistoryStack();
		const { store: first } = makeStore(history);

		let before = first.getPage(1);
		first.setPageLive(1, [stroke('a')]);
		first.commitGesture(1, before);

		before = first.getPage(1);
		first.setPageLive(1, [stroke('a'), stroke('b')]);
		first.commitGesture(1, before);

		const { store: second } = makeStore(history);
		second.seedPage(1, [stroke('a'), stroke('b')]);

		second.applyUndo();
		expect(second.getPage(1)).toEqual([stroke('a')]);
		second.applyUndo();
		expect(second.getPage(1)).toEqual([]);
		expect(second.applyUndo()).toBeUndefined();
	});
});
