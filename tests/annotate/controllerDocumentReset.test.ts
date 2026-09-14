import { describe, expect, it } from 'vitest';
import { AnnotationController } from '../../src/annotate/controller';
import type { Annotation } from '../../src/annotate/types';

const stroke: Annotation = {
	id: 'ink-old',
	kind: 'stroke',
	tool: 'pen',
	color: '#1e1e1e',
	width: 3,
	points: [{ x: 10, y: 10 }, { x: 40, y: 40 }],
};

// The PDF view reuses one controller for every document it shows, and pages
// are addressed by number. Whatever a page number held in the last document
// must not still be there in the next one.
//
// The case that found this: "Add page" rewrites the file and reloads it, and
// the new blank page took the number of the page that used to follow it. The
// file had no annotations for that page, so nothing was seeded over it, and
// the blank page came up showing — and on the next stroke saving — the old
// page's ink.
describe('AnnotationController between documents', () => {
	it('forgets every page’s annotations when it is unmounted for a new document', () => {
		const controller = new AnnotationController();
		controller.seedPage(2, [stroke]);

		controller.unmountAll();

		expect(controller.getPageAnnotations(2)).toEqual([]);
	});
});
