import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import { boundingBox } from '../annotate/geometry';
import { arrowHeadOps, ellipseOps, moveLineOps, rectangleOps } from './contentStream';
import { Annotation, DEFAULT_COLOR, DEFAULT_WIDTH, HIGHLIGHTER_OPACITY, Point, ShapeAnnotation, StrokeAnnotation } from '../annotate/types';

// Mirrors pdf-lib's own (unexported) PDFContext.obj()/stream() literal
// type, so a plain object literal built up across a few local variables
// still resolves to the right overload instead of widening to
// Record<string, unknown> and losing the shape TypeScript needs to pick
// between the object/array overloads.
type PdfLiteral = string | number | boolean | null | undefined | PDFObject | PdfLiteralObject | PdfLiteralArray;
interface PdfLiteralObject {
	[key: string]: PdfLiteral;
}
type PdfLiteralArray = PdfLiteral[];

// Every annotation Inkling writes is tagged with its stable id in the PDF's
// `/NM` field (the spec's own "unique annotation name" — a perfect fit for
// our purposes). The `ink-` prefix (see src/annotate/id.ts) is what lets us
// tell our own annotations apart from ones authored by other software on
// read, and what limits our writes to only ever touching our own
// annotations — foreign annotations are never inspected past this check,
// so they're never at risk of being corrupted or dropped.
const ID_PREFIX = 'ink-';

