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
