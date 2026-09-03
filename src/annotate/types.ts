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

export const PRESET_COLORS: readonly string[] = [
	DEFAULT_COLOR,
	'#e03131',
	'#f08c00',
	'#2f9e44',
	'#1971c2',
	'#9c36b5',
];

export const DEFAULT_WIDTH = 3;
export const HIGHLIGHTER_OPACITY = 0.4;
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 40;
