export interface Point {
	x: number;
	y: number;
}

export type DrawToolType = 'pen' | 'highlighter';
export type ShapeToolType = 'line' | 'rectangle' | 'oval' | 'arrow';
export type ToolType = 'select' | DrawToolType | 'eraser' | ShapeToolType;

interface BaseAnnotation {
	id: string;
	color: string;
	width: number;
}

export interface StrokeAnnotation extends BaseAnnotation {
	kind: 'stroke';
	tool: DrawToolType;
	points: Point[];
}

export interface ShapeAnnotation extends BaseAnnotation {
	kind: 'shape';
	tool: ShapeToolType;
	start: Point;
	end: Point;
}

export type Annotation = StrokeAnnotation | ShapeAnnotation;

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
