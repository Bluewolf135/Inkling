import type { Annotation } from '../annotate/types';

// The message contract between the main thread (annotationWriterClient.ts)
// and annotationWriter.worker.ts. Kept as a separate types-only module so
// both sides import the same shapes without either needing to import the
// other's runtime code.

export interface OpenRequestMessage {
	type: 'open';
	requestId: number;
	bytes: ArrayBuffer;
}

export interface WriteRequestMessage {
	type: 'write';
	requestId: number;
	pages: { pageNumber: number; annotations: Annotation[] }[];
}

export type WorkerRequestMessage = OpenRequestMessage | WriteRequestMessage;

interface OpenedOk {
	type: 'opened';
	requestId: number;
	ok: true;
	savedAnnotations: Map<number, Annotation[]>;
	// What pdf.js should render: the file with only Inkling's own
	// annotations stripped out (see stripInklingAnnotations), so its default
	// annotation-baking render still shows annotations from other PDF
	// software without doubling up with our own live overlay.
	displayBytes: ArrayBuffer;
	// Present only when opening found and pruned orphaned Inkling objects
	// left behind by past sessions (see pruneOrphanedInklingAnnotations) —
	// the resaved bytes, for the caller to write straight back to disk so a
	// bloated file shrinks immediately, without waiting on the user to make
	// a new edit first.
	prunedBytes?: ArrayBuffer;
}

interface WrittenOk {
	type: 'written';
	requestId: number;
	ok: true;
	bytes: ArrayBuffer;
}

interface RequestFailed {
	type: 'opened' | 'written';
	requestId: number;
	ok: false;
	error: string;
}

// Sent unprompted by the worker once its script has actually executed, not
// in reply to any request — hence no request id. The client waits for this
// before trusting the worker with real work, because a Worker that
// constructs without throwing is not by itself evidence that its script
// ever ran (see annotationWriterClient.ts's fallback).
export interface ReadyMessage {
	type: 'ready';
}

export type WorkerResponseMessage = OpenedOk | WrittenOk | RequestFailed | ReadyMessage;
