import type { InkBlockData } from './inkBlockFormat';

// What a block view needs from wherever its strokes are kept.
//
// A block's strokes used to live only inside its own fence, and the view held
// the whole of that save path: finding the fence, merging into it, choosing
// between the editor and the file, putting the scroll back. Ink kept in a
// file of its own needs none of that and some things of its own, so the view
// keeps what is common — mounting, the tool strip, the caption, the resize
// handle, the debounce and the rescue store — and asks one of these for the
// rest.

// Something that stops a block being saved, and what to tell the reader.
export interface BlockRefusal {
	message: string;
	// Offered only for an in-note block that partly parsed: what survived is
	// real, and the reader may choose to keep it.
	recoverable?: { kept: number; dropped: number };
}

export type StorageWriteResult =
	| { kind: 'saved' }
	// Not saved, for a reason that usually passes. The view holds the drawing
	// and tries again after this long.
	| { kind: 'retry'; afterMs: number }
	// Not saved. The storage has said whatever needed saying; the view keeps
	// the drawing somewhere that survives a quit.
	| { kind: 'held' };

// The view, as a storage sees it.
export interface StorageHost {
	/**
	 * Shows `data`. The first call is the block's initial load and always
	 * succeeds; a refusal the block starts with must be given before it. A
	 * later call replaces what is on screen only when nothing unsaved is on it,
	 * and says whether it did.
	 */
	show(data: InkBlockData): boolean;
	/** Stops the block being saved, replacing any refusal already shown. */
	refuse(refusal: BlockRefusal): void;
	lift(): void;
	isRefused(): boolean;
	hasUnsavedWork(): boolean;
	isDetached(): boolean;
	scheduleWrite(): void;
}

export interface InkBlockStorage {
	/** The rescue store's key for this block: a path, and the block's id. */
	readonly rescuePath: string;
	readonly blockId: string;
	/** What a held drawing must match to be adopted: the block as stored now. */
	rescueSource(): string;
	/** Called once, when the view is ready to be shown something. */
	open(host: StorageHost): void;
	/** Never throws. */
	write(data: InkBlockData): Promise<StorageWriteResult>;
	close(): void;
}
