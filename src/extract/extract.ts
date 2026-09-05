import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { PRESET_COLORS } from '../annotate';
import { groupIntoLines, quoteBetween, type PositionedBox } from '../pdf/textLines';
import type { ExtractedAnnotation } from './extractFormat';

// Reading a PDF's annotations back out, with their text.
//
// pdf.js does both halves here, rather than pdf-lib doing the annotations
// and pdf.js the text. Extraction is strictly read-only, and pdf.js already
// gives normalised `rect`, `contents`, `color` and `subtype` for foreign
// annotations as well as ours — so using it for both means one parse and
// one set of conventions, rather than two views of the same file that have
// to be reconciled.

// The same `ink-` tag every write applies (see pdf/annotationSync.ts). Read
// here rather than imported, because that module is about writing and this
// one must never write.
const ID_PREFIX = 'ink-';

// The default colour categories: the palette's own names. Track D lets
// these be renamed, so "Yellow = definition, Red = disagree" works.
export function defaultColorLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const { value, label } of PRESET_COLORS) labels[value.toLowerCase()] = label;
	return labels;
}

// A number out of a value pdf.js types loosely. Read by index rather than
// destructured, because an ArrayLike is not iterable and a cast to an array
// of numbers would be a claim about the contents rather than a check of
// them — and this reads a file other software wrote.
function numberAt(value: unknown, index: number): number | null {
	if (typeof value !== 'object' || value === null) return null;
	const entry: unknown = (value as Record<number, unknown>)[index];
	return typeof entry === 'number' && Number.isFinite(entry) ? entry : null;
}

// pdf.js reports an annotation's colour as 0-255 components, or omits it.
function toHex(color: unknown): string {
	const r = numberAt(color, 0);
	const g = numberAt(color, 1);
	const b = numberAt(color, 2);
	if (r === null || g === null || b === null) return '';
	const part = (value: number) => Math.round(Math.min(Math.max(value, 0), 255)).toString(16).padStart(2, '0');
	return `#${part(r)}${part(g)}${part(b)}`;
}

// The shape of a pdf.js annotation, narrowed to what is read here. Declared
// rather than imported: pdf.js types this loosely, and naming the four
// fields actually used says more than `any` would.
interface RawAnnotation {
	id?: unknown;
	subtype?: unknown;
	rect?: unknown;
	contents?: unknown;
	color?: unknown;
	annotationName?: unknown;
}

function rectOf(raw: RawAnnotation): { minX: number; minY: number; maxX: number; maxY: number } | null {
	const x1 = numberAt(raw.rect, 0);
	const y1 = numberAt(raw.rect, 1);
	const x2 = numberAt(raw.rect, 2);
	const y2 = numberAt(raw.rect, 3);
	if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
	return {
		minX: Math.min(x1, x2),
		minY: Math.min(y1, y2),
		maxX: Math.max(x1, x2),
		maxY: Math.max(y1, y2),
	};
}

// A page's text, grouped into lines, in the page's own PDF space — which is
// the space annotation rects are already in, so no viewport conversion is
// needed here at all. That is the whole reason extraction can work on a
// file nobody has opened for editing.
async function pageLines(page: PDFPageProxy) {
	const content = await page.getTextContent();
	const boxes: PositionedBox[] = [];
	for (const item of content.items) {
		if (!('str' in item) || !item.str.trim()) continue;
		const [, , , , e, f] = item.transform as [number, number, number, number, number, number];
		boxes.push({
			text: item.str,
			minX: e,
			maxX: e + item.width,
			centerY: f + item.height / 2,
			height: Math.max(item.height, 1),
		});
	}
	return groupIntoLines(boxes);
}

// The words an annotation's rectangle covers, recomputed from the page's
// text. This is what makes extraction work retroactively — on highlights
// made before quotes were stored, and on ones made in other PDF software,
// which never stored anything of ours at all.
function quoteUnder(lines: ReturnType<typeof groupIntoLines>, rect: { minX: number; minY: number; maxX: number; maxY: number }): string {
	const parts: string[] = [];
	for (const line of lines) {
		const half = line.height / 2;
		if (line.centerY + half < rect.minY || line.centerY - half > rect.maxY) continue;
		const quote = quoteBetween(line, rect.minX, rect.maxX);
		if (quote) parts.push(quote);
	}
	return parts.join(' ');
}

export interface CollectOptions {
	// Called as each page is read, so a long book can report progress
	// instead of appearing to hang.
	onProgress?: (pageNumber: number, pageCount: number) => void;
}

export async function collectAnnotations(bytes: ArrayBuffer, options: CollectOptions = {}): Promise<ExtractedAnnotation[]> {
	let pdf: PDFDocumentProxy | null = null;
	const found: ExtractedAnnotation[] = [];

	try {
		pdf = await getDocument({ data: bytes }).promise;

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			options.onProgress?.(pageNumber, pdf.numPages);
			const page = await pdf.getPage(pageNumber);

			const raw = (await page.getAnnotations()) as RawAnnotation[];
			if (raw.length === 0) continue;

			// Only paid for on pages that actually have annotations. On a
			// 900-page book with ten highlights that is ten text extractions
			// rather than nine hundred.
			const lines = await pageLines(page);

			for (const annotation of raw) {
				const rect = rectOf(annotation);
				if (!rect) continue;

				const name = typeof annotation.annotationName === 'string' ? annotation.annotationName : '';
				const foreign = !name.startsWith(ID_PREFIX);
				const note = typeof annotation.contents === 'string' ? annotation.contents.trim() : '';
				const quote = quoteUnder(lines, rect);

				// A pen doodle in a margin is not a note. Including every
				// stroke would bury the annotations that are.
				if (!quote && !note) continue;

				found.push({
					// A foreign annotation may have no name of its own, so
					// one is derived from where it sits — stable across runs,
					// which is what the block reference needs.
					id: name || `ext-p${pageNumber}-${Math.round(rect.minX)}-${Math.round(rect.minY)}`,
					pageNumber,
					color: toHex(annotation.color) || '#1e1e1e',
					quote,
					note,
					foreign,
					top: rect.maxY,
				});
			}
		}
	} finally {
		await pdf?.destroy();
	}

	return found;
}
