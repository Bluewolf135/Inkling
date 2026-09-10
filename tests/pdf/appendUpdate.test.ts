import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildIncrementalUpdate, documentId, reserveObjectNumbers } from '../../src/pdf/appendUpdate';
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
	// Before anything is allocated — see reserveObjectNumbers.
	reserveObjectNumbers(doc.context, classification.declaredSize);

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
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
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
			prevXrefOffset: 1,
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
		const startxref = /startxref\s+(\d+)/.exec(new TextDecoder('latin1').decode(updated.subarray(base.length)));
		expect(startxref?.[1]).toBeDefined();

		const offset = Number(startxref?.[1]);
		expect(offset).toBeGreaterThanOrEqual(base.length);
		// To `stream`, not a fixed window: /ID alone is about seventy
		// characters, so a short window can miss /Type entirely and report a
		// fault that is only the test's own myopia.
		const atOffset = new TextDecoder('latin1').decode(updated.subarray(offset)).split('stream')[0] ?? '';
		expect(atOffset).toMatch(/^\d+ 0 obj/);
		expect(atOffset).toContain('/Type /XRef');
		expect(atOffset).toContain('/W [');
	});

	it('never numbers a new object over one the original file already uses', async () => {
		// The defect this exists for, found by pdf.js and invisible to
		// pdf-lib. pdf-lib's parser handles a cross-reference stream through
		// PDFXRefStreamParser and never assigns it into the context, so
		// largestObjectNumber came back as 6 on a file whose own /Size says 9
		// — and the next annotation was numbered 8, the object number the
		// original file uses for its cross-reference stream. The appended
		// definition replaced it, pdf-lib read the result happily, and pdf.js
		// said "Invalid Root reference".
		const base = await baseBytes(true);
		const doc = await PDFDocument.load(toArrayBuffer(base), { updateMetadata: false });
		const classification = classifyIncrementalSave(base, doc);
		if (!classification.supported) throw new Error('fixture was declined');

		expect(doc.context.largestObjectNumber).toBeLessThan(classification.declaredSize - 1);
		reserveObjectNumbers(doc.context, classification.declaredSize);

		const changes = recordChanges(doc.context, (touch) => writeInklingAnnotations(doc, 0, [stroke], touch));
		const lowest = Math.min(...[...changes.written].map((ref) => ref.objectNumber));
		// The page being rewritten is legitimately an existing object; every
		// *new* object has to sit above everything the file already claims.
		const brandNew = [...changes.written].filter((ref) => ref.objectNumber !== doc.getPage(0).ref.objectNumber);
		for (const ref of brandNew) expect(ref.objectNumber).toBeGreaterThanOrEqual(classification.declaredSize);
		expect(lowest).toBeGreaterThan(0);
	});

	it('is read back correctly by pdf.js, which does follow the table', async () => {
		// pdf-lib is not a witness here: it never reads a cross-reference
		// section at all, so it will happily accept a stream we got wrong.
		// pdf.js resolves objects through the xref chain, so it is the first
		// reader that can actually disagree with us.
		const { updated } = await appendOneStroke(true);
		const { getDocument } = await import('pdfjs-dist');
		const pdf = await getDocument({ data: updated.slice() }).promise;
		expect(pdf.numPages).toBe(1);
		const annotations = await (await pdf.getPage(1)).getAnnotations();
		expect(annotations.some((a: { subtype?: string }) => a.subtype === 'Ink')).toBe(true);
		await pdf.destroy();
	});

	it('is read back correctly by pdf.js after a classic-table append too', async () => {
		const { updated } = await appendOneStroke(false);
		const { getDocument } = await import('pdfjs-dist');
		const pdf = await getDocument({ data: updated.slice() }).promise;
		expect(pdf.numPages).toBe(1);
		const annotations = await (await pdf.getPage(1)).getAnnotations();
		expect(annotations.some((a: { subtype?: string }) => a.subtype === 'Ink')).toBe(true);
		await pdf.destroy();
	});
});
