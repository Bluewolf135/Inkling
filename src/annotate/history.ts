interface HistoryEntry {
	pageNumber: number;
	undo: () => void;
	redo: () => void;
}

// Session-only by design (per the plan's Undo/redo scope note) — cleared
// when the file/view is closed, not persisted. Once an annotation is
// committed to the store it's already durable and independently editable
// via select/move/delete, so there's no need for a cross-session log too.
export class HistoryStack {
	private undoStack: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];

	push(entry: HistoryEntry): void {
		this.undoStack.push(entry);
		this.redoStack = [];
	}

	// Returns the page the undone/redone entry belongs to (so the caller can
	// re-persist just that page), or undefined if there was nothing to do.
	undo(): number | undefined {
		const entry = this.undoStack.pop();
		if (!entry) return undefined;
		entry.undo();
		this.redoStack.push(entry);
		return entry.pageNumber;
	}

	redo(): number | undefined {
		const entry = this.redoStack.pop();
		if (!entry) return undefined;
		entry.redo();
		this.undoStack.push(entry);
		return entry.pageNumber;
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
