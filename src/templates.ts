import { PDFDocument, PDFPage, PageSizes, rgb } from 'pdf-lib';

export type TemplateStyle = 'blank' | 'lined' | 'dot-grid';

export const TEMPLATE_STYLES: readonly TemplateStyle[] = ['blank', 'lined', 'dot-grid'];

export const TEMPLATE_STYLE_LABELS: Record<TemplateStyle, string> = {
	blank: 'Blank',
	lined: 'Lined',
	'dot-grid': 'Dot grid',
};

export const PAGE_SIZE = PageSizes.Letter;

// A single Keywords entry, e.g. "inkling:template=dot-grid" — read back by
// "Add page" so a new page matches the note's existing style. No sidecar
// file; the PDF's own Info dictionary is the source of truth.
const TEMPLATE_KEYWORD_PREFIX = 'inkling:template=';

const RULE_MARGIN = 54; // ~0.75in
const RULE_SPACING = 24; // ~1/3in
const RULE_COLOR = rgb(0.7, 0.78, 0.92);
const RULE_THICKNESS = 0.75;

const DOT_MARGIN = 36; // ~0.5in
const DOT_SPACING = 18; // ~0.25in
const DOT_RADIUS = 0.6;
const DOT_COLOR = rgb(0.55, 0.55, 0.6);

function drawLinedRuling(page: PDFPage): void {
	const { width, height } = page.getSize();
	for (let y = height - RULE_MARGIN; y > RULE_MARGIN; y -= RULE_SPACING) {
		page.drawLine({
			start: { x: RULE_MARGIN, y },
			end: { x: width - RULE_MARGIN, y },
			thickness: RULE_THICKNESS,
			color: RULE_COLOR,
		});
	}
}

function drawDotGrid(page: PDFPage): void {
	const { width, height } = page.getSize();
	for (let y = height - DOT_MARGIN; y > DOT_MARGIN; y -= DOT_SPACING) {
		for (let x = DOT_MARGIN; x < width - DOT_MARGIN; x += DOT_SPACING) {
			page.drawCircle({ x, y, size: DOT_RADIUS, color: DOT_COLOR });
		}
	}
}

export function applyTemplateStyle(page: PDFPage, style: TemplateStyle): void {
	if (style === 'lined') drawLinedRuling(page);
	else if (style === 'dot-grid') drawDotGrid(page);
}

// Pure string parsing (no pdf-lib dependency) so callers that already have
// the Keywords string from somewhere cheaper than a full pdf-lib parse —
// e.g. pdf.js's getMetadata(), used to gate the "Add page"/"New handwritten
// note" affordances without paying for a second document parse on every
// file open — can use it too. Returns null (not 'blank') when the marker is
// absent entirely, which is how callers tell "not an Inkling note" apart
// from "an Inkling note using the blank template".
export function parseTemplateStyleFromKeywords(keywords: string | null | undefined): TemplateStyle | null {
	if (!keywords) return null;
	for (const keyword of keywords.split(/\s+/)) {
		if (!keyword.startsWith(TEMPLATE_KEYWORD_PREFIX)) continue;
		const style = keyword.slice(TEMPLATE_KEYWORD_PREFIX.length);
		if ((TEMPLATE_STYLES as readonly string[]).includes(style)) return style as TemplateStyle;
	}
	return null;
}

export function readTemplateStyle(pdf: PDFDocument): TemplateStyle {
	return parseTemplateStyleFromKeywords(pdf.getKeywords()) ?? 'blank';
}

function writeTemplateStyle(pdf: PDFDocument, style: TemplateStyle): void {
	pdf.setKeywords([`${TEMPLATE_KEYWORD_PREFIX}${style}`]);
}

export async function createHandwrittenNoteBytes(style: TemplateStyle): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	const page = pdf.addPage(PAGE_SIZE);
	applyTemplateStyle(page, style);
	writeTemplateStyle(pdf, style);
	return pdf.save();
}
