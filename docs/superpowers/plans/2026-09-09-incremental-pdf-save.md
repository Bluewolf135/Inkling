# Incremental PDF Save: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an autosave write only the bytes that changed — appending a PDF incremental update to the file instead of re-serializing and re-uploading the whole book — so a crash costs about a second of handwriting instead of up to a minute.

**Architecture:** Every file is classified once, when it is opened, against its own last cross-reference section. A file we can confidently classify takes the fast path; anything else falls back to today's full `PDFDocument.save()` and is merely as slow as it is now. On the fast path the writer records exactly which objects it touched, serializes only those, appends a cross-reference section matching the style the file already uses, verifies the concatenation of original + appendix **in memory in the worker before anything is written**, and hands the view an appendix to `Vault.appendBinary`. An append that cannot be proven safe — a stale file, a failed verification, an appendix grown past its worth — becomes a full rewrite instead.

**Tech Stack:** TypeScript, `pdf-lib` 1.17.1 (pinned), `pdfjs-dist` 5.4.530 (pinned), Obsidian plugin API, esbuild, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-incremental-pdf-save-design.md`

## Global Constraints

Copied from the spec and the project plan. Every task's requirements implicitly include these.

- **`isDesktopOnly: false`.** No Node.js or Electron APIs anywhere in `src/`. All vault I/O through the Vault API or `vault.adapter`. Test files under `tests/` run in Node and may use Node APIs freely.
- **No new dependencies.** pdf-lib stays at exactly 1.17.1, pdfjs-dist at exactly 5.4.530. Neither may be bumped.
- **No network calls at all.**
- Minimum Obsidian version is 1.4.4 (`manifest.json`). `Vault.appendBinary` is `@since 1.12.3`, so it **must** be feature-detected and the full-rewrite path used when it is absent.
- `strict: true` and `noUncheckedIndexedAccess: true`. Indexed access yields `T | undefined`; handle it rather than asserting.
- Obsidian API conventions: `createEl`/`createDiv`, sentence-case user copy, no `innerHTML`.
- **The governing principle of this spec: incremental save is an optimization and must always be able to decline.** Every new code path answers an unexpected input by returning "no", never by guessing. A decline is logged once per file per session, never per save, and is never surfaced to the user.
- Commit after every task. `npm run build` (which runs `tsc -noEmit` first), `npm run lint` and `npm test` must all pass before any commit.

## What the spec did not know, and what it changes

Four facts established by reading `pdf-lib@1.17.1` and `obsidian.d.ts` before planning. Each one changes a task below.

1. **Both cross-reference writers already exist inside pdf-lib and are publicly exported.** `PDFCrossRefSection` (classic table), `PDFCrossRefStream` (xref stream, including the `/W` field widths and the sparse `/Index` an incremental section needs), `PDFTrailerDict`, `PDFTrailer`, and `copyStringIntoBuffer` are all re-exported from the package root. The spec called the xref-stream writer "the largest piece of work in the item"; it is not. Both appenders are assembly, not implementation.

2. **Every `PDFObject` can serialize itself.** `object.sizeInBytes()` and `object.copyBytesInto(buffer, offset)` are the same primitives `PDFWriter` uses, so serializing a *subset* of the context is a twenty-line function that mirrors `PDFWriter.serializeToBuffer` exactly.

3. **`PDFPageLeaf.normalize()` mutates more than `/Annots`, and parsed pages have `autoNormalizeCTM` on.** `PDFObjectParser` constructs page leaves via `PDFPageLeaf.fromMapWithContext(dict, context)`, whose third parameter defaults to `true`. The first `addAnnot` on a page therefore calls `normalize()`, which (a) wraps `/Contents` in an array and pushes the shared push/pop-graphics-state content streams into it, and (b) sets `/Font`, `/XObject` and `/ExtGState` on the page's `/Resources` — an object that is frequently indirect and sometimes *shared with other pages via inheritance*. The change set cannot be "the annotations we wrote"; it must include the page dict and every indirect container mutated in place. Task 3 exists for this and is the task most likely to produce a corrupt file if it is done carelessly.

4. **Real xref streams commonly carry `/DecodeParms << /Predictor 12 … >>`, and pdf-lib does not undo PNG predictors.** Validating an xref stream's *entries* would mean implementing predictors. Task 2 therefore validates a classic table's entries in full (they are plain text) and validates an xref stream structurally plus by a `/Root` cross-check against pdf-lib, and says so in the code rather than pretending the two are equally deep.

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/pdf/xrefScan.ts` | Pure byte-level scanning of the tail of a PDF: find `startxref`, read what is at that offset, decide which of the two cross-reference styles it is (or that it is neither). No pdf-lib document required. |
| `src/pdf/incrementalClassify.ts` | The classifier. Combines `xrefScan` with the parsed `PDFDocument` and returns either a capability (style + previous xref offset) or a decline with a reason. |
| `src/pdf/changeSet.ts` | Records exactly which objects a mutation registered, mutated in place, or freed. |
| `src/pdf/appendUpdate.ts` | Builds the appendix bytes: the changed objects, a cross-reference section in the file's own style, and a trailer. |
| `src/pdf/compaction.ts` | The rule deciding when an accumulated appendix has grown past its worth and the next save must be a full rewrite. |
| `src/pdf/incrementalSave.ts` | Orchestration inside the writer: mutate under the recorder, build, verify the concatenation in memory, and return either an appendix or full bytes. |
| `tests/pdf/xrefScan.test.ts` | Tail scanning against hand-built byte fixtures. |
| `tests/pdf/incrementalClassify.test.ts` | One generated fixture per structural class, each asserted to reach a decision. |
| `tests/pdf/changeSet.test.ts` | That the recorder collects everything a page mutation touches and nothing it does not. |
| `tests/pdf/appendUpdate.test.ts` | Both appenders: round-trip through pdf-lib and pdf.js, byte-for-byte preservation of the original prefix. |
| `tests/pdf/compaction.test.ts` | The threshold rule. |
| `tests/pdf/incrementalSave.test.ts` | End-to-end in the writer: append, verify, decline, compact. |
| `tests/pdf/vaultLibrary.test.ts` | Opt-in smoke check over a real library, skipped unless `INKLING_PDF_LIBRARY` is set. |

**Modified files:**

| Path | Change |
|---|---|
| `src/pdf/annotationSync.ts` | `writeInklingAnnotations` and `pruneOrphanedInklingAnnotations` report the indirect containers they mutate in place. |
| `src/pdf/annotationWriterCore.ts` | `openDocument` retains the original bytes and classifies; `writeDocument` gains an incremental mode. |
| `src/pdf/annotationWriterProtocol.ts` | The write reply becomes a discriminated result; commit/rollback messages added. |
| `src/pdf/annotationWriterClient.ts` | Mirror the protocol change on both the worker and main-thread paths. |
| `src/pdf/annotationWriter.worker.ts` | Mirror the protocol change. |
| `src/pdf/saveCadence.ts` | A shorter ceiling for a file on the fast path. |
| `src/vaultWrite.ts` | `appendBinarySafely`: feature detection, staleness check before, size check after. |
| `src/pdfView.ts` | Route a write result to the right vault call; commit or roll back; use the incremental cadence. |

---

### Task 1: Scanning the tail of a PDF

The classifier's foundation, and the one part of it that needs no pdf-lib document at all. `startxref` has to be found by scanning, because pdf-lib parses it and throws it away (`PDFParser.parseDocument` walks the file linearly and keeps only `/Root` and `/Info` from the trailer).

**Files:**
- Create: `src/pdf/xrefScan.ts`
- Test: `tests/pdf/xrefScan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type XrefStyle = 'table' | 'stream'`
  - `interface XrefScan { style: XrefStyle; offset: number; trailerText: string }`
  - `function scanLastXref(bytes: Uint8Array): XrefScan | { style: 'unknown'; reason: string }`
  - `function findStartXref(bytes: Uint8Array): number | null`
  - `function objectHeaderAt(bytes: Uint8Array, offset: number): { objectNumber: number; generationNumber: number; end: number } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/xrefScan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findStartXref, objectHeaderAt, scanLastXref } from '../../src/pdf/xrefScan';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

// The smallest thing that is shaped like a classic-table PDF. The offsets in
// it are deliberately not real: nothing in this module resolves them, and a
// fixture that pretends otherwise invites a reader to trust the wrong thing.
const classicTail = [
	'xref',
	'0 3',
	'0000000000 65535 f ',
	'0000000009 00000 n ',
	'0000000074 00000 n ',
	'trailer',
	'<< /Size 3 /Root 1 0 R >>',
	'startxref',
	'0',
	'%%EOF',
].join('\n');

describe('findStartXref', () => {
	it('reads the offset from the tail', () => {
		const file = bytes(`%PDF-1.7\n${classicTail}`);
		// The `0` in the fixture above, which is where "xref" happens to sit
		// only because the fixture is one line long; the point is that the
		// number after the keyword is what comes back.
		expect(findStartXref(file)).toBe(0);
	});

	it('takes the last startxref, not the first', () => {
		// An already-incrementally-updated file has one per update section,
		// and only the last one is the entry point.
		const file = bytes(`%PDF-1.7\nstartxref\n17\n%%EOF\nstartxref\n412\n%%EOF\n`);
		expect(findStartXref(file)).toBe(412);
	});

	it('declines a file with no startxref at all', () => {
		expect(findStartXref(bytes('%PDF-1.7\nnothing to see here\n'))).toBeNull();
	});

	it('declines an offset that is not a number', () => {
		expect(findStartXref(bytes('%PDF-1.7\nstartxref\nlater\n%%EOF\n'))).toBeNull();
	});

	it('declines an offset past the end of the file', () => {
		expect(findStartXref(bytes('%PDF-1.7\nstartxref\n999999\n%%EOF\n'))).toBeNull();
	});
});

describe('objectHeaderAt', () => {
	it('reads an indirect object header', () => {
		const file = bytes('%PDF-1.7\n12 0 obj\n<< /Type /XRef >>\n');
		const header = objectHeaderAt(file, 9);
		expect(header?.objectNumber).toBe(12);
		expect(header?.generationNumber).toBe(0);
	});

	it('returns null where there is no header', () => {
		const file = bytes('%PDF-1.7\nnot an object\n');
		expect(objectHeaderAt(file, 9)).toBeNull();
	});
});

describe('scanLastXref', () => {
	it('recognises a classic cross-reference table', () => {
		const body = '%PDF-1.7\n';
		const file = bytes(body + classicTail.replace('\n0\n%%EOF', `\n${body.length}\n%%EOF`));
		const scan = scanLastXref(file);
		expect(scan.style).toBe('table');
		if (scan.style !== 'table') return;
		expect(scan.offset).toBe(body.length);
		expect(scan.trailerText).toContain('/Root');
	});

	it('recognises a cross-reference stream', () => {
		const head = '%PDF-1.7\n';
		const object = '9 0 obj\n<< /Type /XRef /W [1 2 1] /Size 10 >>\nstream\nendstream\nendobj\n';
		const file = bytes(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
		const scan = scanLastXref(file);
		expect(scan.style).toBe('stream');
		if (scan.style !== 'stream') return;
		expect(scan.trailerText).toContain('/Type /XRef');
	});

	it('declines when startxref points at something that is neither', () => {
		// The failure this whole module exists to catch: a file whose
		// cross-reference table is already broken opens fine in Inkling today,
		// because pdf-lib never consults it. Appending to one produces a file
		// a stricter reader cannot follow.
		const head = '%PDF-1.7\n';
		const file = bytes(`${head}this is not a cross-reference section\nstartxref\n${head.length}\n%%EOF\n`);
		expect(scanLastXref(file).style).toBe('unknown');
	});

	it('declines a stream object that does not say it is an XRef', () => {
		const head = '%PDF-1.7\n';
		const object = '9 0 obj\n<< /Type /ObjStm >>\nstream\nendstream\nendobj\n';
		const file = bytes(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
		expect(scanLastXref(file).style).toBe('unknown');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pdf/xrefScan.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/xrefScan`.

- [ ] **Step 3: Write the implementation**

Create `src/pdf/xrefScan.ts`:

```ts
// Byte-level scanning of the tail of a PDF, which is the one thing pdf-lib
// cannot be asked for.
//
// PDFParser.parseDocument walks a file linearly from the header to EOF,
// parsing every object it meets, and reads a trailer only to pick up /Root
// and /Info. `startxref` is parsed and then discarded. Two consequences:
// we have to find it ourselves, and a book whose cross-reference table is
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
	// stream's own dictionary (stream), for the classifier to inspect. Read
	// as Latin-1 so every byte maps to exactly one character and offsets in
	// the string correspond to offsets in the file.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/pdf/xrefScan.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run build && npm run lint
git add src/pdf/xrefScan.ts tests/pdf/xrefScan.test.ts
git commit -m "$(cat <<'EOF'
Find the cross-reference section pdf-lib throws away

pdf-lib parses startxref and discards it, so a book with a broken
cross-reference table opens fine here — nothing consults it. Appending to
such a file would write a /Prev pointing at nothing, which pdf-lib still
reads and a stricter reader does not. Scanning the tail ourselves is the
only way to ask the question at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The classifier and its decline path

Useful on its own even if nothing else here is built: it answers "what is actually in a library?" permanently rather than once, and it is the precondition every later task depends on.

**Files:**
- Create: `src/pdf/incrementalClassify.ts`
- Test: `tests/pdf/incrementalClassify.test.ts`

**Interfaces:**
- Consumes: `scanLastXref`, `objectHeaderAt`, `XrefStyle` from `src/pdf/xrefScan.ts` (Task 1).
- Produces:
  - `interface IncrementalCapability { supported: true; style: XrefStyle; xrefOffset: number }`
  - `interface IncrementalDecline { supported: false; reason: string }`
  - `type IncrementalClassification = IncrementalCapability | IncrementalDecline`
  - `function classifyIncrementalSave(bytes: Uint8Array, doc: PDFDocument): IncrementalClassification`

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/incrementalClassify.test.ts`:

