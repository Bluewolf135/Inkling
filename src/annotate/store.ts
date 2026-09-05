import { HistoryStack } from './history';
import { Annotation } from './types';

// Whether a gesture actually changed the page.
//
// Compared element by element, not by array identity. An untouched page has
// no entry in the map, so `getPage` hands back a *fresh* empty array every
// time it is asked — which means an identity check never matched for one,
// and a gesture that did nothing on an empty page (tapping the eraser on
// blank space, most obviously) recorded a useless undo step and marked the
// page dirty, scheduling a save of no change at all.
//
// Identity per element is the right depth: annotations are replaced
// wholesale on every edit rather than mutated in place, so two arrays
// holding the same objects hold the same drawing.
function unchanged(before: Annotation[], after: Annotation[]): boolean {
	if (before === after) return true;
	if (before.length !== after.length) return false;
	return before.every((annotation, index) => annotation === after[index]);
}

// Every mutation — a finished stroke, a shape, an erase, a move, a resize,
// a recolor — goes through the same setPageLive()-during-the-gesture then
// commitGesture()-once-at-the-end pattern. That keeps undo/redo uniform
// across every tool: one gesture is always exactly one history entry,
// regardless of how many intermediate live-preview updates it produced.
export class AnnotationStore {
	private pages = new Map<number, Annotation[]>();

	constructor(
		private readonly history: HistoryStack,
		private readonly onChange: (pageNumber: number) => void,
		// Fires once per actually-committed gesture (not on every live-preview
		// frame) — the persistence layer (src/pdfView.ts) hooks this to know
		// when a page's saved annotations have gone stale.
		private readonly onCommit: (pageNumber: number) => void,
	) {}

	getPage(pageNumber: number): Annotation[] {
		return this.pages.get(pageNumber) ?? [];
	}

	setPageLive(pageNumber: number, annotations: Annotation[]): void {
		this.pages.set(pageNumber, annotations);
		this.onChange(pageNumber);
	}

	// Seeds a page's annotations without touching history or firing
	// onCommit — for loading previously-saved state from the file, which is
	// already persisted by definition.
	seedPage(pageNumber: number, annotations: Annotation[]): void {
		this.pages.set(pageNumber, annotations);
		this.onChange(pageNumber);
	}

	commitGesture(pageNumber: number, before: Annotation[]): void {
		const after = this.pages.get(pageNumber) ?? [];
		if (unchanged(before, after)) return;

		this.history.push({ pageNumber, before, after });
		this.onCommit(pageNumber);
	}

	// Applies the next entry off the history, in this store. Written
	// this way round — the store applies an entry the history merely
	// hands back — so an entry recorded against one store can be applied
	// to another. That is what lets a Markdown ink block keep its undo
	// history across the re-render its own save causes.
	//
	// Returns the page that changed, so the caller can persist just that
	// one, or undefined when there was nothing to do.
	applyUndo(): number | undefined {
		const entry = this.history.undo();
		if (!entry) return undefined;
		this.pages.set(entry.pageNumber, entry.before);
		this.onChange(entry.pageNumber);
		return entry.pageNumber;
	}

	applyRedo(): number | undefined {
		const entry = this.history.redo();
		if (!entry) return undefined;
		this.pages.set(entry.pageNumber, entry.after);
		this.onChange(entry.pageNumber);
		return entry.pageNumber;
	}

	clearPage(pageNumber: number): void {
		const before = this.getPage(pageNumber);
		if (before.length === 0) return;
		this.setPageLive(pageNumber, []);
		this.commitGesture(pageNumber, before);
	}
}
