import { PDFDocument } from 'pdf-lib';
import type { Annotation } from '../annotate/types';
import { pruneOrphanedInklingAnnotations, readInklingAnnotations, stripInklingAnnotations, writeInklingAnnotations } from './annotationSync';

// The actual pdf-lib work, with no worker plumbing around it, so the exact
// same code can run either off the main thread (annotationWriter.worker.ts,
// the preferred path — see its comment for why) or directly on it
// (annotationWriterClient.ts's fallback, for environments where a Worker
// can't be constructed or never starts at all; desktop Obsidian turned out
// to be one).

export interface OpenedDocument {
	// Kept by the caller and passed back to writeDocument below, so repeated
	// saves reuse this parse instead of re-reading the whole file each time.
	doc: PDFDocument;
	savedAnnotations: Map<number, Annotation[]>;
	// What pdf.js should render: the file with only Inkling's own annotations
	// stripped out, so its annotation-baking render still shows annotations
	// from other PDF software without doubling up with our live overlay.
	displayBytes: ArrayBuffer;
	// Present only when opening found and pruned orphaned Inkling objects
	// left behind by past sessions — the resaved bytes, to write straight
	// back to disk so a bloated file shrinks immediately.
	prunedBytes?: ArrayBuffer;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function openDocument(bytes: ArrayBuffer): Promise<OpenedDocument> {
	const doc = await PDFDocument.load(bytes);

	const savedAnnotations = new Map<number, Annotation[]>();
	for (let index = 0; index < doc.getPageCount(); index++) {
		const annotations = readInklingAnnotations(doc, index);
		if (annotations.length > 0) savedAnnotations.set(index + 1, annotations);
	}

	let prunedBytes: ArrayBuffer | undefined;
	if (pruneOrphanedInklingAnnotations(doc)) {
		prunedBytes = toArrayBuffer(await doc.save());
	}

	// A second, independent parse of the same bytes — only worth it (and its
	// own save()) when this file actually has Inkling annotations to strip
	// out; otherwise the original bytes are already exactly the right display
	// copy. `bytes` is safe to re-read here since nothing above mutated or
	// transferred it away — pdf-lib doesn't detach the buffers it parses.
	let displayBytes: ArrayBuffer;
	if (savedAnnotations.size > 0) {
		const displayDoc = await PDFDocument.load(bytes);
		stripInklingAnnotations(displayDoc);
		displayBytes = toArrayBuffer(await displayDoc.save());
	} else {
		displayBytes = bytes.slice(0);
	}

	return { doc, savedAnnotations, displayBytes, prunedBytes };
}

export async function writeDocument(
	doc: PDFDocument,
	pages: { pageNumber: number; annotations: Annotation[] }[],
): Promise<ArrayBuffer> {
	for (const { pageNumber, annotations } of pages) {
		writeInklingAnnotations(doc, pageNumber - 1, annotations);
	}
	return toArrayBuffer(await doc.save());
}
