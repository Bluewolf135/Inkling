// Byte-level scanning of the tail of a PDF, which is the one thing pdf-lib
// cannot be asked for.
//
// PDFParser.parseDocument walks a file linearly from the header to EOF,
// parsing every object it meets, and reads a trailer only to pick up /Root
// and /Info. `startxref` is parsed and then discarded. Two consequences: we
// have to find it ourselves, and a book whose cross-reference table is
// broken opens perfectly well in Inkling today because nothing consults it.
//
// The second is why this module exists. Appending to such a file writes a
// /Prev pointing at an offset that is not a cross-reference section, which
// produces a file pdf-lib still reads and a stricter reader does not — a
// corruption our own parser is structurally blind to. Every question this
// module answers is a precondition of the fast path, never a diagnosis
// after the fact.

export type XrefStyle = 'table' | 'stream';

export interface XrefScan {
	style: XrefStyle;
	// Byte offset of the last cross-reference section, which becomes the
	// /Prev of the section we append.
	offset: number;
	// The text of the trailer dictionary (classic) or the cross-reference
	// stream's own dictionary (stream), for the classifier to inspect.
	trailerText: string;
}

export interface XrefUnknown {
	style: 'unknown';
	reason: string;
}

// How far back from EOF to look for `startxref`. The spec allows arbitrary
// trailing whitespace and some writers leave a few hundred bytes of it;
// 2 KiB is far past anything seen in practice and still a trivial scan.
const TAIL_SCAN_BYTES = 2048;

// A dictionary at the end of a file is small — a few hundred bytes at most.
// Reading a bounded window rather than to EOF keeps a malformed file from
// turning a scan into a copy of the whole book.
const DICT_SCAN_BYTES = 8192;

// Read as Latin-1 so every byte maps to exactly one character and an offset
// in the string is an offset in the file. A PDF's structure is ASCII; only
// stream contents are not, and nothing here reads inside a stream.
function latin1(bytes: Uint8Array, start: number, end: number): string {
	let text = '';
	const stop = Math.min(end, bytes.length);
	for (let index = Math.max(0, start); index < stop; index++) {
		text += String.fromCharCode(bytes[index] ?? 0);
	}
	return text;
}

// The byte offset named by the last `startxref` in the file, or null when
// there is none, it is not a number, or it does not point inside the file.
export function findStartXref(bytes: Uint8Array): number | null {
	const from = Math.max(0, bytes.length - TAIL_SCAN_BYTES);
	const tail = latin1(bytes, from, bytes.length);
	const keyword = tail.lastIndexOf('startxref');
	if (keyword < 0) return null;

	const match = /^\s*(\d+)/.exec(tail.slice(keyword + 'startxref'.length));
	if (!match?.[1]) return null;

	const offset = Number(match[1]);
	// Zero is a legal integer and never a legal offset: byte 0 is the `%PDF-`
	// header. Anything at or past the end cannot be a section either.
	if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.length) return null;
	return offset;
}

// Reads an indirect object header — `12 0 obj` — at an exact offset,
// returning where it ends so the caller can look at the object itself.
// Whitespace before the number is tolerated because some writers pad a
// section's offset to a line boundary.
export function objectHeaderAt(
	bytes: Uint8Array,
	offset: number,
): { objectNumber: number; generationNumber: number; end: number } | null {
	const text = latin1(bytes, offset, offset + 64);
	const match = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(text);
	if (!match?.[1] || !match[2]) return null;
	return {
		objectNumber: Number(match[1]),
		generationNumber: Number(match[2]),
		end: offset + match[0].length,
	};
}

// The dictionary starting at the first `<<` at or after `from`, as text,
// balanced across nesting. Returns null when it does not start with a
// dictionary or never closes inside the window — both of which are reasons
// to decline rather than to guess.
function dictionaryTextAt(bytes: Uint8Array, from: number): string | null {
	const window = latin1(bytes, from, from + DICT_SCAN_BYTES);
	const start = window.search(/\S/);
	if (start < 0 || window.slice(start, start + 2) !== '<<') return null;

	let depth = 0;
	for (let index = start; index < window.length - 1; index++) {
		const pair = window.slice(index, index + 2);
		if (pair === '<<') {
			depth += 1;
			index += 1;
		} else if (pair === '>>') {
			depth -= 1;
			index += 1;
			if (depth === 0) return window.slice(start, index + 1);
		}
	}
	return null;
}

// What is actually at the offset the file's last `startxref` names.
//
// Only two answers are useful: the classic `xref` keyword, or an indirect
// object whose dictionary says `/Type /XRef`. Everything else — including a
// file whose xref was already broken before Inkling ever saw it — is
// 'unknown', which the classifier turns into a decline.
export function scanLastXref(bytes: Uint8Array): XrefScan | XrefUnknown {
	const offset = findStartXref(bytes);
	if (offset === null) return { style: 'unknown', reason: 'no usable startxref in the last 2 KB' };

	const head = latin1(bytes, offset, offset + 32);
	if (/^\s*xref\b/.test(head)) {
		// A classic section is `xref`, its subsections, then `trailer` and a
		// dictionary. Scanning forward for the keyword is safe here because
		// the entries between are fixed-width digits and cannot contain it.
		const window = latin1(bytes, offset, offset + DICT_SCAN_BYTES);
		const trailerAt = window.indexOf('trailer');
		if (trailerAt < 0) return { style: 'unknown', reason: 'cross-reference table has no trailer' };

		const trailerText = dictionaryTextAt(bytes, offset + trailerAt + 'trailer'.length);
		if (!trailerText) return { style: 'unknown', reason: 'cross-reference table trailer is not a dictionary' };
		return { style: 'table', offset, trailerText };
	}

	const header = objectHeaderAt(bytes, offset);
	if (!header) return { style: 'unknown', reason: 'startxref points at neither a table nor an object' };

	const dictText = dictionaryTextAt(bytes, header.end);
	if (!dictText) return { style: 'unknown', reason: 'cross-reference object is not a dictionary' };
	if (!/\/Type\s*\/XRef\b/.test(dictText)) return { style: 'unknown', reason: 'cross-reference object is not /Type /XRef' };

	return { style: 'stream', offset, trailerText: dictText };
}
