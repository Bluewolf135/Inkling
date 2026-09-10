import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
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
		//
		// Identity, not just behaviour: restoring anything other than the
		// exact function that came off would leave a new one behind on every
		// save, and the save after that would wrap *that* — a chain growing
		// one layer per autosave for as long as the book stays open.
		/* eslint-disable @typescript-eslint/unbound-method -- the identity of the unbound method is precisely what this asserts. */
		const doc = await sampleDoc();
		const before = doc.context.register;
		expect(() =>
			recordChanges(doc.context, () => {
				throw new Error('boom');
			}),
		).toThrow(/boom/);
		expect(doc.context.register).toBe(before);
		/* eslint-enable @typescript-eslint/unbound-method -- back to the default beyond this assertion. */
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
		const resourcesRef = resources instanceof PDFRef ? resources : doc.context.register(doc.context.lookup(resources, PDFDict));
		page.node.set(PDFName.of('Resources'), resourcesRef);

		const changes = recordChanges(doc.context, (touch) => {
			writeInklingAnnotations(doc, 0, [stroke], touch);
		});
		expect([...changes.written]).toContain(resourcesRef);
	});

	it('collects an indirect /Contents array normalize wraps', async () => {
		// The third slot, and the least obvious. A parsed page has
		// autoNormalizeCTM on, so the first mutation calls wrapContentStreams
		// and pushes pdf-lib's shared push/pop-graphics-state streams into
		// the page's content array. When that array is itself an indirect
		// object, the page dict never changes and the array does — so a
		// change set that recorded only the page would append a page whose
		// content stream list is the *old* one, and the q/Q pdf-lib just
		// added would be unbalanced in the file.
		const doc = await sampleDoc();
		const page = doc.getPage(0);
		const contentsRef = doc.context.register(doc.context.lookup(page.node.get(PDFName.of('Contents')), PDFArray));
		page.node.set(PDFName.of('Contents'), contentsRef);

		const changes = recordChanges(doc.context, (touch) => {
			writeInklingAnnotations(doc, 0, [stroke], touch);
		});
		expect([...changes.written]).toContain(contentsRef);
	});
});
