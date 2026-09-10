import {
	CharCodes,
	copyStringIntoBuffer,
	PDFArray,
	PDFContext,
	PDFCrossRefSection,
	PDFHexString,
	PDFNumber,
	PDFObject,
	PDFRef,
	PDFTrailer,
	PDFTrailerDict,
} from 'pdf-lib';
import type { ChangeSet } from './changeSet';
import type { XrefStyle } from './xrefScan';

// The appendix: the changed objects, a cross-reference section describing
// where they now live, and a trailer chaining back to what was there before.
// Concatenated onto the original file it makes a valid PDF whose first
// `baseLength` bytes are the original, byte for byte.
//
// A reader follows startxref to the newest cross-reference section and reads
// /Prev back through the chain, taking the most recent definition of each
// object. An object appearing twice is the mechanism working, not a
// corruption: the later one wins.
//
// Everything here is assembled from pdf-lib's own serialization primitives
// rather than reimplemented. PDFCrossRefSection, PDFCrossRefStream,
// PDFTrailerDict and PDFTrailer are all exported from the package root, and
// every PDFObject can size and copy itself — which is all PDFWriter uses.

export interface UpdateOptions {
	context: PDFContext;
	changes: ChangeSet;
	style: XrefStyle;
	// Where the appendix will land, which is the length of the file it is
	// being appended to. Every offset written into the cross-reference
	// section is absolute in the resulting file, so it is this plus the
	// offset within the appendix.
	baseLength: number;
	// The offset of the cross-reference section this one chains to.
	prevXrefOffset: number;
	id: [PDFObject, PDFObject];
}

// Serializes one indirect object exactly the way PDFWriter does, so what we
// append is indistinguishable from what a full save would have written.
function serializeIndirectObject(ref: PDFRef, object: PDFObject): Uint8Array {
	// The same arithmetic as PDFWriter.computeIndirectObjectSize: the ref's
	// own size with 'R' replaced by 'obj\n' (+3), and the object's with
	// '\nendobj\n\n' after it (+9).
	const buffer = new Uint8Array(ref.sizeInBytes() + 3 + object.sizeInBytes() + 9);
	let offset = 0;
	offset += copyStringIntoBuffer(String(ref.objectNumber), buffer, offset);
	buffer[offset++] = CharCodes.Space;
	offset += copyStringIntoBuffer(String(ref.generationNumber), buffer, offset);
	buffer[offset++] = CharCodes.Space;
	offset += copyStringIntoBuffer('obj', buffer, offset);
	buffer[offset++] = CharCodes.Newline;
	offset += object.copyBytesInto(buffer, offset);
	buffer[offset++] = CharCodes.Newline;
	offset += copyStringIntoBuffer('endobj', buffer, offset);
	buffer[offset++] = CharCodes.Newline;
	buffer[offset++] = CharCodes.Newline;
	return buffer.subarray(0, offset);
}

function bytesOf(value: { sizeInBytes(): number; copyBytesInto(buffer: Uint8Array, offset: number): number }): Uint8Array {
	const buffer = new Uint8Array(value.sizeInBytes());
	const written = value.copyBytesInto(buffer, 0);
	return buffer.subarray(0, written);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

const NEWLINE = (): Uint8Array => new Uint8Array([CharCodes.Newline]);

// Sixteen random bytes as a hex string, which is what /ID elements are.
function randomId(): PDFHexString {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return PDFHexString.of(hex);
}

// The /ID array for an update section.
//
// Two elements, and they are not the same kind of thing. The first is the
// file's permanent identity and is preserved from whatever the document
// already had — from its trailer if it has one, invented once if it does not.
// The second is regenerated on every update, which is the entire purpose of
// the array: it says "this is a different revision of the same file".
// Preserving both, or regenerating both, are different flavours of wrong.
export function documentId(context: PDFContext, previous: [PDFObject, PDFObject] | null): [PDFObject, PDFObject] {
	if (previous) return [previous[0], randomId()];

	const existing = context.trailerInfo.ID;
	if (existing instanceof PDFArray && existing.size() >= 1) {
		const first = existing.get(0);
		if (first) return [first, randomId()];
	}
	return [randomId(), randomId()];
}

interface PlacedObject {
	ref: PDFRef;
	bytes: Uint8Array;
	offset: number;
}

// Lays out the changed objects, in ascending object number — which both of
// pdf-lib's cross-reference writers require of the entries describing them.
function placeObjects(context: PDFContext, changes: ChangeSet, startOffset: number): { placed: PlacedObject[]; end: number } {
	const refs = [...changes.written].sort((a, b) => a.objectNumber - b.objectNumber);
	const placed: PlacedObject[] = [];
	let offset = startOffset;

	for (const ref of refs) {
		const object = context.lookup(ref);
		// A ref in the change set with nothing behind it would serialize as
		// garbage. It should be impossible — recordChanges removes anything
		// freed in the same pass — so skipping rather than throwing keeps a
		// surprise from costing the user their save.
		if (!object) continue;
		const bytes = serializeIndirectObject(ref, object);
		placed.push({ ref, bytes, offset });
		offset += bytes.length;
	}

	return { placed, end: offset };
}

// The entries an update section describes, in the order both writers demand:
// ascending object number, with the freed ones interleaved rather than
// following.
function orderedEntries(placed: PlacedObject[], changes: ChangeSet, extra: PlacedObject[] = []): { ref: PDFRef; offset: number | null }[] {
	return [
		...placed.map((item) => ({ ref: item.ref, offset: item.offset })),
		...extra.map((item) => ({ ref: item.ref, offset: item.offset })),
		...[...changes.freed].map((ref) => ({ ref, offset: null })),
	].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
}

function trailerFields(options: UpdateOptions, size: number): Record<string, PDFObject | undefined> {
	const { context, prevXrefOffset, id } = options;
	return {
		Size: PDFNumber.of(size),
		Root: context.trailerInfo.Root,
		Info: context.trailerInfo.Info,
		ID: context.obj([id[0], id[1]]),
		Prev: PDFNumber.of(prevXrefOffset),
	};
}

function buildClassicUpdate(options: UpdateOptions): Uint8Array {
	const { context, changes, baseLength } = options;

	// A leading newline, always. The original may end at `%%EOF` with no
	// terminator, and gluing an object header onto it would make the first
	// appended object unparseable.
	const lead = NEWLINE();
	const { placed, end } = placeObjects(context, changes, baseLength + lead.length);

	const xref = PDFCrossRefSection.createEmpty();
	for (const entry of orderedEntries(placed, changes)) {
		// nextFreeObjectNumber 0 ends the free list. Chaining freed entries
		// into a real linked list would let their object numbers be reused,
		// which we never do — every new object takes a fresh number from
		// context.nextRef(), whose counter reflects every object anywhere in
		// the file and so cannot collide.
		if (entry.offset === null) xref.addDeletedEntry(entry.ref, 0);
		else xref.addEntry(entry.ref, entry.offset);
	}

	const size = context.largestObjectNumber + 1;
	return concatChunks([
		lead,
		...placed.map((item) => item.bytes),
		bytesOf(xref),
		NEWLINE(),
		bytesOf(PDFTrailerDict.of(context.obj(trailerFields(options, size)))),
		NEWLINE(),
		bytesOf(PDFTrailer.forLastCrossRefSectionOffset(end)),
		NEWLINE(),
	]);
}

export function buildIncrementalUpdate(options: UpdateOptions): Uint8Array {
	if (options.style === 'table') return buildClassicUpdate(options);
	throw new Error('Inkling: the cross-reference stream writer is not built yet.');
}
