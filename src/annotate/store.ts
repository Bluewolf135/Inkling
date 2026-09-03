import { HistoryStack } from './history';
import { Annotation } from './types';

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
		if (after === before) return;

		this.history.push({
			pageNumber,
			undo: () => {
				this.pages.set(pageNumber, before);
				this.onChange(pageNumber);
			},
			redo: () => {
				this.pages.set(pageNumber, after);
				this.onChange(pageNumber);
			},
		});
		this.onCommit(pageNumber);
	}

	clearPage(pageNumber: number): void {
		const before = this.getPage(pageNumber);
		if (before.length === 0) return;
		this.setPageLive(pageNumber, []);
		this.commitGesture(pageNumber, before);
	}
}