```ts
import { PDFDocument, PDFNumber, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { classifyIncrementalSave } from '../../src/pdf/incrementalClassify';
import { toArrayBuffer } from '../../src/binary';

// One fixture per structural class, each built here rather than read from
// the vault. A suite that depends on the user's library cannot run in CI,
// depends on files not in the repository, and changes meaning every time a
// book is added or removed.
//
// One class the spec names is missing and is missing on purpose:
// **linearized**. pdf-lib cannot produce one, and hand-assembling a
// plausible linearized file would be testing the fixture rather than the
// classifier. A linearized file's *last* cross-reference section — the only
// one this module chains to — is an ordinary table or stream, so nothing
// here is specific to it; that it reaches a decision at all is covered by
// the fuzz case below and by the opt-in library check in
// tests/pdf/vaultLibrary.test.ts, where real linearized books actually are.

async function classicTableBytes(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	// useObjectStreams: false is what makes pdf-lib emit a classic table
	// through PDFWriter rather than an xref stream through PDFStreamWriter.
	return doc.save({ useObjectStreams: false });
}

async function xrefStreamBytes(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	// The default. Object streams and an xref stream together, which is what
	// the largest books in the vault use.
	return doc.save({ useObjectStreams: true });
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
	return PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
}

describe('classifyIncrementalSave', () => {
	it('takes the fast path on a classic cross-reference table', async () => {
		const bytes = await classicTableBytes();
		const result = classifyIncrementalSave(bytes, await load(bytes));
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.style).toBe('table');
		expect(result.xrefOffset).toBeGreaterThan(0);
	});

	it('takes the fast path on a cross-reference stream', async () => {
		const bytes = await xrefStreamBytes();
		const result = classifyIncrementalSave(bytes, await load(bytes));
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.style).toBe('stream');
	});

	it('declines a hybrid-reference file', async () => {
		// /XRefStm means the classic table the offset points at is shadowed
		// by an xref stream elsewhere, and the two describe the file
		// differently. Two of the twenty books in the vault are shaped this
		// way; the spec's spike found both.
		const original = await classicTableBytes();
		const text = new TextDecoder('latin1').decode(original);
		const patched = text.replace('/Root', '/XRefStm 9 /Root');
		const bytes = new TextEncoder().encode(patched);
		const result = classifyIncrementalSave(bytes, await load(await classicTableBytes()));
		expect(result.supported).toBe(false);
		if (result.supported) return;
		expect(result.reason).toMatch(/hybrid/i);
	});

	it('declines a file whose startxref points at nothing', async () => {
		// The corruption our own reader is blind to. pdf-lib opens this
		// happily, which is exactly why the classifier has to ask.
		const original = await classicTableBytes();
		const text = new TextDecoder('latin1').decode(original);
		const broken = text.replace(/startxref\n\d+/, 'startxref\n17');
		const bytes = new TextEncoder().encode(broken);
		const result = classifyIncrementalSave(bytes, await load(original));
		expect(result.supported).toBe(false);
	});

	it('declines a classic table whose entries do not point at their objects', async () => {
		// A table that parses but lies. Shifting one in-use entry's offset by
		// a byte leaves a file pdf-lib still reads perfectly.
		const original = await classicTableBytes();
		const text = new TextDecoder('latin1').decode(original);
		const broken = text.replace(/\n(\d{10}) 00000 n /, (whole, offset: string) => {
			const moved = String(Number(offset) + 3).padStart(10, '0');
			return `\n${moved} 00000 n `;
		});
		const bytes = new TextEncoder().encode(broken);
		const result = classifyIncrementalSave(bytes, await load(original));
		expect(result.supported).toBe(false);
		if (result.supported) return;
		expect(result.reason).toMatch(/entry/i);
	});

	it('declines an encrypted document', async () => {
		const bytes = await classicTableBytes();
		const doc = await load(bytes);
		// An encrypted book cannot reach the writer at all — PDFDocument.load
		// throws EncryptedPDFError and Inkling never passes ignoreEncryption
		// — so this can only be reached by a file that acquired /Encrypt some
		// other way. Declining is still the right answer.
		doc.context.trailerInfo.Encrypt = PDFNumber.of(1);
		const result = classifyIncrementalSave(bytes, doc);
		expect(result.supported).toBe(false);
		if (result.supported) return;
		expect(result.reason).toMatch(/encrypt/i);
	});

	it('reaches a decision on a file that has already been updated once', async () => {
		// Not "takes the fast path": a chain of updates is legal and common,
		// and what matters is that the classifier answers rather than throws.
		const first = await classicTableBytes();
		const doc = await load(first);
		doc.addPage([612, 792]);
		const second = await doc.save({ useObjectStreams: false });
		const result = classifyIncrementalSave(second, await load(second));
		expect(typeof result.supported).toBe('boolean');
	});

	it('declines rather than throwing on bytes that are not a PDF at all', async () => {
		const bytes = new TextEncoder().encode('x'.repeat(4096));
		const result = classifyIncrementalSave(bytes, await load(await classicTableBytes()));
		expect(result.supported).toBe(false);
	});

	it('never throws, whatever it is handed', async () => {
		// The property the whole decline path rests on. A classifier that can
		// throw is a classifier that can take an open failure with it.
		const original = await classicTableBytes();
		const doc = await load(original);
		for (let cut = 0; cut < original.length; cut += 997) {
			expect(() => classifyIncrementalSave(original.subarray(0, cut), doc)).not.toThrow();
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pdf/incrementalClassify.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/incrementalClassify`.

- [ ] **Step 3: Write the implementation**

Create `src/pdf/incrementalClassify.ts`:

```ts
import { PDFDocument, PDFRef } from 'pdf-lib';
import { objectHeaderAt, scanLastXref, type XrefStyle } from './xrefScan';

// Whether this exact file can be safely appended to, decided once when it
// is opened and never revisited.
//
// The governing principle of the design this implements: incremental save
// is an optimization, and it must always be able to decline. A file we can
// confidently classify takes the fast path; one we cannot — for any reason,
// including reasons nobody has thought of yet — takes the existing
// full-rewrite path and is merely as slow as it is today. Declining is
// always correct and never loses data.
//
// That is what makes a book nobody has seen before safe. The plugin does
// not need to have met a structure; it needs to be able to tell that it has
// not.

export interface IncrementalCapability {
	supported: true;
	style: XrefStyle;
	// Where the file's last cross-reference section starts, which becomes
	// the /Prev of the first section we append.
	xrefOffset: number;
}

export interface IncrementalDecline {
	supported: false;
	reason: string;
}

export type IncrementalClassification = IncrementalCapability | IncrementalDecline;

function decline(reason: string): IncrementalDecline {
	return { supported: false, reason };
}

// Every in-use entry in a classic cross-reference table, checked against the
// object it claims to describe.
//
// This is the check that catches the failure pdf-lib is blind to. A table
// whose offsets are stale still opens here — the linear parse never looks
// at it — but appending a /Prev pointing into that chain hands a stricter
// reader a file it cannot follow. A table is plain text, so every entry can
// be verified for the price of one byte poke each.
function tableEntriesAreHonest(bytes: Uint8Array, offset: number): string | null {
	let cursor = offset;
	const text = (from: number, length: number): string => {
		let out = '';
		const stop = Math.min(from + length, bytes.length);
		for (let index = from; index < stop; index++) out += String.fromCharCode(bytes[index] ?? 0);
		return out;
	};

	const keyword = /^\s*xref\s*/.exec(text(cursor, 32));
	if (!keyword) return 'cross-reference table does not start with the xref keyword';
	cursor += keyword[0].length;

	let checked = 0;
	// Bounded: a section with more subsections than this is not a document
	// anyone is annotating, and an unbounded loop over malformed bytes is
	// how a classifier turns into a hang.
	for (let subsection = 0; subsection < 4096; subsection++) {
		const header = /^(\d+)\s+(\d+)\s*(?:\r\n|\r|\n)/.exec(text(cursor, 48));
		if (!header?.[1] || !header[2]) break;

		const firstObject = Number(header[1]);
		const count = Number(header[2]);
		if (!Number.isSafeInteger(count) || count < 0 || count > 5_000_000) return 'cross-reference subsection length is implausible';
		cursor += header[0].length;

		for (let index = 0; index < count; index++) {
			// Every entry is exactly 20 bytes: 10 of offset, a space, 5 of
			// generation, a space, one of f/n, and a two-byte terminator.
			const entry = text(cursor, 20);
			const parsed = /^(\d{10}) (\d{5}) ([fn])/.exec(entry);
			if (!parsed?.[1] || !parsed[2] || !parsed[3]) return 'cross-reference entry is malformed';
			cursor += 20;

			if (parsed[3] === 'f') continue;
			const entryOffset = Number(parsed[1]);
			const objectNumber = firstObject + index;
			// Object 0 is always the head of the free list; an in-use entry
			// for it is a broken table, not a document.
			if (objectNumber === 0) return 'cross-reference table marks object 0 as in use';

			const header2 = objectHeaderAt(bytes, entryOffset);
			if (!header2) return `cross-reference entry for object ${objectNumber} points at no object header`;
			if (header2.objectNumber !== objectNumber) {
				return `cross-reference entry for object ${objectNumber} points at object ${header2.objectNumber}`;
			}
			checked += 1;
		}
	}

	if (checked === 0) return 'cross-reference table describes no objects';
	return null;
}

// A cross-reference stream's own dictionary, checked for the fields a
// section we chain onto must have.
//
// Deliberately shallower than the table check above, and the asymmetry is
// worth stating rather than hiding. Real xref streams commonly carry
// /DecodeParms << /Predictor 12 … >>, and pdf-lib does not undo PNG
// predictors — it never reads a cross-reference stream at all — so checking
// the entries would mean implementing predictors here. What is checked
// instead is that the dictionary is a well-formed XRef dictionary and that
// it names the same catalog pdf-lib found by parsing the file. A stream
// describing a different document than the one in memory is the failure
// that matters, and /Root is the one field that can be cross-checked
// without decoding anything.
function streamDictionaryIsHonest(dictText: string, doc: PDFDocument): string | null {
	const widths = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dictText);
	if (!widths) return 'cross-reference stream has no /W field widths';
	if (!/\/Size\s+\d+/.test(dictText)) return 'cross-reference stream has no /Size';
	if (!/\/Length\s+\d+/.test(dictText) && !/\/Length\s+\d+\s+\d+\s+R/.test(dictText)) {
		return 'cross-reference stream has no /Length';
	}

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

		if (scan.style === 'table') {
			const fault = tableEntriesAreHonest(bytes, scan.offset);
			if (fault) return decline(fault);
		} else {
			const fault = streamDictionaryIsHonest(scan.trailerText, doc);
			if (fault) return decline(fault);
		}

		return { supported: true, style: scan.style, xrefOffset: scan.offset };
	} catch (error) {
		return decline(`classification threw: ${String(error)}`);
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/pdf/incrementalClassify.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run build && npm run lint
git add src/pdf/incrementalClassify.ts tests/pdf/incrementalClassify.test.ts
git commit -m "$(cat <<'EOF'
Let a file say for itself whether it can be appended to

The classifier is the whole safety story: anything it cannot confidently
place takes the full-rewrite path and is merely as slow as it is today.
It checks every entry of a classic table against the object that entry
claims to describe — the fault pdf-lib cannot see, because it never reads
a cross-reference table at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Recording what a save actually touched

The task most likely to produce a corrupt file if it is done carelessly, because pdf-lib mutates parsed objects **in place** and a mutation in place is invisible to any hook on the context.

Two mechanisms, each doing exactly one thing:

1. A wrapper around `PDFContext.register` / `assign` / `delete` catches every object created or freed.
2. `writeInklingAnnotations` reports the indirect containers it mutates in place, which nothing else can see.

**Files:**
- Create: `src/pdf/changeSet.ts`
- Modify: `src/pdf/annotationSync.ts`
- Test: `tests/pdf/changeSet.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ChangeSet { written: Set<PDFRef>; freed: Set<PDFRef> }`
  - `function recordChanges(context: PDFContext, mutate: (touch: TouchFn) => void): ChangeSet`
  - `type TouchFn = (ref: PDFRef) => void`
- Changes to `annotationSync.ts`, which later tasks call:
  - `writeInklingAnnotations(pdfDoc: PDFDocument, pageIndex: number, annotations: Annotation[], touch?: TouchFn): void`
  - `pruneOrphanedInklingAnnotations(pdfDoc: PDFDocument, touch?: TouchFn): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/changeSet.test.ts`:

```ts
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { recordChanges } from '../../src/pdf/changeSet';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { Annotation } from '../../src/annotate/types';

const stroke: Annotation = {
	id: 'ink-a',
	kind: 'stroke',
	tool: 'pen',
	color: '#e03131',
	width: 4,
	points: [
		{ x: 10, y: 10 },
		{ x: 100, y: 100 },
	],
};

