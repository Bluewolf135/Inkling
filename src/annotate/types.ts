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

export const PRESET_COLORS: readonly PresetColor[] = [
	{ value: DEFAULT_COLOR, label: 'Ink' },
	{ value: '#e03131', label: 'Red' },
	{ value: '#f08c00', label: 'Orange' },
	{ value: '#2f9e44', label: 'Green' },
	{ value: '#1971c2', label: 'Blue' },
	{ value: '#9c36b5', label: 'Purple' },
];

export const DEFAULT_WIDTH = 3;
export const HIGHLIGHTER_OPACITY = 0.4;
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 40;
