import { Annotation } from './types';

// One committed gesture, as data rather than as a pair of closures.
//
// It used to hold `undo`/`redo` functions that captured the store they came
// from. That worked while a controller outlived its history, and broke the
// moment anything needed the reverse: a Markdown ink block is destroyed and
// rebuilt by its own save, so carrying its history across that rebuild
// would have meant carrying closures that still pointed at the *old*
// store — an undo that quietly mutated a discarded object while the
// surface on screen sat unchanged.
//
// Holding the page's contents before and after instead means any store can
// apply any entry, which is what lets undo survive a re-render.
export interface HistoryEntry {
	pageNumber: number;
	before: Annotation[];
	after: Annotation[];
}

// Session-only by design (per the plan's Undo/redo scope note) — not
// persisted. Once an annotation is committed to the store it's already
// durable and independently editable via select/move/delete, so there's no
// need for a cross-session log too.
export class HistoryStack {
	private undoStack: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];

	push(entry: HistoryEntry): void {
		this.undoStack.push(entry);
		this.redoStack = [];
	}

	// The entry to reverse, moved onto the redo stack, or undefined when
	// there is nothing to undo. Applying it is the caller's job — see
	// AnnotationStore.applyUndo.
	undo(): HistoryEntry | undefined {
		const entry = this.undoStack.pop();
		if (!entry) return undefined;
		this.redoStack.push(entry);
		return entry;
	}

	redo(): HistoryEntry | undefined {
		const entry = this.redoStack.pop();
		if (!entry) return undefined;
		this.undoStack.push(entry);
		return entry;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
	}
}
