import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { StrokeAnnotation } from '../../src/annotate/types';

async function blankDoc(): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	doc.addPage([612, 792]);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

function penStroke(points: StrokeAnnotation['points']): StrokeAnnotation {
	return { id: 'ink-p', kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 6, points };
}

// The private dictionary our own extras live in — reached here directly so
// the tests can say something about the file's actual shape, not only about
// what reading it back produces.
function inklingDict(doc: PDFDocument): PDFDict | undefined {
	const annots = doc.getPage(0).node.Annots();
	const first = annots?.asArray()[0];
	const dict = first instanceof PDFRef ? doc.context.lookupMaybe(first, PDFDict) : undefined;
	return dict?.lookupMaybe(PDFName.of('Inkling'), PDFDict);
}

describe('pressure round trip', () => {
	it('recovers every sample’s pressure', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			penStroke([
				{ x: 10, y: 10, p: 1 },
				{ x: 50, y: 40, p: 0.5 },
				{ x: 90, y: 10, p: 0.02 },
			]),
		]);

		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.kind).toBe('stroke');
		const points = read?.kind === 'stroke' ? read.points : [];
		expect(points).toHaveLength(3);
		// Stored as a byte per sample, so a thousandth of a unit of pressure
		// is not worth the file size. Anything within 1/255 is exact enough.
		expect(points[0]?.p).toBeCloseTo(1, 2);
		expect(points[1]?.p).toBeCloseTo(0.5, 2);
		expect(points[2]?.p).toBeCloseTo(0.02, 2);
	});

	it('leaves a pressureless stroke pressureless, rather than claiming full pressure', async () => {
		// Saying "every sample was pressed as hard as possible" about a mouse
		// stroke would be a lie the renderer then acts on.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [penStroke([{ x: 0, y: 0 }, { x: 10, y: 10 }])]);
		expect(inklingDict(doc)).toBeUndefined();

		const [read] = readInklingAnnotations(await reload(doc), 0);
		const points = read?.kind === 'stroke' ? read.points : [];
		for (const point of points) expect(point.p).toBeUndefined();
	});

	it('keeps the raw points in /InkList whatever the appearance does', async () => {
		// The appearance stream is a filled outline for a pressure stroke, so
		// /InkList is the only place another PDF reader can find the path the
		// pen actually took.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [penStroke([{ x: 10, y: 10, p: 1 }, { x: 90, y: 10, p: 0.3 }])]);

		const annots = doc.getPage(0).node.Annots();
		const first = annots?.asArray()[0];
		const dict = first instanceof PDFRef ? doc.context.lookupMaybe(first, PDFDict) : undefined;
		const inkList = dict?.lookupMaybe(PDFName.of('InkList'), PDFArray);
		expect(inkList?.lookupMaybe(0, PDFArray)?.size()).toBe(4);
	});

	it('ignores a pressure array that does not match the stroke', async () => {
		// Something else edited the path but not our private key. Stretching
		// the pressures over a different number of points would be inventing
		// data about how hard someone pressed.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			penStroke([{ x: 0, y: 0, p: 1 }, { x: 10, y: 10, p: 0.5 }, { x: 20, y: 0, p: 0.2 }]),
		]);
		const dict = inklingDict(doc);
		dict?.set(PDFName.of('P'), doc.context.obj([255, 128]));

		const [read] = readInklingAnnotations(await reload(doc), 0);
		const points = read?.kind === 'stroke' ? read.points : [];
		expect(points).toHaveLength(3);
		for (const point of points) expect(point.p).toBeUndefined();
	});

	it('survives several save-and-reload cycles without drifting', async () => {
		let current = await blankDoc();
		writeInklingAnnotations(current, 0, [
			penStroke([{ x: 10, y: 10, p: 0.8 }, { x: 50, y: 40, p: 0.4 }, { x: 90, y: 10, p: 0.6 }]),
		]);
		current = await reload(current);

		for (let pass = 0; pass < 3; pass++) {
			const [read] = readInklingAnnotations(current, 0);
			const points = read?.kind === 'stroke' ? read.points : [];
			expect(points[0]?.p).toBeCloseTo(0.8, 2);
			expect(points[1]?.p).toBeCloseTo(0.4, 2);
			expect(points[2]?.p).toBeCloseTo(0.6, 2);
			writeInklingAnnotations(current, 0, read ? [read] : []);
			current = await reload(current);
		}
	});

	it('does not put pressure on a highlighter', async () => {
		// A highlighter never varies (see annotate/stroke.ts), so recording
		// pressure for one would be dead weight in every file.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-h',
				kind: 'stroke',
				tool: 'highlighter',
				color: '#f08c00',
				width: 14,
				points: [{ x: 0, y: 0, p: 0.9 }, { x: 100, y: 0, p: 0.3 }],
			},
		]);
		expect(inklingDict(doc)).toBeUndefined();
	});
});

// The other half of what makes an annotation a note: the words it covers,
// and what the user said about them.
describe('quote and note round trip', () => {
	it('recovers both through a save and reload', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-q',
				kind: 'stroke',
				tool: 'highlighter',
				color: '#f08c00',
				width: 12,
				points: [{ x: 0, y: 100 }, { x: 200, y: 100 }],
				quote: 'Entropy is not disorder',
				note: 'check this against chapter 4',
			},
		]);

		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.quote).toBe('Entropy is not disorder');
		expect(read?.note).toBe('check this against chapter 4');
	});

	it('puts the note in /Contents, where other PDF readers look for it', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{ ...penStroke([{ x: 0, y: 0 }, { x: 10, y: 10 }]), note: 'a thought' },
		]);
		const annots = doc.getPage(0).node.Annots();
		const first = annots?.asArray()[0];
		const dict = first instanceof PDFRef ? doc.context.lookupMaybe(first, PDFDict) : undefined;
		expect(dict?.lookupMaybe(PDFName.of('Contents'), PDFString)?.decodeText()).toBe('a thought');
	});

	it('keeps the quote out of /Contents, so the two can never be confused', async () => {
		// On read there would be no way to tell which of the two a /Contents
		// string was, and guessing wrong turns a highlight of the book into a
		// comment the user never wrote.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [{ ...penStroke([{ x: 0, y: 0 }, { x: 10, y: 10 }]), quote: 'from the book' }]);
		const annots = doc.getPage(0).node.Annots();
		const first = annots?.asArray()[0];
		const dict = first instanceof PDFRef ? doc.context.lookupMaybe(first, PDFDict) : undefined;
		expect(dict?.lookupMaybe(PDFName.of('Contents'), PDFString)).toBeUndefined();

		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.quote).toBe('from the book');
		expect(read?.note).toBeUndefined();
	});

	it('carries them on a shape as well as a stroke', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-box',
				kind: 'shape',
				tool: 'rectangle',
				color: '#1971c2',
				width: 3,
				start: { x: 10, y: 10 },
				end: { x: 100, y: 60 },
				note: 'this diagram is wrong',
			},
		]);
		expect(readInklingAnnotations(await reload(doc), 0)[0]?.note).toBe('this diagram is wrong');
	});

	it('writes neither field when there is nothing to say', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [{ ...penStroke([{ x: 0, y: 0 }, { x: 10, y: 10 }]), quote: '   ', note: '' }]);
		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.quote).toBeUndefined();
		expect(read?.note).toBeUndefined();
	});
});
