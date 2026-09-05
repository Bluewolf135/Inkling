import { PDFDocument } from 'pdf-lib';
import type { Annotation } from '../annotate/types';
import { pruneOrphanedInklingAnnotations, readInklingAnnotations, stripInklingAnnotations, writeInklingAnnotations } from './annotationSync';
import { profileFromPdfLib, riskyFeatures, type StructureProfile } from './compatibility';
import { compareFingerprints, fingerprintDocument } from './fingerprint';

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
	// pdf-lib's own reading of the document's structure, for the view to
	// check against pdf.js's — see src/pdf/compatibility.ts.
	profile: StructureProfile;
	// Document features pdf-lib is known to round-trip badly, named for a
	// notice. Empty for almost every real book.
	risky: string[];
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

	// Orphans left by past sessions are pruned in memory and carried by
	// whatever save happens next, rather than triggering a write of their
	// own. Opening a file the user only means to read must not modify it —
	// a standalone write here is a full pdf-lib round trip and, under a
	// live-replicating sync, a full re-upload, neither of which the user
	// asked for by opening a book. The return value is ignored: there is
	// nothing to do differently either way now that the document in memory
	// is already correct.
	pruneOrphanedInklingAnnotations(doc);

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

	return { doc, savedAnnotations, displayBytes, profile: profileFromPdfLib(doc), risky: riskyFeatures(doc) };
}

export async function writeDocument(
	doc: PDFDocument,
	pages: { pageNumber: number; annotations: Annotation[] }[],
): Promise<ArrayBuffer> {
	for (const { pageNumber, annotations } of pages) {
		writeInklingAnnotations(doc, pageNumber - 1, annotations);
	}

	// Fingerprinted *after* the mutation, because the mutated document is the
	// intended result — the thing the produced bytes are supposed to equal.
	// Our own annotations are excluded from the fingerprint, so having just
	// rewritten them doesn't register as a change.
	const intended = fingerprintDocument(doc);
	const bytes = await doc.save();

	// The check that makes a silent pdf-lib fault loud. Reparsing the bytes
	// we are about to hand back costs a full parse per save, which is real
	// work — it is why this lives in the writer worker and why the save
	// cadence is scaled to file size (see pdf/saveCadence.ts). The
	// alternative is a book quietly losing structure with nobody noticing for
	// months.
	//
	// updateMetadata: false because this parse is read-only; letting it stamp
	// a new ModDate would make the verification copy differ from the bytes
	// actually being written.
	const written = await PDFDocument.load(bytes, { updateMetadata: false });
	const difference = compareFingerprints(intended, fingerprintDocument(written));
	if (difference) {
		// Thrown, never returned alongside the bytes: there must be no path
		// where a caller gets something back and has to decide whether to
		// trust it. The view's existing catch leaves the file untouched and
		// re-marks the pages dirty.
		throw new Error(`Inkling: refusing to save, the PDF changed unexpectedly (${difference}).`);
	}

	return toArrayBuffer(bytes);
}
