import { PDFDocument, PDFRef } from 'pdf-lib';
import { crossReferenceTableExtent, objectHeaderAt, scanLastXref, type XrefStyle } from './xrefScan';

// Whether this exact file can be safely appended to, decided once when it is
// opened and never revisited.
//
// The governing principle of the design this implements: incremental save is
// an optimization, and it must always be able to decline. A file we can
// confidently classify takes the fast path; one we cannot — for any reason,
// including reasons nobody has thought of yet — takes the existing
// full-rewrite path and is merely as slow as it is today. Declining is
// always correct and never loses data.
//
// That is what makes a book nobody has seen before safe. The plugin does not
// need to have met a structure; it needs to be able to tell that it has not.

export interface IncrementalCapability {
	supported: true;
	style: XrefStyle;
	// Where the file's last cross-reference section starts, which becomes the
	// /Prev of the first section we append.
	xrefOffset: number;
	// The /Size the file's own last cross-reference section declares: one
	// greater than the largest object number used anywhere in it.
	//
	// **pdf-lib does not know this number, and cannot be asked for it.** Its
	// parser handles a cross-reference stream through PDFXRefStreamParser and
	// never assigns that object into the context, so
	// `context.largestObjectNumber` comes back short by at least one on every
	// file that uses one — a 9-object file reported 6. Allocating new objects
	// from that counter hands the next annotation an object number the
	// original file already uses for its cross-reference stream, and the
	// appended definition silently replaces it. pdf-lib reads the result
	// anyway; pdf.js says "Invalid Root reference".
	//
	// /Size is the authoritative answer and is exactly what it is for.
	declaredSize: number;
}

export interface IncrementalDecline {
	supported: false;
	reason: string;
}

export type IncrementalClassification = IncrementalCapability | IncrementalDecline;

function decline(reason: string): IncrementalDecline {
	return { supported: false, reason };
}

function latin1(bytes: Uint8Array, from: number, length: number): string {
	let text = '';
	const stop = Math.min(from + length, bytes.length);
	for (let index = Math.max(0, from); index < stop; index++) text += String.fromCharCode(bytes[index] ?? 0);
	return text;
}

// Every in-use entry in a classic cross-reference table, checked against the
// object it claims to describe.
//
// This is the check that catches the failure pdf-lib is blind to. A table
// whose offsets are stale still opens here — the linear parse never looks at
// it — but appending a /Prev pointing into that chain hands a stricter reader
// a file it cannot follow. A table is plain text, so every entry can be
// verified for the price of one byte poke each.
//
// Only the *last* section is checked, which is the one whose offset we write
// as /Prev. An older section further back the chain could still be wrong; on
// a file that has already been updated the last section is small and the
// older ones were somebody else's to get right.
function tableEntriesAreHonest(bytes: Uint8Array, offset: number): string | null {
	// The same structural walk scanLastXref uses to find the trailer, so the
	// two cannot disagree about where a table's entries are.
	const extent = crossReferenceTableExtent(bytes, offset);
	if (!extent) return 'cross-reference table is malformed';

	let checked = 0;
	for (const subsection of extent.subsections) {
		for (let index = 0; index < subsection.count; index++) {
			// Every entry is exactly 20 bytes: 10 of offset, a space, 5 of
			// generation, a space, one of f/n, and a two-byte terminator.
			const parsed = /^(\d{10}) (\d{5}) ([fn])/.exec(latin1(bytes, subsection.entriesAt + index * 20, 20));
			if (!parsed?.[1] || !parsed[3]) return 'cross-reference entry is malformed';
			if (parsed[3] === 'f') continue;

			const objectNumber = subsection.firstObject + index;
			// Object 0 is always the head of the free list; an in-use entry
			// for it is a broken table, not a document.
			if (objectNumber === 0) return 'cross-reference table marks object 0 as in use';

			const target = objectHeaderAt(bytes, Number(parsed[1]));
			if (!target) return `cross-reference entry for object ${objectNumber} points at no object header`;
			if (target.objectNumber !== objectNumber) {
				return `cross-reference entry for object ${objectNumber} points at object ${target.objectNumber}`;
			}
			checked += 1;
		}
	}

	if (checked === 0) return 'cross-reference table describes no objects';
	return null;
}

// A cross-reference stream's own dictionary, checked for the fields a section
// we chain onto must have.
//
// Deliberately shallower than the table check above, and the asymmetry is
// worth stating rather than hiding. Real xref streams commonly carry
// /DecodeParms << /Predictor 12 … >>, and pdf-lib does not undo PNG
// predictors — it never reads a cross-reference stream at all — so checking
// the entries would mean implementing predictors here. What is checked
// instead is that the dictionary is a well-formed XRef dictionary and that it
// names the same catalog pdf-lib found by parsing the file. A stream
// describing a different document than the one in memory is the failure that
// matters, and /Root is the one field that can be cross-checked without
// decoding anything.
function streamDictionaryIsHonest(dictText: string, doc: PDFDocument): string | null {
	if (!/\/W\s*\[\s*\d+\s+\d+\s+\d+\s*\]/.test(dictText)) return 'cross-reference stream has no /W field widths';
	if (!/\/Length\s+\d+/.test(dictText)) return 'cross-reference stream has no /Length';

	const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(dictText);
	if (!root?.[1]) return 'cross-reference stream names no /Root';

	const known = doc.context.trailerInfo.Root;
	if (known instanceof PDFRef && known.objectNumber !== Number(root[1])) {
		return `cross-reference stream names catalog ${root[1]} where the parsed document has ${known.objectNumber}`;
	}
	return null;
}

export function classifyIncrementalSave(bytes: Uint8Array, doc: PDFDocument): IncrementalClassification {
	// One try around everything. A classifier that can throw is a classifier
	// that can take an open failure with it, and there is no input for which
	// throwing is a better answer than "no".
	try {
		if (doc.context.trailerInfo.Encrypt) return decline('the document is encrypted');

		const scan = scanLastXref(bytes);
		if (scan.style === 'unknown') return decline(scan.reason);

		// A hybrid-reference file carries both a classic table and a shadow
		// xref stream, and readers disagree about which wins. Chaining onto
		// either one is a guess.
		if (/\/XRefStm\b/.test(scan.trailerText)) return decline('the file is a hybrid-reference file (/XRefStm)');
		if (/\/Encrypt\b/.test(scan.trailerText)) return decline('the last cross-reference section names /Encrypt');

		const fault =
			scan.style === 'table' ? tableEntriesAreHonest(bytes, scan.offset) : streamDictionaryIsHonest(scan.trailerText, doc);
		if (fault) return decline(fault);

		// Required of both styles, and load-bearing rather than cosmetic: see
		// declaredSize above for what goes wrong without it.
		const size = /\/Size\s+(\d+)/.exec(scan.trailerText);
		if (!size?.[1]) return decline('the last cross-reference section declares no /Size');
		const declaredSize = Number(size[1]);
		if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) return decline('the last cross-reference section declares an implausible /Size');

		return { supported: true, style: scan.style, xrefOffset: scan.offset, declaredSize };
	} catch (error) {
		return decline(`classification threw: ${String(error)}`);
	}
}
