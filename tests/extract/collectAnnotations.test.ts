import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { collectAnnotations } from '../../src/extract/extract';

// Fixtures are generated here rather than committed as binaries, the same
// way the annotationSync tests do it, so the repo holds no opaque test data.
const TEXT = 'Chapter 1: Setting Up Your Python Environment';

// A page carrying one line of real text, plus one annotation of `subtype`
// whose rectangle sits directly over that text. That overlap is the whole
// point: extraction recovers a quote from the words under an annotation, so
// an annotation type that is not markup — a link especially — otherwise
// comes back looking exactly like a highlight of whatever it covers.
async function pageWithAnnotation(subtype: string, extra: Record<string, unknown> = {}): Promise<ArrayBuffer> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText(TEXT, { x: 50, y: 700, size: 12, font });

	const dict = doc.context.obj({
		Type: 'Annot',
		Subtype: subtype,
		Rect: [40, 690, 400, 716],
		F: 4,
		...extra,
	});
	const ref = doc.context.register(dict);
	page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));

	const bytes = await doc.save();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('collectAnnotations', () => {
	// The reported bug: a book with no highlights in it produced a full
	// annotations note. Its table of contents is 201 link annotations, and
	// each one sits on the text it links from.
	it('ignores a link annotation sitting over text', async () => {
		expect(await collectAnnotations(await pageWithAnnotation('Link'))).toEqual([]);
	});

	it('ignores a form field', async () => {
		expect(await collectAnnotations(await pageWithAnnotation('Widget'))).toEqual([]);
	});

	it('ignores a popup', async () => {
		expect(await collectAnnotations(await pageWithAnnotation('Popup'))).toEqual([]);
	});

	// The other half of the boundary: filtering must not throw away the
	// annotations extraction exists for, including the subtypes Inkling
	// itself writes (Ink, Text, Line, Square, Circle — see pdf/annotationSync.ts).
	it('keeps a square, which is what Inkling writes for a rectangle', async () => {
		const found = await collectAnnotations(await pageWithAnnotation('Square'));
		expect(found).toHaveLength(1);
		expect(found[0]?.quote).toContain('Setting Up Your Python Environment');
	});

	it('keeps a highlight made in other PDF software', async () => {
		// QuadPoints and not just a Rect: pdf.js discards a Highlight without
		// them, so a fixture missing them tests nothing at all.
		const found = await collectAnnotations(
			await pageWithAnnotation('Highlight', { QuadPoints: [40, 716, 400, 716, 40, 690, 400, 690] }),
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.foreign).toBe(true);
	});

	it('keeps a sticky note for its contents even with no text under it', async () => {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		// PDFString, not a bare JS string: context.obj turns a string into a
		// PDFName, which writes /Contents /look here — not a text string at
		// all, and pdf.js reads it back as empty.
		const dict = doc.context.obj({
			Type: 'Annot',
			Subtype: 'Text',
			Rect: [40, 100, 60, 120],
			Contents: PDFString.of('look here'),
		});
		page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(dict)]));
		const bytes = await doc.save();
		const found = await collectAnnotations(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		expect(found).toHaveLength(1);
		expect(found[0]?.note).toBe('look here');
	});
});
