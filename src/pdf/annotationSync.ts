import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import { boundingBox } from '../annotate/geometry';
import { hasPressure, outlinePath, smoothedPath } from '../annotate/stroke';
import { ID_PREFIX, INKLING_EXTRAS, PRESSURE_KEY, QUOTE_KEY } from './annotationFormat';
import { arrowHeadOps, ellipseOps, moveLineOps, noteMarkerOps, pathOps, polygonOps, rectangleOps } from './contentStream';
import {
	Annotation,
	DEFAULT_COLOR,
	DEFAULT_WIDTH,
	HIGHLIGHTER_OPACITY,
	NOTE_MARKER_SIZE,
	NoteAnnotation,
	Point,
	ShapeAnnotation,
	StrokeAnnotation,
} from '../annotate/types';

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

// Whether an annotation dict is one of ours, by the `/NM` tag every write
// applies. Exported because verification needs the same answer (see
// src/pdf/fingerprint.ts): a fingerprint has to exclude exactly the
// annotations a save is allowed to change, and "exactly" means one
// definition, not two that can drift apart.
export function isInklingAnnotationDict(dict: PDFDict): boolean {
	try {
		return dict.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText()?.startsWith(ID_PREFIX) ?? false;
	} catch {
		// Malformed annotation dict — not ours, and not something to crash on.
		return false;
	}
}

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

// The /CA above which an ink annotation is taken to be a pen rather than a
// highlighter, on read.
//
// Derived from HIGHLIGHTER_OPACITY rather than written as a number, because
// the two are the same decision seen from opposite ends and a literal here
// is a trap: raise the highlighter's opacity past a hard-coded 0.9 one day
// and every highlight in every vault silently reads back as a pen stroke.
// The midpoint between what a highlighter writes and the 1 a pen writes
// keeps admitting older files (which carry 0.4) while leaving the widest
// margin on both sides.
const HIGHLIGHTER_OPACITY_MAX = (HIGHLIGHTER_OPACITY + 1) / 2;

// ---- Writing ----

// `1 J` is a round cap, `0 J` a flat one. Flat for a highlighter, matching
// the canvas (see the lineCap note in src/annotate/render.ts): a snapped
// highlight is one straight segment at the height of the text it covers, so
// a round cap adds a bulge of half that height past the first and last
// glyph. Round for everything else, where it is what stops a polyline
// looking chipped at its ends.
function strokeHeader(color: string, width: number, flatCap = false): string[] {
	const [r, g, b] = hexToRgb(color);
	return [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`, `${width.toFixed(2)} w`, `${flatCap ? 0 : 1} J 1 j`];
}

// The annotation dict's own `/CA` entry (below) is the spec-correct way to
// mark an annotation's overall opacity, but plenty of real-world viewers
// render an annotation's `/AP` appearance stream directly without applying
// it — which made the highlighter paint fully opaque (and cover the text
// it was supposed to sit over) in anything other than Obsidian's own
// overlay. Baking the alpha into the appearance stream itself via an
// `ExtGState` + `gs` operator means the translucency is part of what gets
// drawn, so it's correct regardless of whether the viewer also honors `/CA`.
//
// `blend` is the other half of that reasoning, and it is what makes a
// highlighter a highlighter rather than a translucent smear. Alpha alone
// paints colour *between* the reader and the words, so text under a
// highlight loses its contrast; `/BM /Multiply` makes the mark darken the
// paper instead, leaving black text black because black times anything is
// black. Its on-screen twin is the highlight layer's mix-blend-mode in
// styles.css, and the two have to agree or the saved file stops looking
// like the editor did.
//
// The alpha is kept alongside it rather than dropped: a reader that honours
// `/BM` gets the intended result, and one that ignores it still gets a
// translucent mark it can read the text through instead of an opaque bar
// covering it.
function buildAppearanceStream(
	pdfDoc: PDFDocument,
	bbox: number[],
	content: string,
	opacity = 1,
	blend?: 'Multiply',
): PDFRef {
	let resources: PdfLiteralObject = {};
	let body = content;
	if (opacity < 1 || blend) {
		const state: PdfLiteralObject = { Type: 'ExtGState', ca: opacity, CA: opacity };
		if (blend) state.BM = blend;
		const gsRef = pdfDoc.context.register(pdfDoc.context.obj(state));
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

function fillHeader(color: string): string[] {
	const [r, g, b] = hexToRgb(color);
	return [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`];
}

// Copies the fields every annotation kind shares into a dict being built.
// The private extras dict is created lazily, so an annotation with neither
// a quote nor pressure carries no extra bytes at all.
function withSharedFields(fields: PdfLiteralObject, annotation: Annotation): PdfLiteralObject {
	const note = annotation.note?.trim();
	if (note) fields.Contents = PDFString.of(note);

	const quote = annotation.quote?.trim();
	if (quote) {
		const extras = (fields[INKLING_EXTRAS] ?? {}) as PdfLiteralObject;
		extras[QUOTE_KEY] = PDFString.of(quote);
		fields[INKLING_EXTRAS] = extras;
	}
	return fields;
}

// The other half of withSharedFields: reads both back onto an annotation.
// Empty strings are dropped rather than kept, because "" and absent are
// the same thing here and only one of them should reach the rest of the
// code.
function readSharedFields(dict: PDFDict, annotation: Annotation): Annotation {
	const note = dict.lookupMaybe(PDFName.of('Contents'), PDFString)?.decodeText().trim();
	if (note) annotation.note = note;

	const quote = dict
		.lookupMaybe(PDFName.of(INKLING_EXTRAS), PDFDict)
		?.lookupMaybe(PDFName.of(QUOTE_KEY), PDFString)
		?.decodeText()
		.trim();
	if (quote) annotation.quote = quote;

	return annotation;
}

