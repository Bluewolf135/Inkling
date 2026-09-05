import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { openDocument, toArrayBuffer, writeDocument } from '../../src/pdf/annotationWriterCore';
import type { Annotation } from '../../src/annotate/types';

const stroke: Annotation = {
	id: 'ink-a',
	kind: 'stroke',
	tool: 'pen',
	color: '#e03131',
	width: 4,
	points: [{ x: 10, y: 10 }, { x: 100, y: 100 }],
};

async function sampleBytes(): Promise<ArrayBuffer> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	doc.setKeywords(['inkling:template=lined']);
	return toArrayBuffer(await doc.save());
}

describe('writeDocument', () => {
	it('writes annotations and returns bytes that reload', async () => {
		const opened = await openDocument(await sampleBytes());
		const bytes = await writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }]);

		const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
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
		const bytes = await writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }]);
		expect((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()).toBe(2);
	});

	it('rejects instead of returning bytes when the reparse disagrees', async () => {
		const opened = await openDocument(await sampleBytes());

		// The fault this guard exists for is one we cannot trigger on demand:
		// pdf-lib emitting bytes that reparse into a structurally different
		// document. Intercepting the verification reparse and handing it a
		// document with a page missing is the only honest way to exercise the
		// guard itself rather than something adjacent to it.
		const realLoad = PDFDocument.load.bind(PDFDocument);
		const spy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (...args: Parameters<typeof realLoad>) => {
			const parsed = await realLoad(...args);
			parsed.removePage(0);
			return parsed;
		});
		try {
			await expect(writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }])).rejects.toThrow(/page count/);
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
			await expect(writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }])).rejects.toThrow(/keywords/);
		} finally {
			spy.mockRestore();
		}
	});
});