async function sampleDoc(): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	// Round-tripped so the pages are *parsed* leaves, not ones pdf-lib built.
	// Only a parsed leaf has autoNormalizeCTM on, which is what makes the
	// first addAnnot rewrite /Contents and /Resources as well as /Annots.
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

describe('recordChanges', () => {
	it('records an object the mutation registered', async () => {
		const doc = await sampleDoc();
		const changes = recordChanges(doc.context, () => {
			doc.context.register(doc.context.obj({ Type: 'Test' }));
		});
		expect(changes.written.size).toBe(1);
		expect(changes.freed.size).toBe(0);
	});

	it('records an object the mutation freed', async () => {
		const doc = await sampleDoc();
		const ref = doc.context.register(doc.context.obj({ Type: 'Test' }));
		const changes = recordChanges(doc.context, () => {
			doc.context.delete(ref);
		});
		expect([...changes.freed]).toContain(ref);
		expect(changes.written.has(ref)).toBe(false);
	});

	it('treats an object created and freed in the same pass as freed only', async () => {
		// Every autosave rewrites a page's annotations as brand-new objects,
		// so a stroke drawn and erased between two saves is created and freed
		// inside one change set. Serializing it and marking it free in the
		// same section would be a contradiction in the file.
		const doc = await sampleDoc();
		const changes = recordChanges(doc.context, () => {
			const ref = doc.context.register(doc.context.obj({ Type: 'Test' }));
			doc.context.delete(ref);
		});
		expect(changes.written.size).toBe(0);
		expect(changes.freed.size).toBe(1);
	});

	it('restores the context when the mutation throws', async () => {
		// The recorder replaces three methods on a live context. Leaving them
		// replaced after a failure would silently attribute the *next* save's
		// objects to a change set nobody is reading.
		const doc = await sampleDoc();
		const before = doc.context.register;
		expect(() =>
			recordChanges(doc.context, () => {
				throw new Error('boom');
			}),
		).toThrow(/boom/);
		expect(doc.context.register).toBe(before);
	});

	it('collects the page and every container writing an annotation mutates', async () => {
		const doc = await sampleDoc();
		const page = doc.getPage(0);
		const changes = recordChanges(doc.context, (touch) => {
			writeInklingAnnotations(doc, 0, [stroke], touch);
		});

		// The page dict itself: /Annots, and — because a parsed leaf
		// normalizes on first mutation — /Contents and /Resources too.
		expect([...changes.written]).toContain(page.ref);

		// The annotation dict and its appearance stream, both brand new.
		expect(changes.written.size).toBeGreaterThanOrEqual(3);

		// And the property that actually matters: every object the change set
		// names still resolves. A ref recorded but deleted, or one recorded
		// from another context, would be serialized as garbage.
		for (const ref of changes.written) {
			expect(doc.context.lookup(ref)).toBeDefined();
		}
	});

	it('collects an indirect /Annots array mutated in place', async () => {
		// pdf-lib's addAnnot pushes onto the *array*, which is a separate
		// indirect object whenever the file stores it that way. Recording
		// only the page dict would leave the new annotation unreferenced by
		// anything a reader following the xref chain can see.
		const doc = await sampleDoc();
		const page = doc.getPage(0);
		const annotsRef = doc.context.register(doc.context.obj([]));
		page.node.set(PDFName.of('Annots'), annotsRef);

		const changes = recordChanges(doc.context, (touch) => {
			writeInklingAnnotations(doc, 0, [stroke], touch);
		});
		expect([...changes.written]).toContain(annotsRef);
	});

	it('collects an indirect /Resources dictionary normalize writes into', async () => {
		// normalize() sets /Font, /XObject and /ExtGState on the page's
		// Resources. When Resources is indirect — which is the common case in
		// a real book — that is a mutation of an object the page dict does
		// not contain.
		const doc = await sampleDoc();
		const page = doc.getPage(0);
		const resources = page.node.get(PDFName.of('Resources'));
		const resourcesRef =
			resources instanceof PDFRef ? resources : doc.context.register(doc.context.lookup(resources, PDFDict));
		page.node.set(PDFName.of('Resources'), resourcesRef);

		const changes = recordChanges(doc.context, (touch) => {
			writeInklingAnnotations(doc, 0, [stroke], touch);
		});
		expect([...changes.written]).toContain(resourcesRef);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pdf/changeSet.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/changeSet`.

- [ ] **Step 3: Write `src/pdf/changeSet.ts`**

```ts
import type { PDFContext, PDFObject, PDFRef } from 'pdf-lib';

// What one save actually changed, enumerated rather than discovered.
//
// An explicit change set is better than diffing pdf-lib's object graph
// because it cannot over-collect. A diff against the loaded model would
// flag every object pdf-lib normalised on parse, and appending those would
// reintroduce exactly the re-encoding risk the incremental path exists to
// remove: every byte before the appendix is meant to be the original file,
// untouched.
//
// Two mechanisms, because pdf-lib needs two. Objects it *creates* and
// *frees* go through PDFContext, so wrapping three of its methods sees all
// of them. Objects it mutates **in place** — a page dictionary gaining an
// /Annots entry, an /Annots array being pushed onto, a /Resources
// dictionary that normalize() writes /Font, /XObject and /ExtGState into —
// go through nothing at all, and the only code that knows they were touched
// is the code doing the touching. Hence `touch`.

export type TouchFn = (ref: PDFRef) => void;

export interface ChangeSet {
	// Objects to serialize into the appendix, in place of whatever the
	// original file said about them.
	written: Set<PDFRef>;
	// Objects to mark free in the appended cross-reference section. This
	// does not reclaim their bytes — an append-only format cannot remove
	// anything — it stops them being reachable. The bytes come back only at
	// compaction, which is why compaction is the plugin's only garbage
	// collector.
	freed: Set<PDFRef>;
}

export function recordChanges(context: PDFContext, mutate: (touch: TouchFn) => void): ChangeSet {
	const written = new Set<PDFRef>();
	const freed = new Set<PDFRef>();

	const realRegister = context.register.bind(context);
	const realAssign = context.assign.bind(context);
	const realDelete = context.delete.bind(context);

	const touch: TouchFn = (ref) => {
		// A ref freed earlier in the same pass and then touched again is a
		// contradiction we resolve in favour of "freed" below; recording it
		// here regardless keeps this function free of ordering rules.
		written.add(ref);
	};

	context.register = (object: PDFObject): PDFRef => {
		const ref = realRegister(object);
		written.add(ref);
		return ref;
	};
	context.assign = (ref: PDFRef, object: PDFObject): void => {
		realAssign(ref, object);
		written.add(ref);
	};
	context.delete = (ref: PDFRef): boolean => {
		const removed = realDelete(ref);
		if (removed) freed.add(ref);
		return removed;
	};

	try {
		mutate(touch);
	} finally {
		// Restored even when the mutation throws. Leaving the context wrapped
		// would silently attribute the next save's objects to a change set
		// nobody is reading, which is a corrupt append two saves later with
		// nothing to point at.
		context.register = realRegister;
		context.assign = realAssign;
		context.delete = realDelete;
	}

	// An object created and freed within one pass — a stroke drawn and
	// erased between two saves — must be one or the other, never both.
	// Freed wins: it is the later truth, and a section that both defines an
	// object and marks it free is a contradiction in the file.
	for (const ref of freed) written.delete(ref);

	return { written, freed };
}
```

- [ ] **Step 4: Teach `annotationSync.ts` to report its containers**

In `src/pdf/annotationSync.ts`, add the import at the top of the file (after the existing `pdf-lib` import):

```ts
import type { TouchFn } from './changeSet';
```

Add this helper immediately above `writeInklingAnnotations`:

```ts
// Reports every indirect object a page mutation writes into, which no hook
// on PDFContext can see because pdf-lib mutates parsed objects in place.
//
// Three slots matter, and all three are mutated by pdf-lib's own
// PDFPageLeaf.normalize(), which runs on the first addAnnot against a
// *parsed* page (PDFObjectParser builds page leaves with autoNormalizeCTM
// on, so this is every page in every real book):
//
//   /Annots     — pushed onto by addAnnot; a separate object when indirect.
//   /Resources  — normalize sets /Font, /XObject and /ExtGState into it,
//                 and in a real book it is usually indirect and sometimes
//                 shared with other pages through inheritance.
//   /Contents   — normalize wraps a single stream in an array and pushes
//                 the shared push/pop-graphics-state streams into it.
//
// Called before and after the mutation, and the union taken, because
// normalize can replace an indirect slot with a direct one: the object that
// used to be there still needs its free entry, and the page dict that now
// holds it inline still needs rewriting.
function touchPageContainers(pdfDoc: PDFDocument, page: PDFPage, touch: TouchFn): void {
	touch(page.ref);
	for (const key of ['Annots', 'Resources', 'Contents']) {
		const slot = page.node.get(PDFName.of(key));
		if (slot instanceof PDFRef) touch(slot);
	}
}
```

Replace the body of `writeInklingAnnotations` with:

```ts
export function writeInklingAnnotations(
	pdfDoc: PDFDocument,
	pageIndex: number,
	annotations: Annotation[],
	touch: TouchFn = () => undefined,
): void {
	const page = pdfDoc.getPage(pageIndex);
	touchPageContainers(pdfDoc, page, touch);
	removeInklingAnnotations(pdfDoc, page);
	for (const annotation of annotations) {
		if (annotation.kind === 'stroke') writeStroke(pdfDoc, page, annotation);
		else if (annotation.kind === 'note') writeNote(pdfDoc, page, annotation);
		else writeShape(pdfDoc, page, annotation);
	}
	// Again afterwards: normalize() may have replaced an indirect slot with
	// a direct one, or created the /Annots array that did not exist before.
	touchPageContainers(pdfDoc, page, touch);
}
```

Change `pruneOrphanedInklingAnnotations`'s signature and its page walk the same way — the prune unlinks nothing (it only frees objects already unreferenced), so it needs no container reporting, but it must accept the parameter so `openDocument` can record its deletions through the same recorder:

```ts
export function pruneOrphanedInklingAnnotations(pdfDoc: PDFDocument, touch: TouchFn = () => undefined): boolean {
```

and add, as the first line of its body:

```ts
	// Accepted but unused: the prune only frees objects no page links to, and
	// every one of those goes through context.delete, which the recorder sees
	// on its own. The parameter exists so callers can pass a recorder without
	// having to know that.
	void touch;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/pdf/changeSet.test.ts tests/pdf/annotationSync.test.ts tests/pdf/writeDocument.test.ts`
Expected: PASS. The two existing suites must still pass unchanged — `touch` defaults to a no-op precisely so every current caller is unaffected.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run build && npm run lint && npm test
git add src/pdf/changeSet.ts src/pdf/annotationSync.ts tests/pdf/changeSet.test.ts
git commit -m "$(cat <<'EOF'
Make the write path describe its own effects

pdf-lib mutates parsed objects in place, so a hook on PDFContext sees
every object created and freed and none of the ones changed. A page
gaining an annotation also rewrites its /Contents and /Resources, because
normalize() runs on the first mutation of a parsed leaf — that is three
containers a naive change set would miss and a reader following the xref
chain would then never see.

Worth having on its own terms, appender or no appender.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The appendix builder, classic cross-reference table

**Files:**
- Create: `src/pdf/appendUpdate.ts`
- Test: `tests/pdf/appendUpdate.test.ts`

**Interfaces:**
- Consumes: `ChangeSet` from `src/pdf/changeSet.ts` (Task 3), `XrefStyle` from `src/pdf/xrefScan.ts` (Task 1).
- Produces:
  - `interface UpdateOptions { context: PDFContext; changes: ChangeSet; style: XrefStyle; baseLength: number; prevXrefOffset: number; id: [PDFObject, PDFObject] }`
  - `function buildIncrementalUpdate(options: UpdateOptions): Uint8Array`
  - `function documentId(context: PDFContext, previous: [PDFObject, PDFObject] | null): [PDFObject, PDFObject]`

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/appendUpdate.test.ts`:

```ts
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildIncrementalUpdate, documentId } from '../../src/pdf/appendUpdate';
import { recordChanges } from '../../src/pdf/changeSet';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { classifyIncrementalSave } from '../../src/pdf/incrementalClassify';
import { toArrayBuffer } from '../../src/binary';
import type { Annotation } from '../../src/annotate/types';

const stroke: Annotation = {
	id: 'ink-a',
	kind: 'stroke',
	tool: 'pen',
	color: '#e03131',
	width: 4,
	points: [
		{ x: 10, y: 10 },
		{ x: 100, y: 100 },
	],
};

async function baseBytes(useObjectStreams: boolean): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	doc.setKeywords(['inkling:template=lined']);
	return doc.save({ useObjectStreams });
}

function concat(base: Uint8Array, appendix: Uint8Array): Uint8Array {
	const out = new Uint8Array(base.length + appendix.length);
	out.set(base, 0);
	out.set(appendix, base.length);
	return out;
}

// The whole exercise, end to end, for one cross-reference style.
async function appendOneStroke(useObjectStreams: boolean): Promise<{ base: Uint8Array; updated: Uint8Array }> {
	const base = await baseBytes(useObjectStreams);
	const doc = await PDFDocument.load(toArrayBuffer(base), { updateMetadata: false });
	const classification = classifyIncrementalSave(base, doc);
	if (!classification.supported) throw new Error(`fixture was declined: ${classification.reason}`);

	const changes = recordChanges(doc.context, (touch) => {
		writeInklingAnnotations(doc, 0, [stroke], touch);
	});

	const appendix = buildIncrementalUpdate({
		context: doc.context,
		changes,
		style: classification.style,
		baseLength: base.length,
		prevXrefOffset: classification.xrefOffset,
		id: documentId(doc.context, null),
	});

	return { base, updated: concat(base, appendix) };
}

describe('buildIncrementalUpdate, classic table', () => {
	it('leaves every original byte exactly where it was', async () => {
		// The strongest claim the incremental path makes, and the reason it
		// removes a class of risk rather than only saving time: pdf-lib
		// re-encodes nothing, because it never re-serializes the original.
		const { base, updated } = await appendOneStroke(false);
		expect(updated.subarray(0, base.length)).toEqual(base);
	});

	it('produces a file pdf-lib reads with the annotation on it', async () => {
		const { updated } = await appendOneStroke(false);
		const reloaded = await PDFDocument.load(toArrayBuffer(updated), { updateMetadata: false });
		expect(reloaded.getPageCount()).toBe(1);
		expect(reloaded.getKeywords()).toBe('inkling:template=lined');
		const annots = reloaded.getPage(0).node.Annots();
		expect(annots?.size()).toBe(1);
	});

	it('writes a cross-reference section the classifier will accept next time', async () => {
		// The property that makes a second append possible: our own output
		// has to pass the same gate the original file did, or the fast path
		// works exactly once per session.
		const { updated } = await appendOneStroke(false);
		const reloaded = await PDFDocument.load(toArrayBuffer(updated), { updateMetadata: false });
		const again = classifyIncrementalSave(updated, reloaded);
		expect(again.supported).toBe(true);
		if (!again.supported) return;
		expect(again.style).toBe('table');
	});

	it('chains /Prev to the section it was told about', async () => {
		const base = await baseBytes(false);
		const doc = await PDFDocument.load(toArrayBuffer(base), { updateMetadata: false });
		const classification = classifyIncrementalSave(base, doc);
		if (!classification.supported) throw new Error('fixture was declined');
		const changes = recordChanges(doc.context, (touch) => writeInklingAnnotations(doc, 0, [stroke], touch));
		const appendix = buildIncrementalUpdate({
			context: doc.context,
			changes,
			style: 'table',
			baseLength: base.length,
			prevXrefOffset: classification.xrefOffset,
			id: documentId(doc.context, null),
		});
		expect(new TextDecoder('latin1').decode(appendix)).toContain(`/Prev ${classification.xrefOffset}`);
	});

	it('marks a freed object free rather than pretending it never existed', async () => {
		// Erasing cannot remove bytes from an append-only file. Rewriting the
		// page's /Annots without the ref is enough for correctness; the free
		// entry is what stops the object being reachable at all.
		const base = await baseBytes(false);
		const doc = await PDFDocument.load(toArrayBuffer(base), { updateMetadata: false });
		recordChanges(doc.context, (touch) => writeInklingAnnotations(doc, 0, [stroke], touch));

		const second = recordChanges(doc.context, (touch) => writeInklingAnnotations(doc, 0, [], touch));
		expect(second.freed.size).toBeGreaterThan(0);

		const appendix = buildIncrementalUpdate({
			context: doc.context,
			changes: second,
			style: 'table',
			baseLength: base.length,
			prevXrefOffset: 0,
			id: documentId(doc.context, null),
		});
		expect(new TextDecoder('latin1').decode(appendix)).toMatch(/\d{10} \d{5} f/);
	});

	it('preserves the first half of /ID and regenerates the second', async () => {
		// What the two-element array is for. Preserving both, or regenerating
		// both, are different flavours of wrong: the first element is the
		// file's permanent identity, the second says which revision this is.
		const doc = await PDFDocument.load(toArrayBuffer(await baseBytes(false)), { updateMetadata: false });
		const first = documentId(doc.context, null);
		const second = documentId(doc.context, first);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pdf/appendUpdate.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/appendUpdate`.

- [ ] **Step 3: Write `src/pdf/appendUpdate.ts` with the classic writer only**

```ts
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
// where they now live, and a trailer chaining back to what was there
// before. Concatenated onto the original file, it makes a valid PDF whose
// first `baseLength` bytes are the original, byte for byte.
//
// A reader follows startxref to the newest cross-reference section and
// reads /Prev back through the chain, taking the most recent definition of
// each object. An object appearing twice is the mechanism working, not a
// corruption: the later one wins.
//
// Everything here is assembled from pdf-lib's own serialization
// primitives rather than reimplemented. PDFCrossRefSection, PDFCrossRefStream,
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
// already had — from its trailer if it has one, invented once if it does
// not. The second is regenerated on every update, which is the entire
// purpose of the array: it says "this is a different revision of the same
// file". Preserving both, or regenerating both, are different flavours of
// wrong.
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
	const lead = new Uint8Array([CharCodes.Newline]);
	const { placed, end } = placeObjects(context, changes, baseLength + lead.length);

	const xref = PDFCrossRefSection.createEmpty();
	// Entries must be added in ascending object number, and the freed ones
	// interleave with the written ones rather than following them.
	const entries: { ref: PDFRef; offset: number | null }[] = [
		...placed.map((item) => ({ ref: item.ref, offset: item.offset })),
		...[...changes.freed].map((ref) => ({ ref, offset: null })),
	].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);

	for (const entry of entries) {
		// nextFreeObjectNumber 0 ends the free list. Chaining freed entries
		// into a real linked list would let their object numbers be reused,
		// which we never do — every new object takes a fresh number from
		// context.nextRef(), whose counter reflects every object anywhere in
		// the file and so cannot collide.
		if (entry.offset === null) xref.addDeletedEntry(entry.ref, 0);
		else xref.addEntry(entry.ref, entry.offset);
	}

	const size = context.largestObjectNumber + 1;
	const xrefBytes = bytesOf(xref);
	const trailerDictBytes = bytesOf(PDFTrailerDict.of(context.obj(trailerFields(options, size))));
	const trailerBytes = bytesOf(PDFTrailer.forLastCrossRefSectionOffset(end));

	return concatChunks([
		lead,
		...placed.map((item) => item.bytes),
		xrefBytes,
		new Uint8Array([CharCodes.Newline]),
		trailerDictBytes,
		new Uint8Array([CharCodes.Newline]),
		trailerBytes,
		new Uint8Array([CharCodes.Newline]),
	]);
}

export function buildIncrementalUpdate(options: UpdateOptions): Uint8Array {
	if (options.style === 'table') return buildClassicUpdate(options);
	throw new Error('Inkling: the cross-reference stream writer is not built yet.');
}
```

Note on `trailerFields`: `context.obj()` drops `undefined` values, so a document with no `/Info` simply produces a trailer without one — which is legal and is what the original had.

- [ ] **Step 4: Run the classic tests to verify they pass**

Run: `npx vitest run tests/pdf/appendUpdate.test.ts -t "classic table"`
Expected: PASS, all six cases.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run build && npm run lint && npm test
git add src/pdf/appendUpdate.ts tests/pdf/appendUpdate.test.ts
git commit -m "$(cat <<'EOF'
Append a classic cross-reference section instead of rewriting a book

Every original byte stays exactly where it was, which is the strongest
thing this change buys: pdf-lib cannot quietly re-encode what it never
re-serializes. The section our own output writes has to pass the same
classifier gate the original did, or the fast path would work exactly
once per session — so that is a test, not an assumption.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The appendix builder, cross-reference stream

The style the largest books in the vault use — eleven of the twenty in the spec's spike. pdf-lib's `PDFCrossRefStream` already handles the `/W` field widths and the sparse `/Index` subsections an incremental section needs, so this is assembly rather than the binary-format work the spec anticipated.

**Files:**
- Modify: `src/pdf/appendUpdate.ts`
- Modify: `tests/pdf/appendUpdate.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `buildIncrementalUpdate` now handles `style: 'stream'`. No signature change.

- [ ] **Step 1: Write the failing test**

Append to `tests/pdf/appendUpdate.test.ts`:

```ts
describe('buildIncrementalUpdate, cross-reference stream', () => {
	it('leaves every original byte exactly where it was', async () => {
		const { base, updated } = await appendOneStroke(true);
		expect(updated.subarray(0, base.length)).toEqual(base);
	});

	it('produces a file pdf-lib reads with the annotation on it', async () => {
		const { updated } = await appendOneStroke(true);
		const reloaded = await PDFDocument.load(toArrayBuffer(updated), { updateMetadata: false });
		expect(reloaded.getPageCount()).toBe(1);
		expect(reloaded.getKeywords()).toBe('inkling:template=lined');
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
	});

	it('writes a section the classifier will accept next time', async () => {
		const { updated } = await appendOneStroke(true);
		const reloaded = await PDFDocument.load(toArrayBuffer(updated), { updateMetadata: false });
		const again = classifyIncrementalSave(updated, reloaded);
		expect(again.supported).toBe(true);
		if (!again.supported) return;
		expect(again.style).toBe('stream');
	});

	it('gives the cross-reference stream its own entry, at its own offset', async () => {
		// The one self-referential part of the format. A stream that does not
		// describe itself is one a reader cannot verify it found intact — and
		// pdf-lib will not notice, because it ignores cross-reference streams
		// entirely.
		const { base, updated } = await appendOneStroke(true);
		const text = new TextDecoder('latin1').decode(updated.subarray(base.length));
		const startxref = /startxref\s+(\d+)/.exec(text);
		expect(startxref?.[1]).toBeDefined();
		const offset = Number(startxref?.[1]);
		// startxref must name an offset inside the appendix, and what sits
		// there must be the XRef object itself.
		expect(offset).toBeGreaterThanOrEqual(base.length);
		const atOffset = new TextDecoder('latin1').decode(updated.subarray(offset, offset + 96));
		expect(atOffset).toMatch(/^\d+ 0 obj/);
		expect(atOffset).toContain('/XRef');
	});

	it('is read back correctly by pdf.js, which does follow the table', async () => {
		// pdf-lib is not a witness here: it never reads a cross-reference
		// section at all, so it will happily accept a stream we got wrong.
		// pdf.js resolves objects through the xref chain, so it is the first
		// reader that can actually disagree with us.
		const { updated } = await appendOneStroke(true);
		const { getDocument } = await import('pdfjs-dist');
		const pdf = await getDocument({ data: updated.slice(), useSystemFonts: false }).promise;
		expect(pdf.numPages).toBe(1);
		const page = await pdf.getPage(1);
		const annotations = await page.getAnnotations();
		expect(annotations.some((a: { subtype?: string }) => a.subtype === 'Ink')).toBe(true);
		await pdf.destroy();
	});

	it('is read back correctly by pdf.js after a classic-table append too', async () => {
		const { updated } = await appendOneStroke(false);
		const { getDocument } = await import('pdfjs-dist');
		const pdf = await getDocument({ data: updated.slice(), useSystemFonts: false }).promise;
		expect(pdf.numPages).toBe(1);
		const annotations = await (await pdf.getPage(1)).getAnnotations();
		expect(annotations.some((a: { subtype?: string }) => a.subtype === 'Ink')).toBe(true);
		await pdf.destroy();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pdf/appendUpdate.test.ts -t "cross-reference stream"`
Expected: FAIL — "the cross-reference stream writer is not built yet."

- [ ] **Step 3: Write the stream writer**

In `src/pdf/appendUpdate.ts`, add `PDFCrossRefStream` to the `pdf-lib` import list, then add this function above `buildIncrementalUpdate` and change that function's body.

```ts
function buildStreamUpdate(options: UpdateOptions): Uint8Array {
	const { context, changes, baseLength } = options;

	const lead = new Uint8Array([CharCodes.Newline]);
	const { placed, end } = placeObjects(context, changes, baseLength + lead.length);

	// The cross-reference stream is itself an indirect object and needs an
	// object number of its own. Taken from nextRef() rather than invented,
	// so it cannot collide with anything anywhere in the file:
	// largestObjectNumber is maintained across every assign during the
	// linear parse, including objects a cross-reference table marked free.
	// Taking a fresh one every save also means two appends never claim the
	// same number.
	const xrefRef = context.nextRef();
	const size = context.largestObjectNumber + 1;

	// PDFCrossRefStream.of, not .create: create() seeds the section with the
	// free entry for object 0, which belongs to the file's *first*
	// cross-reference section. An update section describes only what it
	// changed.
	const xrefStream = PDFCrossRefStream.of(context.obj(trailerFields(options, size)), []);

	// Ascending object number, freed entries interleaved — the same ordering
	// requirement the classic writer has.
	const entries: { ref: PDFRef; offset: number | null }[] = [
		...placed.map((item) => ({ ref: item.ref, offset: item.offset })),
		...[...changes.freed].map((ref) => ({ ref, offset: null })),
		{ ref: xrefRef, offset: end },
	].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);

	for (const entry of entries) {
		if (entry.offset === null) xrefStream.addDeletedEntry(entry.ref, 0);
		else xrefStream.addUncompressedEntry(entry.ref, entry.offset);
	}

	// Serialized last, and only once: /W, /Index and /Length are computed
	// from the entries by updateDict(), which copyBytesInto calls, so every
	// entry has to be in before a single byte is produced.
	const xrefBytes = serializeIndirectObject(xrefRef, xrefStream);
	const trailerBytes = bytesOf(PDFTrailer.forLastCrossRefSectionOffset(end));

	return concatChunks([
		lead,
		...placed.map((item) => item.bytes),
		xrefBytes,
		trailerBytes,
		new Uint8Array([CharCodes.Newline]),
	]);
}

export function buildIncrementalUpdate(options: UpdateOptions): Uint8Array {
	return options.style === 'table' ? buildClassicUpdate(options) : buildStreamUpdate(options);
}
```

Note the asymmetry with the classic path, which is correct and not an oversight: a cross-reference *stream* carries the trailer fields in its own dictionary, so there is no separate `trailer <<…>>` section — only `startxref`, the offset, and `%%EOF`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/pdf/appendUpdate.test.ts`
Expected: PASS, every case in both describes.

If the pdf.js cases fail while pdf-lib's pass, that is the failure mode the spec predicted — pdf-lib is not a witness — and the fault is in the stream, not the test.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run build && npm run lint && npm test
git add src/pdf/appendUpdate.ts tests/pdf/appendUpdate.test.ts
git commit -m "$(cat <<'EOF'
Write the cross-reference style the largest books actually use

Eleven of twenty books in the vault use xref streams, and the spec called
this the bulk of the work. It is not: pdf-lib's own PDFCrossRefStream is
exported and already computes the /W field widths and the sparse /Index an
update section needs.

Checked against pdf.js rather than pdf-lib. pdf-lib never reads a
cross-reference section at all, so it would accept a stream we got wrong.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Compaction, and the save that verifies before it writes

Two pieces that belong in one task because neither is testable without the other: the rule that decides when an appendix has grown past its worth, and the orchestration that turns a change set into either an appendix or a full rewrite.

The correction that matters most in the spec lands here. The current path verifies *after* producing bytes and before handing them to the vault, which works because a full write is a replacement — declining costs nothing. **An append has no such property: Obsidian's API has no truncate.** So verification moves ahead of the write, onto a buffer that has not touched the disk.

**Files:**
- Create: `src/pdf/compaction.ts`
- Create: `src/pdf/incrementalSave.ts`
- Test: `tests/pdf/compaction.test.ts`
- Test: `tests/pdf/incrementalSave.test.ts`

**Interfaces:**
- Consumes: `buildIncrementalUpdate`, `documentId` (Tasks 4–5); `recordChanges` (Task 3); `classifyIncrementalSave` (Task 2); `fingerprintDocument`, `compareFingerprints` (existing).
- Produces:
  - `function shouldCompact(originalSize: number, appendedBytes: number): boolean`
  - `interface IncrementalSession { classification: IncrementalClassification; baseBytes: Uint8Array; xrefOffset: number; id: [PDFObject, PDFObject] | null; appendedBytes: number; pending: Uint8Array | null; carriedFreed: Set<PDFRef>; disabled: string | null }`
  - `function beginIncrementalSession(bytes: Uint8Array, doc: PDFDocument, carriedFreed?: Set<PDFRef>): IncrementalSession`
  - `type SaveOutcome = { mode: 'append'; appendix: Uint8Array; baseLength: number } | { mode: 'full'; bytes: Uint8Array }`
  - `async function saveIncrementally(doc, session, mutate): Promise<SaveOutcome>`
  - `function commitAppend(session: IncrementalSession): void`
  - `function abandonIncremental(session: IncrementalSession, reason: string): void`

- [ ] **Step 1: Write the compaction test**

Create `tests/pdf/compaction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldCompact } from '../../src/pdf/compaction';

const MB = 1024 * 1024;

describe('shouldCompact', () => {
	it('lets a small appendix on a large book keep going', () => {
		expect(shouldCompact(40 * MB, 512 * 1024)).toBe(false);
	});

	it('compacts a small file once the appendix is a fifth of it', () => {
		// The percentage is what stops a small PDF doubling over a long
		// session.
		expect(shouldCompact(1 * MB, 205 * 1024)).toBe(true);
		expect(shouldCompact(1 * MB, 200 * 1024)).toBe(false);
	});

	it('caps a large book with an absolute ceiling, not a percentage', () => {
		// Whichever is *smaller*. A percentage alone scales the wrong way as
		// the library grows: 20% of a future 200 MB book would be 40 MB of
		// appendix before anything compacted.
		expect(shouldCompact(200 * MB, 9 * MB)).toBe(true);
		expect(shouldCompact(200 * MB, 7 * MB)).toBe(false);
	});

	it('treats a size it cannot read as a reason to compact', () => {
		// Erring toward a full rewrite costs time; erring the other way
		// risks appending onto a base we do not understand.
		expect(shouldCompact(Number.NaN, 1024)).toBe(true);
	});
});
```

- [ ] **Step 2: Write `src/pdf/compaction.ts`**

```ts
// When an accumulated appendix has grown past its worth.
//
// Appending forever makes a file that grows monotonically. Nothing breaks,
// but a long annotation session on a small PDF could double it — and
// erasing is worse than drawing, because an append-only format cannot
// remove anything: an erased annotation's dictionary and appearance stream
// stay in the file, merely marked free and unreachable.
//
// The bytes come back only here. **Compaction is the plugin's only garbage
// collector**, which is more than tidying: an eraser-heavy session is the
// case that reaches this rule first and the one its thresholds should be
// measured against.
//
// Both numbers are still guesses and should be checked against a real
// session before they are treated as settled.
const MB = 1024 * 1024;
const APPENDIX_FRACTION = 0.2;
const APPENDIX_CEILING_BYTES = 8 * MB;

export function shouldCompact(originalSize: number, appendedBytes: number): boolean {
	if (!Number.isFinite(originalSize) || originalSize <= 0) return true;
	// Whichever is smaller. The absolute ceiling stops a big book
	// accumulating a big appendix; the percentage stops a small one
	// compacting constantly.
	const budget = Math.min(originalSize * APPENDIX_FRACTION, APPENDIX_CEILING_BYTES);
	return appendedBytes > budget;
}
```

- [ ] **Step 3: Write the orchestration test**

Create `tests/pdf/incrementalSave.test.ts`:

```ts
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import {
	abandonIncremental,
	beginIncrementalSession,
	commitAppend,
	saveIncrementally,
} from '../../src/pdf/incrementalSave';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { toArrayBuffer } from '../../src/binary';
import type { Annotation } from '../../src/annotate/types';

function strokeAt(id: string, x: number): Annotation {
	return {
		id,
		kind: 'stroke',
		tool: 'pen',
		color: '#e03131',
		width: 4,
		points: [
			{ x, y: 10 },
			{ x: x + 40, y: 90 },
		],
	};
}

async function fixture(useObjectStreams = false): Promise<{ bytes: Uint8Array; doc: PDFDocument }> {
	const source = await PDFDocument.create();
	const font = await source.embedFont(StandardFonts.Helvetica);
	source.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	source.setKeywords(['inkling:template=lined']);
	const bytes = await source.save({ useObjectStreams });
	return { bytes, doc: await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false }) };
}

function concat(base: Uint8Array, appendix: Uint8Array): Uint8Array {
	const out = new Uint8Array(base.length + appendix.length);
	out.set(base, 0);
	out.set(appendix, base.length);
	return out;
}

describe('saveIncrementally', () => {
	it('appends on a classifiable file and the result reloads', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		const outcome = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));

		expect(outcome.mode).toBe('append');
		if (outcome.mode !== 'append') return;
		expect(outcome.baseLength).toBe(bytes.length);

		const updated = concat(bytes, outcome.appendix);
		const reloaded = await PDFDocument.load(toArrayBuffer(updated), { updateMetadata: false });
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
	});

	it('chains a second append onto the first', async () => {
		// The property a session depends on: /Prev has to follow our own
		// previous section, not the original file's, from the second save on.
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);

		const first = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));
		if (first.mode !== 'append') throw new Error('expected an append');
		commitAppend(session);

		const second = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10), strokeAt('ink-b', 200)], touch),
		);
		if (second.mode !== 'append') throw new Error('expected a second append');
		expect(second.baseLength).toBe(bytes.length + first.appendix.length);

		const updated = concat(concat(bytes, first.appendix), second.appendix);
		const reloaded = await PDFDocument.load(toArrayBuffer(updated), { updateMetadata: false });
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);
	});

	it('falls back to a full rewrite when the file cannot be classified', async () => {
		const { bytes, doc } = await fixture();
		const broken = new TextEncoder().encode(new TextDecoder('latin1').decode(bytes).replace(/startxref\n\d+/, 'startxref\n17'));
		const session = beginIncrementalSession(broken, doc);
		const outcome = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));

		expect(outcome.mode).toBe('full');
		if (outcome.mode !== 'full') return;
		// A full rewrite is a whole file, header and all.
		expect(new TextDecoder('latin1').decode(outcome.bytes.subarray(0, 5))).toBe('%PDF-');
	});

	it('verifies the concatenation before it hands anything back', async () => {
		// The correction that matters most in the design. A full write is a
		// replacement, so declining costs nothing; an append cannot be undone,
		// because Obsidian's API has no truncate. So the check moves ahead of
		// the write, onto a buffer that has not touched the disk.
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);

		const realLoad = PDFDocument.load.bind(PDFDocument);
		const spy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (...args: Parameters<typeof realLoad>) => {
			const parsed = await realLoad(...args);
			parsed.setKeywords(['tampered']);
			return parsed;
		});
		try {
			const outcome = await saveIncrementally(doc, session, (touch) =>
				writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
			);
			// Not a rejection: a failed verification is a decline, and a
			// decline is a full rewrite. The user's ink is never the thing
			// that gets dropped.
			expect(outcome.mode).toBe('full');
		} finally {
			spy.mockRestore();
		}
	});

	it('stops trying to append once a session has been abandoned', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		abandonIncremental(session, 'the append did not land');

		const outcome = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));
		expect(outcome.mode).toBe('full');
	});

	it('compacts once the appendix has grown past its worth', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		// Past both thresholds for a fixture this size.
		session.appendedBytes = bytes.length;

		const outcome = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));
		expect(outcome.mode).toBe('full');
	});

	it('returns to appending after a compaction, against the compacted file', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		session.appendedBytes = bytes.length;

		const compacted = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));
		if (compacted.mode !== 'full') throw new Error('expected a compaction');
		commitAppend(session);

		const next = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10), strokeAt('ink-b', 200)], touch),
		);
		expect(next.mode).toBe('append');
		if (next.mode !== 'append') return;
		expect(next.baseLength).toBe(compacted.bytes.length);
	});

	it('carries a prune that happened before any save into the first change set', async () => {
		// Opening a file the user only means to read must not modify it, so
		// the orphan prune runs in memory at open and is carried by whatever
		// save happens next. On this path "carried" has to mean free entries
		// in the first appended section — otherwise the prune achieves
		// nothing and a file bloated by past sessions never shrinks.
		const { bytes, doc } = await fixture();
		const orphan = doc.context.register(doc.context.obj({ Type: 'Annot' }));
		doc.context.delete(orphan);

		const session = beginIncrementalSession(bytes, doc, new Set([orphan]));
		const outcome = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));
		if (outcome.mode !== 'append') throw new Error('expected an append');

		expect(new TextDecoder('latin1').decode(outcome.appendix)).toMatch(/\d{10} \d{5} f/);
		expect(session.carriedFreed.size).toBe(0);
	});

	it('works the same way on a file that uses cross-reference streams', async () => {
		const { bytes, doc } = await fixture(true);
		const session = beginIncrementalSession(bytes, doc);
		const outcome = await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));
		expect(outcome.mode).toBe('append');
	});
});
```

- [ ] **Step 4: Write `src/pdf/incrementalSave.ts`**

```ts
import { PDFDocument, type PDFObject, type PDFRef } from 'pdf-lib';
import { toArrayBuffer } from '../binary';
import { buildIncrementalUpdate, documentId } from './appendUpdate';
import { recordChanges, type TouchFn } from './changeSet';
import { classifyIncrementalSave, type IncrementalClassification } from './incrementalClassify';
import { shouldCompact } from './compaction';
import { compareFingerprints, fingerprintDocument, type DocumentFingerprint } from './fingerprint';

// Everything one editing session needs to keep appending to one file.
//
// Held across saves rather than rebuilt, for two reasons that are really
// one: the pdf-lib context must not be reset between appends, because
// nextRef() draws from a counter that reflects every object anywhere in the
// file and is the only thing stopping an object number collision; and the
// base bytes have to stay in step with what is actually on disk, because an
// append built against the wrong base produces a corrupt PDF rather than a
// lost edit.
export interface IncrementalSession {
	classification: IncrementalClassification;
	// The bytes currently on disk, as far as this session knows. Advanced
	// only by commitAppend, never optimistically.
	baseBytes: Uint8Array;
	// Offset of the newest cross-reference section in baseBytes, which is
	// the /Prev of the next one.
	xrefOffset: number;
	id: [PDFObject, PDFObject] | null;
	// How much appendix has accumulated since the last full write, which is
	// what the compaction rule is measured against.
	appendedBytes: number;
	// Built but not yet known to be on disk. commitAppend folds it into
	// baseBytes; abandonIncremental throws it away.
	pending: Uint8Array | null;
	// Objects freed before any save happened — what
	// pruneOrphanedInklingAnnotations removed when the file was opened.
	// Opening a file the user only means to read must not modify it, so that
	// prune is carried by whatever save happens next rather than triggering
	// one of its own; on the incremental path "carried" means these refs
	// join the first change set and get their free entries there.
	carriedFreed: Set<PDFRef>;
	// Once set, this session never appends again — it has lost track of what
	// is on disk, and a full rewrite is always correct.
	disabled: string | null;
}

export type SaveOutcome =
	| { mode: 'append'; appendix: Uint8Array; baseLength: number }
	| { mode: 'full'; bytes: Uint8Array };

export function beginIncrementalSession(
	bytes: Uint8Array,
	doc: PDFDocument,
	carriedFreed: Set<PDFRef> = new Set(),
): IncrementalSession {
	const classification = classifyIncrementalSave(bytes, doc);
	return {
		classification,
		baseBytes: bytes,
		xrefOffset: classification.supported ? classification.xrefOffset : 0,
		id: null,
		appendedBytes: 0,
		pending: null,
		carriedFreed,
		// A file the classifier declined is not "disabled" — disabled means
		// something went wrong mid-session. Both take the full path; keeping
		// them apart keeps the log honest about which happened.
		disabled: null,
	};
}

// Called after the write actually landed. Nothing else may advance the
// session's idea of what is on disk.
export function commitAppend(session: IncrementalSession): void {
	const pending = session.pending;
	session.pending = null;
	if (!pending) return;

	if (pending.length === 0) return;
	// A full rewrite arrives here too, as a replacement rather than an
	// extension: it is flagged by having been stored whole.
	session.baseBytes = pending;
}

// Give up the fast path for the rest of this session.
//
// Logged once per file per session, never per save, and never surfaced to
// the user. From the outside this is a save that takes as long as it used
// to.
function declineOnce(session: IncrementalSession, reason: string): void {
	if (session.disabled) return;
	session.disabled = reason;
	console.warn(`Inkling: incremental save is off for this file — ${reason}`);
}

// The view's entry point, for a write that failed after the appendix was
// built. Discarding `pending` is the part that matters: the session must
// not advance its idea of what is on disk for a write that may not have
// landed.
export function abandonIncremental(session: IncrementalSession, reason: string): void {
	session.pending = null;
	declineOnce(session, reason);
}

async function fullSave(doc: PDFDocument, session: IncrementalSession, intended: DocumentFingerprint): Promise<SaveOutcome> {
	const bytes = await doc.save();

	// The existing guard, unchanged: reparsing the bytes we are about to hand
	// back is what makes a silent pdf-lib fault loud.
	const written = await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
	const difference = compareFingerprints(intended, fingerprintDocument(written));
	if (difference) throw new Error(`Inkling: refusing to save, the PDF changed unexpectedly (${difference}).`);

	// A compaction collapses the chain, so the next append starts over
	// against these bytes and this file's new last section. A full save also
	// discharges the carried prune: the objects it freed are simply not in
	// the file it just wrote.
	session.pending = bytes;
	session.appendedBytes = 0;
	session.carriedFreed.clear();
	const rescan = classifyIncrementalSave(bytes, written);
	session.classification = rescan;
	session.xrefOffset = rescan.supported ? rescan.xrefOffset : 0;
	return { mode: 'full', bytes };
}

// One save. Mutates the document under the recorder, then either appends
// what changed or rewrites the whole file — and the caller cannot tell
// which it will get until it asks.
export async function saveIncrementally(
	doc: PDFDocument,
	session: IncrementalSession,
	mutate: (touch: TouchFn) => void,
): Promise<SaveOutcome> {
	// Recorded whatever path is taken: the change set costs nothing to
	// collect and the decision below can go either way.
	const changes = recordChanges(doc.context, mutate);

	// The prune that ran when the file was opened freed objects before any
	// change set existed. They belong to the first save that actually
	// happens, which is this one — without them the appended section would
	// leave orphans from past sessions reachable, and the prune would have
	// achieved nothing on this path.
	for (const ref of session.carriedFreed) {
		changes.written.delete(ref);
		changes.freed.add(ref);
	}

	// Fingerprinted *after* the mutation, because the mutated document is
	// the intended result — the thing the produced bytes are supposed to
	// equal. Our own annotations are excluded, so having just rewritten them
	// does not register as a change.
	const intended = fingerprintDocument(doc);

	if (session.disabled || !session.classification.supported) {
		if (!session.disabled && !session.classification.supported) {
			declineOnce(session, session.classification.reason);
		}
		return fullSave(doc, session, intended);
	}

	if (shouldCompact(session.baseBytes.length, session.appendedBytes)) {
		// Not a decline: the fast path stays available, and the next save
		// after this one appends again against the compacted file.
		return fullSave(doc, session, intended);
	}

	const id = documentId(doc.context, session.id);
	let appendix: Uint8Array;
	try {
		appendix = buildIncrementalUpdate({
			context: doc.context,
			changes,
			style: session.classification.style,
			baseLength: session.baseBytes.length,
			prevXrefOffset: session.xrefOffset,
			id,
		});
	} catch (error) {
		declineOnce(session, `building the update failed: ${String(error)}`);
		return fullSave(doc, session, intended);
	}

	// Verification, in memory, before anything is written.
	//
	// The current path verifies after producing bytes and before handing
	// them to the vault, which works because a full write is a replacement:
	// declining to perform it costs nothing. An append has no such property.
	// Obsidian's API has no truncate, so once bytes are on the end of the
	// file, undoing them means rewriting the whole document — the exact cost
	// this exists to avoid, incurred on the failure path, on a file that is
	// invalid at that moment.
	//
	// This parse is O(document) where the write and the upload are
	// O(change), and that is the trade the design accepted: it runs in the
	// writer worker, on the document the worker already holds, so none of it
	// blocks the pen.
	const candidate = new Uint8Array(session.baseBytes.length + appendix.length);
	candidate.set(session.baseBytes, 0);
	candidate.set(appendix, session.baseBytes.length);

	try {
		const reparsed = await PDFDocument.load(toArrayBuffer(candidate), { updateMetadata: false });
		const difference = compareFingerprints(intended, fingerprintDocument(reparsed));
		if (difference) {
			declineOnce(session, `the appended file did not verify (${difference})`);
			return fullSave(doc, session, intended);
		}
	} catch (error) {
		declineOnce(session, `the appended file did not parse: ${String(error)}`);
		return fullSave(doc, session, intended);
	}

	session.id = id;
	session.pending = candidate;
	session.appendedBytes += appendix.length;
	// Discharged: the section just built carries their free entries.
	session.carriedFreed.clear();
	// The section we just wrote becomes the /Prev of the next one. Its
	// offset is the end of the appendix minus the trailer, which
	// buildIncrementalUpdate does not report — so it is recomputed from the
	// candidate the same way the classifier would read it, which also proves
	// our own output is readable by the gate.
	const rescan = classifyIncrementalSave(candidate, doc);
	if (!rescan.supported) {
		declineOnce(session, `our own appended section did not classify (${rescan.reason})`);
		session.pending = null;
		session.appendedBytes -= appendix.length;
		return fullSave(doc, session, intended);
	}
	session.xrefOffset = rescan.xrefOffset;

	return { mode: 'append', appendix, baseLength: session.baseBytes.length };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/pdf/compaction.test.ts tests/pdf/incrementalSave.test.ts`
Expected: PASS, every case.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run build && npm run lint && npm test
git add src/pdf/compaction.ts src/pdf/incrementalSave.ts tests/pdf/compaction.test.ts tests/pdf/incrementalSave.test.ts
git commit -m "$(cat <<'EOF'
Verify an append before writing it, because it cannot be taken back

A full write is a replacement, so declining to perform one costs nothing.
An append has no such property — Obsidian's API has no truncate — so the
verification moves ahead of the write, onto a buffer that never touches
the disk. A failure is a decline to a full rewrite, never a lost stroke.

Compaction comes with it, and it is doing more than tidying an appendix:
an append-only file cannot remove anything, so this is the plugin's only
garbage collector, and an eraser-heavy session is what reaches it first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `writeBinarySafely` gains an append mode

`vaultWrite.ts` is the single chokepoint every binary write goes through, and both of its guards assume a replacement. Neither survives an append unchanged: the after-write size check compares against the bytes written, which for an append is *original + appended*, and `looksLikePdf` cannot apply to an appendix that does not start with `%PDF-`.

**Files:**
- Modify: `src/vaultWrite.ts`
- Modify: `tests/vaultWrite.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `function canAppendBinary(vault: unknown): boolean`
  - `interface BinaryAppendTarget<F> { appendBinary?(file: F, data: ArrayBuffer): Promise<void>; adapter: Pick<DataAdapter, 'stat'> }`
  - `async function appendBinarySafely<F extends { path: string }>(vault, file, appendix: ArrayBuffer, baseLength: number): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `tests/vaultWrite.test.ts`:

```ts
import { appendBinarySafely, canAppendBinary, type BinaryAppendTarget } from '../src/vaultWrite';

function appendix(text = 'body\nstartxref\n9\n%%EOF\n'): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

// A vault that actually holds a file's length, because every guard in the
// append path is about whether that length is what we think it is.
function fakeAppendVault(options: { size: number; withAppend?: boolean; sizeAfter?: (before: number, added: number) => number }) {
	let size = options.size;
	const appended: ArrayBuffer[] = [];
	const vault: BinaryAppendTarget<{ path: string }> & { appended: ArrayBuffer[] } = {
		appended,
		adapter: {
			stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size })),
		},
	};
	if (options.withAppend !== false) {
		vault.appendBinary = vi.fn(async (_file: { path: string }, data: ArrayBuffer) => {
			appended.push(data);
			size = options.sizeAfter ? options.sizeAfter(size, data.byteLength) : size + data.byteLength;
		});
	}
	return vault;
}

describe('canAppendBinary', () => {
	it('detects the API when it is there', () => {
		expect(canAppendBinary(fakeAppendVault({ size: 100 }))).toBe(true);
	});

	it('reports its absence rather than throwing', () => {
		// minAppVersion is 1.4.4 and appendBinary is @since 1.12.3, so this
		// is a real case for anyone but the author.
		expect(canAppendBinary(fakeAppendVault({ size: 100, withAppend: false }))).toBe(false);
	});
});

describe('appendBinarySafely', () => {
	it('appends when the file is exactly the length we based the update on', async () => {
		const vault = fakeAppendVault({ size: 1024 });
		await appendBinarySafely(vault, file, appendix(), 1024);
		expect(vault.appended).toHaveLength(1);
	});

	it('refuses when the file changed size since it was read', async () => {
		// The one place incremental save is *more* dangerous than what it
		// replaces. An append onto a file sync moved underneath us produces
		// a corrupt PDF, where a full rewrite would merely lose the other
		// edit — so this check is load-bearing, not defensive.
		const vault = fakeAppendVault({ size: 2048 });
		await expect(appendBinarySafely(vault, file, appendix(), 1024)).rejects.toThrow(/changed/);
		expect(vault.appended).toHaveLength(0);
	});

	it('refuses an appendix that does not end at a PDF end-of-file marker', async () => {
		// looksLikePdf cannot apply to something that does not start with
		// %PDF-, so this is what replaces it: an appendix that does not end
		// in %%EOF is not an update section, whatever else it is.
		const vault = fakeAppendVault({ size: 1024 });
		await expect(appendBinarySafely(vault, file, appendix('nothing useful\n'), 1024)).rejects.toThrow(/%%EOF/);
		expect(vault.appended).toHaveLength(0);
	});

	it('refuses an empty appendix', async () => {
		const vault = fakeAppendVault({ size: 1024 });
		await expect(appendBinarySafely(vault, file, new ArrayBuffer(0), 1024)).rejects.toThrow();
		expect(vault.appended).toHaveLength(0);
	});

	it('reports an append that was cut short', async () => {
		// Same failure the replacement path guards against — the app killed
		// mid-write, which mobile OSes do aggressively — and the same way of
		// noticing, except the expected size is base plus appendix.
		const vault = fakeAppendVault({ size: 1024, sizeAfter: (before, added) => before + Math.floor(added / 2) });
		await expect(appendBinarySafely(vault, file, appendix(), 1024)).rejects.toThrow(/did not complete/);
	});

	it('refuses outright when the API is missing', async () => {
		const vault = fakeAppendVault({ size: 1024, withAppend: false });
		await expect(appendBinarySafely(vault, file, appendix(), 1024)).rejects.toThrow(/appendBinary/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/vaultWrite.test.ts`
Expected: FAIL — `appendBinarySafely` is not exported.

- [ ] **Step 3: Extend `src/vaultWrite.ts`**

Append to the file:

```ts
// The append path's own version of the two guards above, because neither
// survives unchanged.
//
// `looksLikePdf` cannot apply to an appendix: an update section does not
// start with `%PDF-`. What replaces it is the other end — an appendix that
// does not finish at `%%EOF` is not an update section, whatever else it is.
//
// And the after-write size check has to be told the base length, because
// for an append the expected size is *original + appended* rather than the
// number of bytes handed over.
//
// The check with no counterpart in the replacement path is the one before
// the write. **An append onto a file that changed since we read it produces
// a corrupt PDF**, where a full rewrite would merely lose the other change.
// That is the single place incremental save is more dangerous than what it
// replaces, and it is a live risk in a Self-hosted LiveSync vault. On a
// mismatch the correct action is not to retry — it is to fall back to a
// full rewrite from a fresh read, which is what the caller does.
const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%%EOF"

// The trailing bytes an appendix may have after %%EOF. A newline, or a
// newline pair, and nothing more — enough slack for a line terminator
// without admitting a buffer that merely contains the marker somewhere.
const EOF_TRAILING_SLACK = 4;

export interface BinaryAppendTarget<F> {
	appendBinary?(file: F, data: ArrayBuffer): Promise<void>;
	adapter: Pick<DataAdapter, 'stat'>;
}

// Vault.appendBinary is @since 1.12.3 and manifest.json's minAppVersion is
// 1.4.4, so its absence is a case that has to be handled rather than
// assumed away. Not having it is not a failure: it means this vault takes
// the full-rewrite path, exactly as it does today.
export function canAppendBinary(vault: unknown): boolean {
	return typeof (vault as { appendBinary?: unknown } | null)?.appendBinary === 'function';
}

export function looksLikeUpdateSection(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < EOF_MARKER.length) return false;
	const tail = new Uint8Array(bytes, Math.max(0, bytes.byteLength - EOF_MARKER.length - EOF_TRAILING_SLACK));
	for (let start = tail.length - EOF_MARKER.length; start >= 0; start--) {
		if (EOF_MARKER.every((byte, index) => tail[start + index] === byte)) return true;
	}
	return false;
}

export async function appendBinarySafely<F extends { path: string }>(
	vault: BinaryAppendTarget<F>,
	file: F,
	appendix: ArrayBuffer,
	baseLength: number,
): Promise<void> {
	if (!canAppendBinary(vault)) {
		throw new Error(`Inkling: this version of Obsidian has no Vault.appendBinary, so ${file.path} cannot be updated in place.`);
	}
	if (!looksLikeUpdateSection(appendix)) {
		throw new Error(`Inkling: refusing to append ${appendix.byteLength} bytes to ${file.path} — that does not end at %%EOF.`);
	}

	// Before, and this is the load-bearing one. stat rather than a re-read:
	// a length that still matches is what says the update we built is still
	// an update to *this* file.
	const before = await vault.adapter.stat(file.path);
	if (before && before.size !== baseLength) {
		throw new Error(
			`Inkling: ${file.path} is ${before.size} bytes where the update was built against ${baseLength} — it changed underneath us.`,
		);
	}

	await vault.appendBinary?.(file, appendix);

	const expected = baseLength + appendix.byteLength;
	const after = await vault.adapter.stat(file.path);
	if (after && after.size !== expected) {
		throw new Error(`Inkling: ${file.path} is ${after.size} bytes after appending to ${expected} — the write did not complete.`);
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/vaultWrite.test.ts`
Expected: PASS, both the existing replacement cases and the new append ones.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run build && npm run lint && npm test
git add src/vaultWrite.ts tests/vaultWrite.test.ts
git commit -m "$(cat <<'EOF'
Guard an append, which needs different guards than a replacement

An appendix does not start with %PDF-, so the header check is replaced by
the other end of the section. The size check has to be told the base
length, since the expected size is original plus appended.

And one check has no counterpart at all: an append onto a file sync moved
underneath us corrupts it, where a full rewrite would only lose the other
edit. That comparison happens immediately before the write and is the
reason this path can be trusted in a replicating vault.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Wiring it through the worker and the view

The payoff, and it must be last: the throttle is what currently limits the blast radius of a bad save, and it should not come down until everything under it has been proven.

The write reply becomes a discriminated result, and two new messages carry the acknowledgement the session needs. That acknowledgement is not optional bookkeeping: the worker's `baseBytes` must match what is on disk, and only the view knows whether the write landed. A worker that advanced its base optimistically would build the *next* append onto bytes that were never written — the corrupt-file case, reached by our own hand.

**Files:**
- Modify: `src/pdf/annotationWriterCore.ts`
- Modify: `src/pdf/annotationWriterProtocol.ts`
- Modify: `src/pdf/annotationWriter.worker.ts`
- Modify: `src/pdf/annotationWriterClient.ts`
- Modify: `src/pdf/saveCadence.ts`
- Modify: `src/pdfView.ts`
- Modify: `tests/pdf/saveCadence.test.ts`

**Interfaces:**
- Consumes: `beginIncrementalSession`, `saveIncrementally`, `commitAppend`, `abandonIncremental`, `SaveOutcome` (Task 6); `appendBinarySafely`, `canAppendBinary` (Task 7).
- Produces:
  - `OpenedDocument` gains `incremental: boolean` and `session: IncrementalSession`.
  - `OpenResult` gains `incremental: boolean`.
  - `AnnotationWriterClient.write(pages): Promise<WriteOutcome>` where `WriteOutcome = { mode: 'full'; bytes: ArrayBuffer } | { mode: 'append'; appendix: ArrayBuffer; baseLength: number }`.
  - `AnnotationWriterClient.commit(): Promise<void>` and `AnnotationWriterClient.abandon(reason: string): Promise<void>`.
  - `maxWriteIntervalMs(fileSizeBytes: number, incremental?: boolean): number`.

- [ ] **Step 1: Write the failing cadence test**

Append to `tests/pdf/saveCadence.test.ts`:

```ts
describe('maxWriteIntervalMs on the incremental path', () => {
	it('stops scaling with file size once the write is O(change)', () => {
		// The throttle exists because every write re-serializes the whole
		// document *and re-uploads the whole binary through a replicating
		// vault*. An append makes both of those the size of the change, so
		// the ceiling comes down to what worker CPU will bear rather than to
		// what 40 MB of I/O will bear.
		const MB = 1024 * 1024;
		expect(maxWriteIntervalMs(40 * MB, true)).toBe(10_000);
		expect(maxWriteIntervalMs(40 * MB, false)).toBe(60_000);
	});

	it('leaves the size-scaled ceiling alone for a file that declined', () => {
		const MB = 1024 * 1024;
		expect(maxWriteIntervalMs(10 * MB)).toBe(30_000);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/pdf/saveCadence.test.ts`
Expected: FAIL — the second argument is ignored, so the first assertion returns 60000.

- [ ] **Step 3: Update `src/pdf/saveCadence.ts`**

Replace the function, keeping the existing comment block above it and adding to it:

```ts
// **The incremental path changes what this is measuring.** When a file is on
// the fast path an autosave appends only the objects that changed: the disk
// write and the sync upload are the size of the edit, not the size of the
// book, and the only thing still scaling with the document is the
// verification parse — which runs in the writer worker and never blocks the
// pen. So the ceiling stops tracking file size and becomes the shortest one
// we use, which with the 1.5 s trailing debounce puts the worst case a crash
// can cost at about a second of handwriting instead of up to a minute.
export function maxWriteIntervalMs(fileSizeBytes: number, incremental = false): number {
	const MB = 1024 * 1024;
	if (incremental) return 10_000;
	// A size we can't read is treated as small: erring toward saving more
	// often risks bandwidth, erring the other way risks the user's ink.
	if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 5 * MB) return 10_000;
	if (fileSizeBytes <= 25 * MB) return 30_000;
	return 60_000;
}
```

- [ ] **Step 4: Give the writer core an incremental mode**

In `src/pdf/annotationWriterCore.ts`:

Add the imports:

```ts
import { beginIncrementalSession, commitAppend, abandonIncremental, saveIncrementally, type IncrementalSession, type SaveOutcome } from './incrementalSave';
```

Add two fields to `OpenedDocument`:

```ts
	// The append state for this file, held for the life of the editing
	// session. See incrementalSave.ts for why it cannot be rebuilt per save.
	session: IncrementalSession;
	// Whether this file took the fast path, for the view's save cadence.
	incremental: boolean;
```

In `openDocument`, capture what the orphan prune freed, then classify before returning.

Change the existing prune call — whose return value is currently ignored — to run under the recorder, so the objects it removed can be carried into the first save's change set. Add `import { recordChanges } from './changeSet';` and replace the `pruneOrphanedInklingAnnotations(doc);` line with:

```ts
	// Run under the recorder rather than bare. The prune frees orphans left
	// by sessions from before deleteAnnotationObjects existed, and on the
	// incremental path those objects need free entries in the first section
	// we append — otherwise the prune corrects the in-memory document and
	// leaves the file exactly as bloated as it was.
	const pruned = recordChanges(doc.context, () => {
		pruneOrphanedInklingAnnotations(doc);
	});
```

Replace the `return` at the end of `openDocument` with:

```ts
	// A view over the caller's buffer, not a copy. `bytes` came in over
	// postMessage and nothing else retains it once this returns —
	// displayBytes above is either its own slice or a fresh save — so a
	// second copy would be 40 MB of a large book held for nothing. This is
	// the reference that has to stay in step with what is on disk.
	const session = beginIncrementalSession(new Uint8Array(bytes), doc, pruned.freed);
	if (!session.classification.supported) {
		// Once per file per session, never per save, and never surfaced to
		// the user: from the outside this is a save that takes as long as it
		// used to.
		console.info(`Inkling: incremental save is unavailable for this file — ${session.classification.reason}`);
	}

	return {
		doc,
		savedAnnotations,
		displayBytes,
		profile: profileFromPdfLib(doc),
		risky: riskyFeatures(doc),
		session,
		incremental: session.classification.supported,
	};
```

Replace `writeDocument` entirely:

```ts
// One save, which may be an append or a full rewrite — and the caller is
// told which rather than being allowed to assume.
//
// Verification has moved inside saveIncrementally, ahead of the write,
// because an append cannot be undone: Obsidian's API has no truncate, so
// bytes on the end of the file stay there. The same fingerprint comparison
// runs either way; what changed is only *when*.
export async function writeDocument(
	doc: PDFDocument,
	session: IncrementalSession,
	pages: { pageNumber: number; annotations: Annotation[] }[],
): Promise<SaveOutcome> {
	return saveIncrementally(doc, session, (touch) => {
		for (const { pageNumber, annotations } of pages) {
			writeInklingAnnotations(doc, pageNumber - 1, annotations, touch);
		}
	});
}

export { commitAppend, abandonIncremental };
```

- [ ] **Step 5: Update the protocol**

In `src/pdf/annotationWriterProtocol.ts`:

```ts
export interface CommitRequestMessage {
	type: 'commit';
	requestId: number;
}

export interface AbandonRequestMessage {
	type: 'abandon';
	requestId: number;
	reason: string;
}

export type WorkerRequestMessage = OpenRequestMessage | WriteRequestMessage | CommitRequestMessage | AbandonRequestMessage;
```

Add `incremental: boolean` to `OpenedOk`. Replace `WrittenOk` with:

```ts
// Discriminated, because the two outcomes go to different Vault calls and
// there must be no path where the view has to guess which it got.
interface WrittenOk {
	type: 'written';
	requestId: number;
	ok: true;
	outcome: { mode: 'full'; bytes: ArrayBuffer } | { mode: 'append'; appendix: ArrayBuffer; baseLength: number };
}

// The acknowledgement the session needs. The worker's idea of what is on
// disk may only advance once the write has actually landed — a worker that
// advanced it optimistically would build the *next* append onto bytes that
// were never written, which is the corrupt-file case reached by our own
// hand.
interface AcknowledgedOk {
	type: 'acknowledged';
	requestId: number;
	ok: true;
}
```

and add both to the union, widening `RequestFailed`'s `type` to `'opened' | 'written' | 'acknowledged'`.

- [ ] **Step 6: Update the worker**

In `src/pdf/annotationWriter.worker.ts`, widen the imports and hold the session alongside the document:

```ts
import { abandonIncremental, commitAppend, openDocument, toArrayBuffer, writeDocument } from './annotationWriterCore';
import type { IncrementalSession } from './incrementalSave';

let doc: PDFDocument | null = null;
let session: IncrementalSession | null = null;
```

(`toArrayBuffer` is already exported from `annotationWriterCore.ts`; `commitAppend` and `abandonIncremental` are re-exported from it in Step 4, so the worker keeps importing all of its work from one module.)

In the `open` branch, set `session = opened.session` and include `incremental: opened.incremental` in the reply.

Replace the write branch and add the new ones:

```ts
	if (!doc || !session) {
		reply({ type: 'written', requestId: message.requestId, ok: false, error: 'Inkling: no document open in the annotation writer.' });
		return;
	}

	if (message.type === 'commit') {
		commitAppend(session);
		reply({ type: 'acknowledged', requestId: message.requestId, ok: true });
		return;
	}

	if (message.type === 'abandon') {
		abandonIncremental(session, message.reason);
		reply({ type: 'acknowledged', requestId: message.requestId, ok: true });
		return;
	}

	try {
		const outcome = await writeDocument(doc, session, message.pages);
		// Transferred, not copied: a full rewrite of a large book is the
		// whole file, and structured-cloning it would cost as much as the
		// save. An appendix is small enough that it hardly matters, but the
		// two paths transfer alike so neither can drift.
		const payload =
			outcome.mode === 'full'
				? { mode: 'full' as const, bytes: toArrayBuffer(outcome.bytes) }
				: { mode: 'append' as const, appendix: toArrayBuffer(outcome.appendix), baseLength: outcome.baseLength };
		const transfer = payload.mode === 'full' ? [payload.bytes] : [payload.appendix];
		reply({ type: 'written', requestId: message.requestId, ok: true, outcome: payload }, transfer);
	} catch (error) {
		reply({ type: 'written', requestId: message.requestId, ok: false, error: String(error) });
	}
```

- [ ] **Step 7: Update the client**

In `src/pdf/annotationWriterClient.ts`:

- Add `incremental: boolean` to `OpenResult`, and carry it through both the worker reply handler and the main-thread branch of `open`.
- Hold `private mainSession: IncrementalSession | null = null` beside `mainDoc`, set in `open`'s main-thread branch, cleared in `terminate`.
- Change `write` to return the outcome type and add `commit` / `abandon`:

```ts
export type WriteOutcome =
	| { mode: 'full'; bytes: ArrayBuffer }
	| { mode: 'append'; appendix: ArrayBuffer; baseLength: number };

	async write(pages: WritePage[]): Promise<WriteOutcome> {
		if (this.terminated) throw new Error('Inkling: annotation writer is no longer usable.');

		if ((await this.ensureMode()) === 'main') {
			if (!this.mainDoc || !this.mainSession) throw new Error('Inkling: no document open in the annotation writer.');
			const outcome = await writeDocument(this.mainDoc, this.mainSession, pages);
			return outcome.mode === 'full'
				? { mode: 'full', bytes: toArrayBuffer(outcome.bytes) }
				: { mode: 'append', appendix: toArrayBuffer(outcome.appendix), baseLength: outcome.baseLength };
		}

		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<WriteOutcome>(requestId);
		this.worker?.postMessage({ type: 'write', requestId, pages });
		return promise;
	}

	// Told only after the write has actually landed. Nothing else may
	// advance the session's idea of what is on disk.
	async commit(): Promise<void> {
		if (this.terminated) return;
		if ((await this.ensureMode()) === 'main') {
			if (this.mainSession) commitAppend(this.mainSession);
			return;
		}
		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<void>(requestId);
		this.worker?.postMessage({ type: 'commit', requestId });
		return promise;
	}

	// After a write that failed, or one whose outcome we cannot vouch for.
	// The session stops appending for good and every later save is a full
	// rewrite, which is always correct.
	async abandon(reason: string): Promise<void> {
		if (this.terminated) return;
		if ((await this.ensureMode()) === 'main') {
			if (this.mainSession) abandonIncremental(this.mainSession, reason);
			return;
		}
		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<void>(requestId);
		this.worker?.postMessage({ type: 'abandon', requestId, reason });
		return promise;
	}
```

- In `handleMessage`, resolve `'written'` with `message.outcome` and `'acknowledged'` with `undefined`.

- [ ] **Step 8: Route the outcome in the view**

In `src/pdfView.ts`:

Import `appendBinarySafely` and `canAppendBinary` alongside `writeBinarySafely`.

In `onLoadFile`, take the incremental flag from the open result and fold it into the cadence — `appendBinary` must be feature-detected against the *actual* vault, not assumed:

```ts
			risky = opened.risky;
			// The API is @since 1.12.3 against a minAppVersion of 1.4.4, so a
			// vault without it simply takes the path it takes today.
			incremental = opened.incremental && canAppendBinary(this.app.vault);
```

with `let incremental = false;` declared beside `risky`, and after the try/catch:

```ts
		this.maxWriteInterval = maxWriteIntervalMs(
			this.getSettings().saveCadence === 'frequent' ? 0 : file.stat.size,
			incremental,
		);
```

The existing `this.maxWriteInterval = …` line before `readBinary` must be **removed**, because the answer is not known until the file has been classified. Set `this.maxWriteInterval = maxWriteIntervalMs(0)` there instead, so a load that fails before classification still has the shortest interval rather than a stale one from the previous file.

Replace the write in `flushAnnotations`:

```ts
			const outcome = await this.writer.write(pages);
			if (outcome.mode === 'append') {
				try {
					await appendBinarySafely(this.app.vault, file, outcome.appendix, outcome.baseLength);
				} catch (error) {
					// An append that did not land — most likely because sync
					// moved the file underneath us — must never be retried as
					// an append: the next one would be built on a base that is
					// not what is on disk. The session gives the fast path up
					// and the work stays dirty for a full rewrite to carry.
					await this.writer.abandon(String(error));
					throw error;
				}
			} else {
				await writeBinarySafely(this.app.vault, file, outcome.bytes);
			}
			await this.writer.commit();
			this.consecutiveWriteFailures = 0;
```

- [ ] **Step 9: Update `tests/pdf/writeDocument.test.ts` for the new signature**

`writeDocument` now takes a session and returns an outcome rather than a buffer, and the fixture there is a classifiable file, so its saves come back as appends. The suite's existing guarantees do not change — a refusal is still a rejection and never a resolve with suspect bytes — but what gets reloaded is the concatenation.

Add to the imports and helpers at the top of that file:

```ts
import { beginIncrementalSession } from '../../src/pdf/incrementalSave';

// Whatever the writer decided, as a whole file. Both outcomes have to
// reload into the same document; which one came back is the writer's
// business, not this suite's.
async function wholeFile(opened: { session: { baseBytes: Uint8Array } }, outcome: Awaited<ReturnType<typeof writeDocument>>): Promise<ArrayBuffer> {
	if (outcome.mode === 'full') return toArrayBuffer(outcome.bytes);
	const base = opened.session.baseBytes;
	const out = new Uint8Array(base.length + outcome.appendix.length);
	out.set(base, 0);
	out.set(outcome.appendix, base.length);
	return toArrayBuffer(out);
}
```

Then change the three call sites. The first becomes:

```ts
	it('writes annotations and returns bytes that reload', async () => {
		const opened = await openDocument(await sampleBytes());
		const outcome = await writeDocument(opened.doc, opened.session, [{ pageNumber: 1, annotations: [stroke] }]);

		const reloaded = await PDFDocument.load(await wholeFile(opened, outcome), { updateMetadata: false });
		expect(reloaded.getPageCount()).toBe(1);
		expect(reloaded.getKeywords()).toBe('inkling:template=lined');
	});

	it('allows a structural change the caller made on purpose', async () => {
		const opened = await openDocument(await sampleBytes());

		// The boundary the guard has to get right. Verification compares the
		// produced bytes against the document as it stood *after* the
		// caller's edits, not against the file as it was opened — so adding a
		// page (which "Add page" genuinely does) has to pass. Fingerprint the
		// original instead and every legitimate page insert is refused.
		opened.doc.addPage([612, 792]);
		const outcome = await writeDocument(opened.doc, opened.session, [{ pageNumber: 1, annotations: [stroke] }]);
		expect((await PDFDocument.load(await wholeFile(opened, outcome), { updateMetadata: false })).getPageCount()).toBe(2);
	});
```

The two rejection cases need one change each in kind, not just in shape. They mock `PDFDocument.load` to corrupt the verification reparse — which on the incremental path is now a *decline*, not a rejection, because a failed verification falls back to a full rewrite. The full rewrite's own reparse is mocked too, so it still rejects; assert that, and assert the decline was recorded:

```ts
	it('rejects instead of returning bytes when the reparse disagrees', async () => {
		const opened = await openDocument(await sampleBytes());

		// The fault this guard exists for is one we cannot trigger on demand:
		// pdf-lib emitting bytes that reparse into a structurally different
		// document. Intercepting the verification reparse and handing it a
		// document with a page missing is the only honest way to exercise the
		// guard itself rather than something adjacent to it.
		//
		// On the incremental path this is caught twice over: the append's
		// in-memory verification declines to a full rewrite, and the full
		// rewrite's own reparse — mocked the same way — refuses outright.
		const realLoad = PDFDocument.load.bind(PDFDocument);
		const spy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (...args: Parameters<typeof realLoad>) => {
			const parsed = await realLoad(...args);
			parsed.removePage(0);
			return parsed;
		});
		try {
			await expect(writeDocument(opened.doc, opened.session, [{ pageNumber: 1, annotations: [stroke] }])).rejects.toThrow(/page count/);
			expect(opened.session.disabled).toMatch(/did not verify/);
		} finally {
			spy.mockRestore();
		}
	});

	it('leaves the caller nothing to write when it refuses', async () => {
		// The property the view depends on: a refusal is a rejection, never a
		// resolve with suspect bytes. There is no path where a caller gets
		// something back and has to decide whether to trust it.
		const opened = await openDocument(await sampleBytes());
		const realLoad = PDFDocument.load.bind(PDFDocument);
		const spy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (...args: Parameters<typeof realLoad>) => {
			const parsed = await realLoad(...args);
			parsed.setKeywords(['tampered']);
			return parsed;
		});
		try {
			await expect(writeDocument(opened.doc, opened.session, [{ pageNumber: 1, annotations: [stroke] }])).rejects.toThrow(/keywords/);
		} finally {
			spy.mockRestore();
		}
	});
```

Add one case that did not exist before, because the outcome is now something the caller has to branch on:

```ts
	it('appends rather than rewriting a file it can classify', async () => {
		const opened = await openDocument(await sampleBytes());
		const outcome = await writeDocument(opened.doc, opened.session, [{ pageNumber: 1, annotations: [stroke] }]);
		expect(outcome.mode).toBe('append');
		if (outcome.mode !== 'append') return;
		// The claim the whole item rests on: what reaches the disk is the
		// size of the edit, not the size of the book.
		expect(outcome.appendix.length).toBeLessThan(opened.session.baseBytes.length);
	});
```

- [ ] **Step 9b: Run the whole suite**

Run: `npm test`
Expected: PASS, every suite.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npm run build && npm run lint && npm test
git add src/pdf src/pdfView.ts tests/pdf
git commit -m "$(cat <<'EOF'
Take the throttle down, now that a save is the size of the change

The ceiling scaled with file size because every write re-serialized the
whole document and re-uploaded the whole binary. An append does neither,
so it comes down to the shortest interval we use — with the trailing
debounce that puts a crash at about a second of handwriting instead of a
minute.

The worker's idea of what is on disk advances only on an explicit commit
from the view. Advancing it optimistically would build the next append
onto bytes that were never written, which is the corrupt-file case
reached by our own hand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The opt-in check against a real library

The generated fixtures pin the structural classes. What they cannot answer is how many files in a library actually take the fast path — and that answer changes as the library grows, which is exactly why it has to be a check that keeps running rather than a number written down once.

**Files:**
- Create: `tests/pdf/vaultLibrary.test.ts`

**Interfaces:**
- Consumes: `classifyIncrementalSave` (Task 2).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the check**

Create `tests/pdf/vaultLibrary.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { classifyIncrementalSave } from '../../src/pdf/incrementalClassify';
import { toArrayBuffer } from '../../src/binary';

// Opt-in, because a suite that depends on the user's library cannot run in
// CI, depends on files not in the repository, and changes meaning every
// time a book is added or removed. Point it at one and it answers the only
// question the generated fixtures cannot:
//
//   INKLING_PDF_LIBRARY=/path/to/vault npx vitest run tests/pdf/vaultLibrary.test.ts
//
// What it checks is *total coverage*, not a decline rate. A library where
// every file declines is a disappointing result, not a failing test — the
// failure worth catching is a file the classifier cannot reach a decision
// about at all, because that is the case the whole decline path exists to
// make impossible.
const library = process.env.INKLING_PDF_LIBRARY;

function pdfsUnder(root: string, found: string[] = []): string[] {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) pdfsUnder(path, found);
		else if (entry.name.toLowerCase().endsWith('.pdf')) found.push(path);
	}
	return found;
}

describe.skipIf(!library)('the classifier against a real library', () => {
	it('reaches a decision on every PDF it finds, without throwing', async () => {
		const files = pdfsUnder(library ?? '');
		expect(files.length).toBeGreaterThan(0);

		const declined: string[] = [];
		let supported = 0;

		for (const path of files) {
			const bytes = new Uint8Array(readFileSync(path));
			let doc: PDFDocument;
			try {
				doc = await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
			} catch {
				// A book Inkling cannot open for annotation either — encrypted,
				// most likely. Not this module's problem.
				continue;
			}

			const result = classifyIncrementalSave(bytes, doc);
			if (result.supported) supported += 1;
			else declined.push(`${path} — ${result.reason}`);
			// Cheap, and worth asserting per file rather than in aggregate:
			// a size mismatch here would mean the classifier read a file it
			// was not handed.
			expect(statSync(path).size).toBe(bytes.length);
		}

		// Printed rather than asserted on. The rate is information about the
		// library, not a property of the code.
		console.info(`Inkling: ${supported} of ${supported + declined.length} files take the fast path.`);
		for (const line of declined) console.info(`  declined: ${line}`);
	}, 300_000);
});
```

- [ ] **Step 2: Run it both ways**

Run: `npx vitest run tests/pdf/vaultLibrary.test.ts`
Expected: PASS, reported as skipped — no `INKLING_PDF_LIBRARY` set.

Then, against the real vault:

```bash
INKLING_PDF_LIBRARY="$HOME/Obsidian/YourVault" npx vitest run tests/pdf/vaultLibrary.test.ts
```

Expected: PASS, with a line naming how many files take the fast path. The spec's spike measured 10% declined, both hybrid `/XRefStm` files; a materially worse rate is a reason to revisit the item, not to relax the classifier.

- [ ] **Step 3: Commit**

```bash
npm run build && npm run lint && npm test
git add tests/pdf/vaultLibrary.test.ts
git commit -m "$(cat <<'EOF'
Keep asking what is actually in a library

The generated fixtures pin the structural classes; only a real library can
say how many files take the fast path, and that answer changes as the
library grows. Opt-in, and it checks total coverage rather than a decline
rate — a library where everything declines is a disappointing result, not
a failing test. A file the classifier cannot decide about at all is the
failure worth catching.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## What this plan does not do, and why

- **The external-reader check is not automated.** The spec asks that a written xref stream be read back by pdf.js, Obsidian's own viewer, and one external reader. Tasks 4 and 5 automate the first; the other two are a manual check against a real annotated book before this ships, because neither can be driven from vitest. Do it — pdf-lib is not a witness, and a stream we got wrong is exactly the failure it cannot see.
- **The compaction thresholds are still guesses.** 20% or 8 MB, whichever is smaller. The spec asks for them to be measured against an eraser-heavy session; the rule is isolated in `compaction.ts` with one pure function so that measurement changes two numbers and nothing else.
- **No backup or scratch copy is written.** The vault syncs through Self-hosted LiveSync, where any in-vault copy costs database size and bandwidth on every device.
