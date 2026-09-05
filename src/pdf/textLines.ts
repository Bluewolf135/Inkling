// Real PDF text, grouped into lines, in whatever coordinate space the
// caller converted it to.
//
// This is the pure half of what pdfView.ts does with pdf.js's text content:
// the grouping and the clipping, with no PDFPageProxy or viewport in it, so
// it can be tested. The half that needs pdf.js — reading the items and
// converting each one through the page's viewport — stays there.

export interface TextItemBox {
	minX: number;
	maxX: number;
	text: string;
}

export interface TextLine {
	minX: number;
	maxX: number;
	centerY: number;
	height: number;
	// The items making up the line, left to right. Kept so a highlight can
	// report the words it covers, which is what turns an annotation into a
	// note.
	items: TextItemBox[];
}

// A box as it arrives, before grouping — an item's horizontal extent plus
// where it sits vertically.
export interface PositionedBox extends TextItemBox {
	centerY: number;
	height: number;
}

// How far below a line's baseline its descenders (g, p, y) reach, as a
// fraction of the line height pdf.js reports. A text item's origin is its
// baseline, not the bottom of its glyphs; treating it as the bottom put the
// whole box — and so every snapped highlight — noticeably above the words.
// Measured against the running app rather than assumed: comparing each
// computed line centre to the actual centre of the rendered ink (row-wise
// dark-pixel profile, clustered into text bands) over 83 lines across three
// pages put the error at a consistent 0.17 of line height, always in the
// same direction (median 0.176, 10th-90th percentile 0.08-0.24).
export const BASELINE_DESCENT_RATIO = 0.175;

// How far apart two items' vertical centres can be, as a fraction of the
// line height, and still count as the same line. A single visual line is
// usually several items — one per run of consistent font or style — not one
// item per line.
const SAME_LINE_TOLERANCE = 0.6;

export function groupIntoLines(boxes: PositionedBox[]): TextLine[] {
	const sorted = [...boxes].sort((a, b) => a.centerY - b.centerY);

	const lines: TextLine[] = [];
	let current: PositionedBox[] = [];

	const flush = () => {
		if (current.length === 0) return;
		// Left to right, so the text of a line reads in the order it was
		// written rather than in whatever order the PDF happened to emit its
		// runs — which for a document with mixed styling is not the same.
		const items = [...current].sort((a, b) => a.minX - b.minX);
		lines.push({
			minX: Math.min(...items.map((box) => box.minX)),
			maxX: Math.max(...items.map((box) => box.maxX)),
			centerY: items.reduce((sum, box) => sum + box.centerY, 0) / items.length,
			height: Math.max(...items.map((box) => box.height)),
			items: items.map(({ minX, maxX, text }) => ({ minX, maxX, text })),
		});
		current = [];
	};

	for (const box of sorted) {
		if (current.length > 0) {
			const avgCenterY = current.reduce((sum, entry) => sum + entry.centerY, 0) / current.length;
			const avgHeight = current.reduce((sum, entry) => sum + entry.height, 0) / current.length;
			if (Math.abs(box.centerY - avgCenterY) > avgHeight * SAME_LINE_TOLERANCE) flush();
		}
		current.push(box);
	}
	flush();

	return lines;
}

// The text a highlight covering `minX`..`maxX` of this line is over.
//
// Whole items, never partial ones. pdf.js reports an item's total width but
// not its per-glyph positions, so clipping inside an item would mean
// assuming every character is the same width — which is wrong for any
// proportional font, and produces quotes with words cut in half. Taking the
// whole item over-captures a little at the ends of a drag, which is the
// right way to be wrong: a quote with one extra word is still the right
// quote.
export function quoteBetween(line: TextLine, minX: number, maxX: number): string {
	// Strictly overlapping, not merely touching: a stroke that stops exactly
	// at a word's left edge has not covered that word, and treating a
	// zero-width contact as coverage adds a stray word to the end of most
	// quotes.
	const covered = line.items.filter((item) => item.maxX > minX && item.minX < maxX);
	return covered
		.map((item) => item.text)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}