function hexToRgb(color: string): [number, number, number] {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	const [, r, g, b] = match ?? [];
	if (!r || !g || !b) return [0, 0, 0];
	return [parseInt(r, 16) / 255, parseInt(g, 16) / 255, parseInt(b, 16) / 255];
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (v: number) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function numbersFromArray(array: PDFArray): number[] {
	return array
		.asArray()
		.filter((o): o is PDFNumber => o instanceof PDFNumber)
		.map((o) => o.asNumber());
}

// ---- Writing ----

function strokeHeader(color: string, width: number): string[] {
	const [r, g, b] = hexToRgb(color);
	return [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`, `${width.toFixed(2)} w`, '1 J 1 j'];
}

// The annotation dict's own `/CA` entry (below) is the spec-correct way to
// mark an annotation's overall opacity, but plenty of real-world viewers
// render an annotation's `/AP` appearance stream directly without applying
// it — which made the highlighter paint fully opaque (and cover the text
// it was supposed to sit over) in anything other than Obsidian's own
// overlay. Baking the alpha into the appearance stream itself via an
// `ExtGState` + `gs` operator means the translucency is part of what gets
// drawn, so it's correct regardless of whether the viewer also honors `/CA`.
function buildAppearanceStream(pdfDoc: PDFDocument, bbox: number[], content: string, opacity = 1): PDFRef {
	let resources: PdfLiteralObject = {};
	let body = content;
	if (opacity < 1) {
		const gsRef = pdfDoc.context.register(pdfDoc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
		resources = { ExtGState: { GS0: gsRef } };
		body = `/GS0 gs\n${content}`;
	}
	const stream = pdfDoc.context.stream(body, {
		Type: 'XObject',
		Subtype: 'Form',
		FormType: 1,
		BBox: bbox,
		Resources: resources,
	});
	return pdfDoc.context.register(stream);
}

function tagAndAdd(pdfDoc: PDFDocument, page: PDFPage, id: string, fields: PdfLiteralObject): void {
	const dict = pdfDoc.context.obj(fields);
	dict.set(PDFName.of('NM'), PDFString.of(id));
	page.node.addAnnot(pdfDoc.context.register(dict));
}

function writeStroke(pdfDoc: PDFDocument, page: PDFPage, stroke: StrokeAnnotation): void {
	const [r, g, b] = hexToRgb(stroke.color);
	const box = boundingBox(stroke);
	const pad = stroke.width / 2;
	const bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];

	const opacity = stroke.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1;
	const content = [...strokeHeader(stroke.color, stroke.width), moveLineOps(stroke.points), 'S'].join('\n');
	const apRef = buildAppearanceStream(pdfDoc, bbox, content, opacity);

	tagAndAdd(pdfDoc, page, stroke.id, {
		Type: 'Annot',
		Subtype: 'Ink',
		Rect: bbox,
		InkList: [stroke.points.flatMap((p) => [p.x, p.y])],
		C: [r, g, b],
		CA: opacity,
		BS: { W: stroke.width },
		F: 4,
		AP: { N: apRef },
	});
}

function writeShape(pdfDoc: PDFDocument, page: PDFPage, shape: ShapeAnnotation): void {
	const [r, g, b] = hexToRgb(shape.color);
	const box = boundingBox(shape);
	const header = strokeHeader(shape.color, shape.width);

	let subtype: string;
	let extra: PdfLiteralObject = {};
	let bbox: number[];
	let content: string;

	if (shape.tool === 'line' || shape.tool === 'arrow') {
		subtype = 'Line';
		extra = { L: [shape.start.x, shape.start.y, shape.end.x, shape.end.y] };
		const pad = shape.width / 2 + (shape.tool === 'arrow' ? 14 : 0);
		bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];
		const lines = [...header, moveLineOps([shape.start, shape.end]), 'S'];
		if (shape.tool === 'arrow') {
			extra.LE = ['None', 'OpenArrow'];
			lines.push(arrowHeadOps(shape.start, shape.end, Math.max(12, shape.width * 3)), 'S');
		}
		content = lines.join('\n');
	} else {
		// Square/Circle: `/Rect` *is* the shape's geometry (per spec, inclusive
		// of border width) — pad by exactly half the stroke width so reading
		// it back can invert the same padding and recover the exact bounds,
		// rather than drifting outward a little on every save/reopen cycle.
		const pad = shape.width / 2;
		bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];
		subtype = shape.tool === 'rectangle' ? 'Square' : 'Circle';
		content =
			shape.tool === 'rectangle'
				? [...header, rectangleOps(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY), 'S'].join('\n')
				: [
						...header,
						ellipseOps((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2),
						'S',
					].join('\n');
	}

	const apRef = buildAppearanceStream(pdfDoc, bbox, content);

	tagAndAdd(pdfDoc, page, shape.id, {
		Type: 'Annot',
		Subtype: subtype,
		Rect: bbox,
		C: [r, g, b],
		BS: { W: shape.width },
		F: 4,
		AP: { N: apRef },
		...extra,
	});
}

// Frees one annotation's own indirect objects from the document context —
// its dict, its /AP appearance stream, and (highlighter strokes only) the
// ExtGState the appearance stream references for opacity. Unlinking a ref
// from a page's /Annots array (page.node.removeAnnot, below) does *not* do
// this by itself: the objects stay registered in the PDFContext and keep
// getting serialized into every future save regardless. Since
// writeInklingAnnotations (below) fully rewrites a page's Inkling
// annotations as brand-new objects on every single autosave, skipping this
// step meant every edit left the *previous* generation of dicts/streams
// behind as permanent dead weight that never got reclaimed — the file only
// ever grew, compounding with every stroke across a session, eventually
// growing large enough to trip a sync tool's file-size limit.
function deleteAnnotationObjects(pdfDoc: PDFDocument, ref: PDFRef): void {
	const dict = pdfDoc.context.lookupMaybe(ref, PDFDict);
	const apRef = dict?.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N'));
	if (apRef instanceof PDFRef) {
		const apStream = pdfDoc.context.lookupMaybe(apRef, PDFStream);
		const extGState = apStream?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
		if (extGState) {
			for (const value of extGState.values()) {
				if (value instanceof PDFRef) pdfDoc.context.delete(value);
			}
		}
		pdfDoc.context.delete(apRef);
	}
	pdfDoc.context.delete(ref);
}

function removeInklingAnnotations(pdfDoc: PDFDocument, page: PDFPage): boolean {
	const annots = page.node.Annots();
	if (!annots) return false;

	const toRemove: PDFRef[] = [];
	for (const entry of annots.asArray()) {
		if (!(entry instanceof PDFRef)) continue;
		try {
			const dict = pdfDoc.context.lookupMaybe(entry, PDFDict);
			const nm = dict?.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText();
			if (nm?.startsWith(ID_PREFIX)) toRemove.push(entry);
		} catch {
			// Malformed annotation dict — leave it alone rather than crash.
		}
	}
	for (const ref of toRemove) {
		page.node.removeAnnot(ref);
		deleteAnnotationObjects(pdfDoc, ref);
	}
	return toRemove.length > 0;
}

// Fully resyncs one page's Inkling-authored annotations to match
// `annotations` (in PDF space — see src/pdfView.ts for the canvas<->PDF
// conversion) — removes all of our previous ones and re-adds the current
// set. Foreign annotations (no matching `/NM` prefix) are never touched.
export function writeInklingAnnotations(pdfDoc: PDFDocument, pageIndex: number, annotations: Annotation[]): void {
	const page = pdfDoc.getPage(pageIndex);
	removeInklingAnnotations(pdfDoc, page);
	for (const annotation of annotations) {
		if (annotation.kind === 'stroke') writeStroke(pdfDoc, page, annotation);
		else writeShape(pdfDoc, page, annotation);
	}
}

// Builds a display-only copy for pdf.js to render from: our own Inkling
// annotations stripped out, everything else — crucially, annotations from
// other PDF software (Xodo, Acrobat, ...) — left exactly as they were.
// pdf.js's default annotation-baking render (see src/pdfView.ts) has no way
// to selectively bake some annotations and not others, so this exists to
// keep it from doubling up with our own live overlay of *our* annotations
// while still letting it show *foreign* ones, which we never render
// ourselves. Returns whether anything was actually stripped, so the caller
// (annotationWriter.worker.ts) can skip building this copy — and paying for
// its own save() — entirely for the common case of a file with no Inkling
// annotations yet.
export function stripInklingAnnotations(pdfDoc: PDFDocument): boolean {
	let removedAny = false;
	for (const page of pdfDoc.getPages()) {
		if (removeInklingAnnotations(pdfDoc, page)) removedAny = true;
	}
	return removedAny;
}

// A one-time sweep for damage from before deleteAnnotationObjects existed:
// every prior version of removeInklingAnnotations only unlinked a ref from
// a page's /Annots array without freeing the dict/AP-stream/ExtGState
// objects themselves, so every autosave left the *previous* generation of
// each edited page's annotation objects behind, permanently, as dead
// weight nothing pointed to any more but that still got serialized into
// every subsequent save regardless — a file only ever grew, compounding
// with every stroke across every session, until it was large enough to
// trip a sync tool's file-size limit. Finds every Inkling-tagged
// annotation dict (the same /NM `ink-` prefix used everywhere else here)
// that no page's /Annots array links to any more, and frees it the same
// way a normal edit now does. Called once when a file is opened for
// editing (see annotationWriter.worker.ts) so a file bloated by past
// sessions shrinks back down on the very next save.
export function pruneOrphanedInklingAnnotations(pdfDoc: PDFDocument): boolean {
	const linked = new Set<PDFRef>();
	for (const page of pdfDoc.getPages()) {
		const annots = page.node.Annots();
		if (!annots) continue;
		for (const entry of annots.asArray()) {
			if (entry instanceof PDFRef) linked.add(entry);
		}
	}

	let prunedAny = false;
	for (const [ref, object] of pdfDoc.context.enumerateIndirectObjects()) {
		if (linked.has(ref) || !(object instanceof PDFDict)) continue;
		let nm: string | undefined;
		try {
			nm = object.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText();
		} catch {
			continue; // Malformed dict — leave it alone rather than crash.
		}
		if (!nm?.startsWith(ID_PREFIX)) continue;
		deleteAnnotationObjects(pdfDoc, ref);
		prunedAny = true;
	}
	return prunedAny;
}

// ---- Reading ----

function readColor(dict: PDFDict): string {
	const array = dict.lookupMaybe(PDFName.of('C'), PDFArray);
	const [r, g, b] = array ? numbersFromArray(array) : [];
	if (r === undefined || g === undefined || b === undefined) return DEFAULT_COLOR;
	return rgbToHex(r, g, b);
}

function readWidth(dict: PDFDict): number {
	return dict.lookupMaybe(PDFName.of('BS'), PDFDict)?.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber() ?? DEFAULT_WIDTH;
}

function readOne(id: string, dict: PDFDict): Annotation | null {
	const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
	const color = readColor(dict);
	const width = readWidth(dict);

	if (subtype === 'Ink') {
		const inkList = dict.lookupMaybe(PDFName.of('InkList'), PDFArray);
		const first = inkList?.lookupMaybe(0, PDFArray);
		const flat = first ? numbersFromArray(first) : [];
		const points: Point[] = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			const x = flat[i];
			const y = flat[i + 1];
			if (x !== undefined && y !== undefined) points.push({ x, y });
		}
		if (points.length < 2) return null;

		const opacity = dict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber() ?? 1;
		return { id, kind: 'stroke', tool: opacity < 0.9 ? 'highlighter' : 'pen', color, width, points };
	}

	if (subtype === 'Line') {
		const nums = dict.lookupMaybe(PDFName.of('L'), PDFArray);
		const [x1, y1, x2, y2] = nums ? numbersFromArray(nums) : [];
		if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;

		const endStyle = dict.lookupMaybe(PDFName.of('LE'), PDFArray)?.lookupMaybe(1, PDFName)?.decodeText();
		return {
			id,
			kind: 'shape',
			tool: endStyle === 'OpenArrow' ? 'arrow' : 'line',
			color,
			width,
			start: { x: x1, y: y1 },
			end: { x: x2, y: y2 },
		};
	}

	if (subtype === 'Square' || subtype === 'Circle') {
		const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
		const [rx0, ry0, rx1, ry1] = rect ? numbersFromArray(rect) : [];
		if (rx0 === undefined || ry0 === undefined || rx1 === undefined || ry1 === undefined) return null;

		const half = width / 2;
		return {
			id,
			kind: 'shape',
			tool: subtype === 'Square' ? 'rectangle' : 'oval',
			color,
			width,
			start: { x: rx0 + half, y: ry0 + half },
			end: { x: rx1 - half, y: ry1 - half },
		};
	}

	return null;
}

// Reads back this page's previously-saved Inkling annotations, in PDF
// space. Anything not tagged with our `/NM` prefix — including annotations
// this same page already had from other software — is left untouched and
// simply not returned; see the plan's "must gracefully handle foreign
// annotations" note.
export function readInklingAnnotations(pdfDoc: PDFDocument, pageIndex: number): Annotation[] {
	const page = pdfDoc.getPage(pageIndex);
	const annots = page.node.Annots();
	if (!annots) return [];

	const result: Annotation[] = [];
	for (const entry of annots.asArray()) {
		if (!(entry instanceof PDFRef)) continue;
		try {
			const dict = pdfDoc.context.lookupMaybe(entry, PDFDict);
			if (!dict) continue;
			const id = dict.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText();
			if (!id || !id.startsWith(ID_PREFIX)) continue;

			const annotation = readOne(id, dict);
			if (annotation) result.push(annotation);
		} catch (error) {
			console.error('Inkling: skipping an unreadable annotation while loading a page.', error);
		}
	}
	return result;
}
