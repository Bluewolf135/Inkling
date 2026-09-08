export interface Point {
	x: number;
	y: number;
	// Stylus pressure at this sample, 0 to 1.
	//
	// Optional, and that is the whole compatibility story: every annotation
	// already in a vault, every ink block already in a note, and every
	// /InkList read back out of a PDF parses unchanged and simply has none.
	// A stroke with no pressure on any point draws exactly as it always did
	// (see annotate/stroke.ts).
	p?: number;
}

export type DrawToolType = 'pen' | 'highlighter';
export type ShapeToolType = 'line' | 'rectangle' | 'oval' | 'arrow';
export type ToolType = 'select' | DrawToolType | 'eraser' | 'note' | ShapeToolType;

interface BaseAnnotation {
	id: string;
	color: string;
	width: number;
	// The document text this annotation covers, captured when it was
	// drawn. Optional and never relied on: extraction recomputes it
	// geometrically when it is absent, which is what lets highlights made
	// before this existed — and ones made in other PDF software — extract
	// too. Stored only as a shortcut, so the common case needs no text
	// layer at all.
	quote?: string;
	// What the user wrote about it. Serialized to the annotation’s own
	// /Contents, which is the standard field, so other PDF readers show
	// it as a tooltip rather than losing it.
	note?: string;
}

export interface StrokeAnnotation extends BaseAnnotation {
	kind: 'stroke';
	tool: DrawToolType;
	points: Point[];
}

// A comment pinned to a spot on the page. Unlike a stroke or a shape it
// has no extent of its own: it is a marker of fixed size, and the text
// is the content. `note` is required here where it is optional on the
// base, because a note annotation with nothing in it is not a note.
export interface NoteAnnotation extends BaseAnnotation {
	kind: 'note';
	at: Point;
	note: string;
}

export interface ShapeAnnotation extends BaseAnnotation {
	kind: 'shape';
	tool: ShapeToolType;
	start: Point;
	end: Point;
}

export type Annotation = StrokeAnnotation | ShapeAnnotation | NoteAnnotation;

// The marker a note annotation draws, in the surface’s own coordinate
// space. Fixed rather than derived from stroke width: a note has no
// width, and a marker that shrank with the pen would become untappable
// exactly when someone had chosen a fine pen to annotate densely.
export const NOTE_MARKER_SIZE = 18;

export interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export const DEFAULT_COLOR = '#1e1e1e';

// Named, not just hex: the swatches' tooltips read "Red" rather than
// "#e03131", which is what a person picking a pen color actually wants to
// see on hover.
export interface PresetColor {
	value: string;
	label: string;
}

// What a pen (and every shape, and a note marker) draws in: saturated inks
// meant to be read *as* marks on top of the page.
export const PEN_COLORS: readonly PresetColor[] = [
	{ value: DEFAULT_COLOR, label: 'Ink' },
	{ value: '#e03131', label: 'Red' },
	{ value: '#f08c00', label: 'Orange' },
	{ value: '#2f9e44', label: 'Green' },
	{ value: '#1971c2', label: 'Blue' },
	{ value: '#9c36b5', label: 'Purple' },
];

// What a highlighter draws in, which is a different job and so a different
// set: pale tints meant to colour the paper *under* the words rather than
// mark over them. The pen's inks are all far too dark for that — a
// highlighter is multiplied into the page (see HIGHLIGHTER_OPACITY), and
// multiplying #1e1e1e into a line of text just blacks it out.
//
// The two palettes are the same six hues from the same family, one rung
// bright and one rung pale, so the strip does not change character when the
// tool does.
export const HIGHLIGHTER_COLORS: readonly PresetColor[] = [
	{ value: '#ffd43b', label: 'Yellow' },
	{ value: '#a9e34b', label: 'Green' },
	{ value: '#ffa8a8', label: 'Pink' },
	{ value: '#66d9e8', label: 'Blue' },
	{ value: '#ffa94d', label: 'Orange' },
	{ value: '#d0bfff', label: 'Purple' },
];

// Every colour the plugin can label or offer anywhere, in one list. The
// settings tab's category names key off this rather than off PEN_COLORS
// alone, so a highlighter tint can carry a meaning ("Yellow = definition")
// the same way an ink colour can.
export const ALL_PRESET_COLORS: readonly PresetColor[] = [...PEN_COLORS, ...HIGHLIGHTER_COLORS];

// Which swatches the toolbar shows for a given tool. Only the highlighter
// differs; a shape or a note is drawn in ink like the pen is.
export function paletteFor(tool: ToolType): readonly PresetColor[] {
	return tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
}

export const DEFAULT_WIDTH = 3;

// A highlighter's default, in the same units. Freehand highlighting with a
// 3px nib is just a pale pen — a highlighter has to be about as tall as a
// line of text before it reads as one at all. (A highlighter dragged over
// real text is snapped to the line's own height instead; see
// highlightBarHeight in src/pdf/textLines.ts. This is what it draws with in
// a margin, over a diagram, or in an ink block with no text under it.)
export const DEFAULT_HIGHLIGHTER_WIDTH = 16;

// How strongly a highlighter tints the page beneath it.
//
// Applied as a *multiply*, not as paint laid over the top — on screen via
// the highlight layer's mix-blend-mode (styles.css), and in the file via a
// /BM /Multiply ExtGState (src/pdf/annotationSync.ts). That distinction is
// the whole reason highlights used to look wrong: source-over at any alpha
// puts colour *between* the reader and the words, so black text under a
// highlight came out grey and the page looked washed. Multiplied, the
// arithmetic protects the text for free — black times anything is black —
// and this number only ever controls how saturated the *paper* goes.
//
// Kept meaningfully below 1 for a second reason: it is also the annotation's
// /CA in the file, and that is how a stroke is told apart from a highlight
// when read back (see HIGHLIGHTER_OPACITY_MAX in src/pdf/annotationSync.ts).
export const HIGHLIGHTER_OPACITY = 0.6;

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 40;

// A tool's colour and width before the user has expressed any preference.
// Per tool rather than one global pair, because "the default" genuinely
// differs: a pen wants a fine dark nib and a highlighter wants a broad pale
// one, and starting the highlighter on the pen's defaults is what made it
// draw a hairline black smear the first time anyone reached for it.
export function defaultStyleFor(tool: ToolType): { color: string; width: number } {
	if (tool === 'highlighter') {
		return { color: HIGHLIGHTER_COLORS[0]?.value ?? DEFAULT_COLOR, width: DEFAULT_HIGHLIGHTER_WIDTH };
	}
	return { color: DEFAULT_COLOR, width: DEFAULT_WIDTH };
}