function writeStroke(pdfDoc: PDFDocument, page: PDFPage, stroke: StrokeAnnotation): void {
	const [r, g, b] = hexToRgb(stroke.color);
	const box = boundingBox(stroke);
	const pad = stroke.width / 2;
	const bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];

	const isHighlight = stroke.tool === 'highlighter';
	const opacity = isHighlight ? HIGHLIGHTER_OPACITY : 1;
	// A highlighter never varies its width (see annotate/stroke.ts), so it
	// never carries pressure — recording any for one would be dead weight in
	// every file that has one.
	const varying = stroke.tool === 'pen' && hasPressure(stroke.points);
	// Filled outline for a pressure stroke, stroked path for everything else:
	// no PDF stroking operator can vary a line's width along its length.
	// Either way the geometry comes from the same shared module the canvas
	// draws from, so the file matches what the user watched themselves draw.
	const content = varying
		? [...fillHeader(stroke.color), polygonOps(outlinePath(stroke.points, stroke.width)), 'f'].join('\n')
		: [...strokeHeader(stroke.color, stroke.width, isHighlight), pathOps(smoothedPath(stroke.points)), 'S'].join('\n');
	const apRef = buildAppearanceStream(pdfDoc, bbox, content, opacity, isHighlight ? 'Multiply' : undefined);

	const fields: PdfLiteralObject = {
		Type: 'Annot',
		Subtype: 'Ink',
		Rect: bbox,
		// The raw path, whatever the appearance stream above does with it —
		// for a filled outline this is the only place another PDF reader can
		// find the line the pen actually took.
		InkList: [stroke.points.flatMap((p) => [p.x, p.y])],
		C: [r, g, b],
		CA: opacity,
		BS: { W: stroke.width },
		F: 4,
		AP: { N: apRef },
	};
	if (varying) {
		fields[INKLING_EXTRAS] = {
			[PRESSURE_KEY]: stroke.points.map((p) => Math.round(Math.min(Math.max(p.p ?? 1, 0), 1) * 255)),
		};
	}

	tagAndAdd(pdfDoc, page, stroke.id, withSharedFields(fields, stroke));
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

	tagAndAdd(
		pdfDoc,
		page,
		shape.id,
		withSharedFields(
			{
				Type: 'Annot',
				Subtype: subtype,
				Rect: bbox,
				C: [r, g, b],
				BS: { W: shape.width },
				F: 4,
				AP: { N: apRef },
				...extra,
			},
			shape,
		),
	);
}

// A note annotation: a PDF /Text annotation, which is the standard sticky
// note. Written with an /AP of our own drawing the same marker the canvas
// draws, because a viewer left to its own devices renders /Text as its own
// house icon — a yellow speech bubble in one reader, a pushpin in another —
// and the colour that says which category this note belongs to would be
// lost with it.
function writeNote(pdfDoc: PDFDocument, page: PDFPage, note: NoteAnnotation): void {
	const [r, g, b] = hexToRgb(note.color);
	const half = NOTE_MARKER_SIZE / 2;
	const bbox = [note.at.x - half, note.at.y - half, note.at.x + half, note.at.y + half];

	const content = [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`, noteMarkerOps(note.at, NOTE_MARKER_SIZE), 'f'].join('\n');
	const apRef = buildAppearanceStream(pdfDoc, bbox, content);

	tagAndAdd(
		pdfDoc,
		page,
		note.id,
		withSharedFields(
			{
				Type: 'Annot',
				Subtype: 'Text',
				Rect: bbox,
				Name: 'Comment',
				C: [r, g, b],
				F: 4,
				AP: { N: apRef },
				// Closed, so a reader that renders /Text popups does not open
				// every note in the document at once on load.
				Open: false,
			},
			note,
		),
	);
}

// Frees one annotation’s own indirect objects from the document context —
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
			if (dict && isInklingAnnotationDict(dict)) toRemove.push(entry);
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
		else if (annotation.kind === 'note') writeNote(pdfDoc, page, annotation);
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
		if (!isInklingAnnotationDict(object)) continue;
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
		const tool = opacity <= HIGHLIGHTER_OPACITY_MAX ? 'highlighter' : 'pen';

		// Applied only when it describes exactly these points. A length
		// mismatch means something else edited the path without knowing about
		// our private key, and stretching the old pressures over a different
		// number of samples would be inventing data about how hard someone
		// pressed.
		const pressures = dict
			.lookupMaybe(PDFName.of(INKLING_EXTRAS), PDFDict)
			?.lookupMaybe(PDFName.of(PRESSURE_KEY), PDFArray);
		const values = pressures ? numbersFromArray(pressures) : [];
		if (values.length === points.length) {
			for (let index = 0; index < points.length; index++) {
				const point = points[index];
				const value = values[index];
				if (point && value !== undefined) point.p = Math.min(Math.max(value / 255, 0), 1);
			}
		}

		return { id, kind: 'stroke', tool, color, width, points };
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

	if (subtype === 'Text') {
		const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
		const [rx0, ry0, rx1, ry1] = rect ? numbersFromArray(rect) : [];
		if (rx0 === undefined || ry0 === undefined || rx1 === undefined || ry1 === undefined) return null;
		// The text itself comes from /Contents via readSharedFields, which
		// runs for every annotation kind — so an empty string here is
		// filled in a moment later, not lost.
		return { id, kind: 'note', color, width, at: { x: (rx0 + rx1) / 2, y: (ry0 + ry1) / 2 }, note: '' };
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
			if (annotation) result.push(readSharedFields(dict, annotation));
		} catch (error) {
			console.error('Inkling: skipping an unreadable annotation while loading a page.', error);
		}
	}
	return result;
}
