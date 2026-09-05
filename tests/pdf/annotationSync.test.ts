import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { Annotation } from '../../src/annotate/types';

// Fixtures are generated here rather than committed as binaries, so the repo
// holds no opaque test data.
async function blankDoc(pages = 1): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	for (let index = 0; index < pages; index++) doc.addPage([612, 792]);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

describe('annotation round trip', () => {
	it('recovers a pen stroke through a save and reload', async () => {
		const doc = await blankDoc();
		const stroke: Annotation = {
			id: 'ink-a',
			kind: 'stroke',
			tool: 'pen',
			color: '#e03131',
			width: 4,
			points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }],
		};
		writeInklingAnnotations(doc, 0, [stroke]);

		const read = readInklingAnnotations(await reload(doc), 0);
		expect(read).toHaveLength(1);
		expect(read[0]).toMatchObject({ id: 'ink-a', kind: 'stroke', color: '#e03131', width: 4 });
		expect(read[0]).toMatchObject({ points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }] });
	});

	it('tells a highlighter apart from a pen by its opacity', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-h',
				kind: 'stroke',
				tool: 'highlighter',
				color: '#f08c00',
				width: 12,
				points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
			},
		]);
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({ tool: 'highlighter' });
	});

	it('recovers a rectangle at its exact bounds, with no drift per save', async () => {
		// `/Rect` is padded by half the stroke width on write and unpadded on
		// read. If those two disagree the shape creeps outward a little on
		// every single autosave.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-r',
				kind: 'shape',
				tool: 'rectangle',
				color: '#1971c2',
				width: 6,
				start: { x: 100, y: 100 },
				end: { x: 300, y: 250 },
			},
		]);

		let current = await reload(doc);
		for (let pass = 0; pass < 3; pass++) {
			const [read] = readInklingAnnotations(current, 0);
			expect(read).toMatchObject({ start: { x: 100, y: 100 }, end: { x: 300, y: 250 } });
			writeInklingAnnotations(current, 0, read ? [read] : []);
			current = await reload(current);
		}
	});

	it('recovers an arrow as an arrow, not a plain line', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-arrow',
				kind: 'shape',
				tool: 'arrow',
				color: '#2f9e44',
				width: 3,
				start: { x: 10, y: 10 },
				end: { x: 200, y: 120 },
			},
		]);
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({
			tool: 'arrow',
			start: { x: 10, y: 10 },
			end: { x: 200, y: 120 },
		});
	});

	it('replaces its own annotations rather than stacking duplicates', async () => {
		const doc = await blankDoc();
		const stroke: Annotation = {
			id: 'ink-a',
			kind: 'stroke',
			tool: 'pen',
			color: '#000000',
			width: 3,
			points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
		};
		writeInklingAnnotations(doc, 0, [stroke]);
		writeInklingAnnotations(doc, 0, [stroke]);
		writeInklingAnnotations(doc, 0, [stroke]);
		expect(readInklingAnnotations(await reload(doc), 0)).toHaveLength(1);
	});

	it('never touches annotations authored by other software', async () => {
		const doc = await blankDoc();
		const page = doc.getPage(0);
		// A foreign annotation: no `/NM` starting with `ink-`.
		page.node.addAnnot(
			doc.context.register(
				doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 60], F: 4 }),
			),
		);

		writeInklingAnnotations(doc, 0, [
			{ id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
		]);

		const reloaded = await reload(doc);
		expect(readInklingAnnotations(reloaded, 0)).toHaveLength(1);
		// One of ours plus the untouched foreign one.
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);
	});

	it('keeps each page’s annotations to that page', async () => {
		const doc = await blankDoc(3);
		writeInklingAnnotations(doc, 1, [
			{ id: 'ink-p2', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
		]);
		const reloaded = await reload(doc);
		expect(readInklingAnnotations(reloaded, 0)).toHaveLength(0);
		expect(readInklingAnnotations(reloaded, 1)).toHaveLength(1);
		expect(readInklingAnnotations(reloaded, 2)).toHaveLength(0);
	});
});
