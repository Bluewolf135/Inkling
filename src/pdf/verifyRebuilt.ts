import { PDFDocument } from 'pdf-lib';

// A rebuilt file — a page added, deleted, moved or turned, pages inserted
// from another PDF, a background changed, a canvas grown — read back before
// it is written, as a full save of ink is (see fullSave in incrementalSave.ts).
// pdf-lib can fault without throwing, and a file it wrote wrong would
// otherwise be found out by whichever reader opened the note next. Thrown,
// never returned alongside the bytes: no caller gets something back and has
// to decide whether to trust it.
//
// `expectedPages` is how many pages the change meant to leave, where the
// caller knows; a count that differs is a rebuild that did not do what was
// asked, whatever it did instead.
export async function verifyRebuilt(bytes: ArrayBuffer, expectedPages?: number): Promise<void> {
	let pages: number;
	try {
		pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
	} catch (error) {
		throw new Error(`the rebuilt PDF could not be read back (${error instanceof Error ? error.message : String(error)})`);
	}
	if (pages < 1) throw new Error('the rebuilt PDF has no pages');
	if (expectedPages !== undefined && pages !== expectedPages) {
		throw new Error(`the rebuilt PDF has ${pages} ${pages === 1 ? 'page' : 'pages'} where ${expectedPages} ${expectedPages === 1 ? 'was' : 'were'} expected`);
	}
}
