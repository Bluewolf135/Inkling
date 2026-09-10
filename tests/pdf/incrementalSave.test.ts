import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { abandonIncremental, beginIncrementalSession, commitAppend, saveIncrementally } from '../../src/pdf/incrementalSave';
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

// Forty pages of text rather than one line, so an appendix of a kilobyte sits
// comfortably inside the compaction budget.
//
// Sizing this was not arbitrary. A one-line fixture is *smaller than a single
// update section*: one stroke costs about 1,074 bytes — the page dictionary,
// the annotation, its appearance stream, and the two graphics-state streams
// pdf-lib injects on first mutation — so every save tripped the 20% rule and
// the suite tested the threshold instead of the thing under test. Text
// compresses hard, so eight pages was still only 4.4 KB; forty gets the base
// to roughly 20 KB, which is where an append is a small fraction of the file
// the way it is on a real book.
async function fixture(useObjectStreams = false): Promise<{ bytes: Uint8Array; doc: PDFDocument }> {
	const source = await PDFDocument.create();
	const font = await source.embedFont(StandardFonts.Helvetica);
	for (let index = 0; index < 40; index++) {
		source.addPage([612, 792]).drawText(`Chapter ${index}. `.repeat(120), { x: 40, y: 700, size: 9, font });
	}
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
		const outcome = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);

		expect(outcome.mode).toBe('append');
		if (outcome.mode !== 'append') return;
		expect(outcome.baseLength).toBe(bytes.length);

		const reloaded = await PDFDocument.load(toArrayBuffer(concat(bytes, outcome.appendix)), { updateMetadata: false });
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
	});

	it('chains a second append onto the first', async () => {
		// The property a session depends on: /Prev has to follow our own
		// previous section, not the original file's, from the second save on.
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);

		const first = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
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

		// And through a reader that actually follows the chain, since pdf-lib
		// would read a broken /Prev just as happily.
		const { getDocument } = await import('pdfjs-dist');
		const pdf = await getDocument({ data: updated.slice() }).promise;
		expect((await (await pdf.getPage(1)).getAnnotations()).length).toBe(2);
		await pdf.destroy();
	});

	it('falls back to a full rewrite when the file cannot be classified', async () => {
		const { bytes, doc } = await fixture();
		const broken = Uint8Array.from(
			new TextDecoder('latin1').decode(bytes).replace(/startxref\n\d+/, 'startxref\n17'),
			(c) => c.charCodeAt(0),
		);
		const session = beginIncrementalSession(broken, doc);
		const outcome = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);

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
		let intercepted = 0;
		const spy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (...args: Parameters<typeof realLoad>) => {
			const parsed = await realLoad(...args);
			// Only the append's verification parse, so the full-rewrite
			// fallback it declines into can still succeed — which is the
			// behaviour being pinned: a failed verification costs a slow save,
			// never the user's ink.
			if (intercepted++ === 0) parsed.setKeywords(['tampered']);
			return parsed;
		});
		try {
			const outcome = await saveIncrementally(doc, session, (touch) =>
				writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
			);
			expect(outcome.mode).toBe('full');
			expect(session.disabled).toMatch(/did not verify/);
		} finally {
			spy.mockRestore();
		}
	});

	it('stops trying to append once a session has been abandoned', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		abandonIncremental(session, 'the append did not land');

		const outcome = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
		expect(outcome.mode).toBe('full');
	});

	it('never advances its idea of the file for a write that was not committed', async () => {
		// The corrupt-file case reached by our own hand: an append built on
		// bytes that were never written lands at the wrong offset entirely.
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		await saveIncrementally(doc, session, (touch) => writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch));

		expect(session.baseBytes.length).toBe(bytes.length);
		abandonIncremental(session, 'the write failed');
		expect(session.baseBytes.length).toBe(bytes.length);
	});

	it('measures the compaction budget against the last whole file, not the growing one', async () => {
		// The denominator has to stay put. baseBytes grows with every append,
		// so measuring the 20% against it would inflate the divisor as the
		// appendix accumulated and make compaction steadily *less* likely —
		// exactly backwards, and it would leave the only garbage collector
		// this plugin has unable to fire on the sessions that need it most.
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);

		const first = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
		if (first.mode !== 'append') throw new Error('expected an append');
		commitAppend(session);

		expect(session.baseBytes.length).toBeGreaterThan(bytes.length);
		expect(session.compactedSize).toBe(bytes.length);
	});

	it('compacts once the appendix has grown past its worth', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		// Past both thresholds for a fixture this size.
		session.appendedBytes = bytes.length;

		const outcome = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
		expect(outcome.mode).toBe('full');
	});

	it('returns to appending after a compaction, against the compacted file', async () => {
		const { bytes, doc } = await fixture();
		const session = beginIncrementalSession(bytes, doc);
		session.appendedBytes = bytes.length;

		const compacted = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
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
		// in the first appended section — otherwise the prune achieves nothing
		// and a file bloated by past sessions never shrinks.
		const { bytes, doc } = await fixture();
		const orphan = doc.context.register(doc.context.obj({ Type: 'Annot' }));
		doc.context.delete(orphan);

		const session = beginIncrementalSession(bytes, doc, new Set([orphan]));
		const outcome = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
		if (outcome.mode !== 'append') throw new Error('expected an append');

		expect(new TextDecoder('latin1').decode(outcome.appendix)).toMatch(/\d{10} \d{5} f/);
		expect(session.carriedFreed.size).toBe(0);
	});

	it('works the same way on a file that uses cross-reference streams', async () => {
		const { bytes, doc } = await fixture(true);
		const session = beginIncrementalSession(bytes, doc);
		const outcome = await saveIncrementally(doc, session, (touch) =>
			writeInklingAnnotations(doc, 0, [strokeAt('ink-a', 10)], touch),
		);
		expect(outcome.mode).toBe('append');
	});
});
