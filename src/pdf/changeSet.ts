import type { PDFContext, PDFObject, PDFRef } from 'pdf-lib';

// What one save actually changed, enumerated rather than discovered.
//
// An explicit change set is better than diffing pdf-lib's object graph
// because it cannot over-collect. A diff against the loaded model would flag
// every object pdf-lib normalised on parse, and appending those would
// reintroduce exactly the re-encoding risk the incremental path exists to
// remove: every byte before the appendix is meant to be the original file,
// untouched.
//
// Two mechanisms, because pdf-lib needs two. Objects it *creates* and *frees*
// go through PDFContext, so wrapping three of its methods sees all of them.
// Objects it mutates **in place** — a page dictionary gaining an /Annots
// entry, an /Annots array being pushed onto, a /Resources dictionary that
// normalize() writes /Font, /XObject and /ExtGState into — go through nothing
// at all, and the only code that knows they were touched is the code doing
// the touching. Hence `touch`.

export type TouchFn = (ref: PDFRef) => void;

export interface ChangeSet {
	// Objects to serialize into the appendix, in place of whatever the
	// original file said about them.
	written: Set<PDFRef>;
	// Objects to mark free in the appended cross-reference section. This does
	// not reclaim their bytes — an append-only format cannot remove anything
	// — it stops them being reachable. The bytes come back only at
	// compaction, which is why compaction is the plugin's only garbage
	// collector.
	freed: Set<PDFRef>;
}

export function recordChanges(context: PDFContext, mutate: (touch: TouchFn) => void): ChangeSet {
	const written = new Set<PDFRef>();
	const freed = new Set<PDFRef>();

	// The original references, not bound copies. `bind` returns a new
	// function, so restoring a bound one would leave a slightly different
	// method behind after every save — and the next save would bind *that*,
	// stacking one more layer per autosave for as long as the file stays
	// open.
	//
	// unbound-method is disabled rather than worked around because taking
	// these unbound is the point: they are restored by assignment, so what
	// goes back has to be identical to what came off. Every call below
	// passes the context explicitly, which is the hazard the rule is
	// actually about.
	/* eslint-disable @typescript-eslint/unbound-method -- taken unbound on purpose; they are restored by assignment, so what goes back must be identical to what came off, and every call below passes the context explicitly. */
	const realRegister = context.register;
	const realAssign = context.assign;
	const realDelete = context.delete;
	/* eslint-enable @typescript-eslint/unbound-method -- back to the default beyond the three captures above. */

	// A ref freed earlier in the same pass and then touched again is a
	// contradiction resolved in favour of "freed" below; recording it here
	// regardless keeps this function free of ordering rules.
	const touch: TouchFn = (ref) => {
		written.add(ref);
	};

	context.register = (object: PDFObject): PDFRef => {
		const ref = realRegister.call(context, object);
		written.add(ref);
		return ref;
	};
	context.assign = (ref: PDFRef, object: PDFObject): void => {
		realAssign.call(context, ref, object);
		written.add(ref);
	};
	context.delete = (ref: PDFRef): boolean => {
		const removed = realDelete.call(context, ref);
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

	// An object created and freed within one pass — a stroke drawn and erased
	// between two saves — must be one or the other, never both. Freed wins: it
	// is the later truth, and a section that both defines an object and marks
	// it free is a contradiction in the file.
	for (const ref of freed) written.delete(ref);

	return { written, freed };
}
