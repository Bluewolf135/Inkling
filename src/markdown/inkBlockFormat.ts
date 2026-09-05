import type { Annotation, DrawToolType, Point, ShapeToolType } from '../annotate';

// The fenced-block language that marks an ink block in a note. Short and
// readable on purpose: it's what shows up in the raw Markdown, and someone
// reading the note outside Obsidian should be able to tell what it is.
export const INK_BLOCK_LANGUAGE = 'inkling';

// Bumped only for a change the current parser couldn't otherwise read.
// Present from the first release so a later format change has something to
// migrate *from* — the alternative (adding versioning once it's needed)
// means the oldest, least-recoverable blocks are the ones without it.
export const INK_BLOCK_VERSION = 1;

// The drawing surface's own coordinate space, which is what stroke
// coordinates below are in. Stored per block rather than assumed, so a
// block keeps its proportions if these defaults ever change, and so the
// rendered canvas can be scaled to whatever width the note is displayed at
// without touching the data (see inkBlock.ts).
export const DEFAULT_BLOCK_WIDTH = 800;
export const DEFAULT_BLOCK_HEIGHT = 450;

export interface InkBlockData {
	version: number;
	// A stable identity for this block, so a save can tell "this is an ink
	// block" apart from "this is *my* ink block".
	//
	// Every ink block in a note is an `inkling` fence, and Obsidian's
	// getSectionInfo can hand a block the line range of a *different* one
	// when several sit in the same note — which meant one block's drawing
	// could be written over another's, and appeared as the drawing from the
	// block above turning up duplicated in the block below.
	//
	// Optional because blocks written before this existed have none. Those
	// fall back to comparing the fence's whole body, and pick up an id the
	// first time they save.
	id?: string;
	width: number;
	height: number;
	annotations: Annotation[];
}

const DRAW_TOOLS: readonly string[] = ['pen', 'highlighter'];
const SHAPE_TOOLS: readonly string[] = ['line', 'rectangle', 'oval', 'arrow'];

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function readPoint(value: unknown): Point | null {
	if (typeof value !== 'object' || value === null) return null;
	const { x, y } = value as { x?: unknown; y?: unknown };
	return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : null;
}

// Everything below treats block content as untrusted input, because it is:
// notes sync between devices, get shared, and can be hand-edited, so a
// block can hold anything at all by the time it reaches here. A bad value
// yields null and the annotation is dropped, rather than throwing (which
// would take the whole note's render down with it) or being trusted into
// the renderer. Note this is a *shape* check — nothing here is ever
// interpreted as code or markup, and the renderer only ever draws to a
// canvas, so a hostile block's worst case is ink that looks wrong.
function readAnnotation(value: unknown): Annotation | null {
	if (typeof value !== 'object' || value === null) return null;
	const raw = value as Record<string, unknown>;

	const { id, color, width, kind, tool } = raw;
	if (typeof id !== 'string' || !id) return null;
	if (typeof color !== 'string' || !color) return null;
	if (!isFiniteNumber(width) || width <= 0) return null;
	if (typeof tool !== 'string') return null;

	if (kind === 'stroke') {
		if (!DRAW_TOOLS.includes(tool)) return null;
		if (!Array.isArray(raw.points)) return null;
		const points: Point[] = [];
		for (const entry of raw.points) {
			const point = readPoint(entry);
			// One bad point invalidates the stroke rather than silently
			// bending it somewhere else on the page.
			if (!point) return null;
			points.push(point);
		}
		if (points.length === 0) return null;
		return { id, color, width, kind: 'stroke', tool: tool as DrawToolType, points };
	}

	if (kind === 'shape') {
		if (!SHAPE_TOOLS.includes(tool)) return null;
		const start = readPoint(raw.start);
		const end = readPoint(raw.end);
		if (!start || !end) return null;
		return { id, color, width, kind: 'shape', tool: tool as ShapeToolType, start, end };
	}

	return null;
}

export function emptyInkBlock(): InkBlockData {
	return { version: INK_BLOCK_VERSION, width: DEFAULT_BLOCK_WIDTH, height: DEFAULT_BLOCK_HEIGHT, annotations: [] };
}

export interface ParseResult {
	data: InkBlockData;
	// True when the source held something this couldn't make sense of.
	// Callers surface it rather than quietly presenting a blank block —
	// silently discarding someone's handwriting (and then overwriting it on
	// the next edit) is the one failure here that isn't recoverable.
	malformed: boolean;
}

export function parseInkBlock(source: string): ParseResult {
	const trimmed = source.trim();
	if (!trimmed) return { data: emptyInkBlock(), malformed: false };

	let parsed: unknown;
	try {
		// Plain JSON.parse, never eval or Function — see the note above on
		// treating this as untrusted.
		parsed = JSON.parse(trimmed);
	} catch {
		return { data: emptyInkBlock(), malformed: true };
	}

	// Arrays are excluded explicitly, not incidentally: `typeof [] === 'object'`
	// and it isn't null, so a bare array otherwise fell through this check and
	// came back as a *valid* empty block — at which point the next edit
	// overwrote whatever the block really held. Silently discarding someone's
	// handwriting is the one failure here that isn't recoverable.
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { data: emptyInkBlock(), malformed: true };
	}
	const raw = parsed as Record<string, unknown>;

	const width = isFiniteNumber(raw.width) && raw.width > 0 ? raw.width : DEFAULT_BLOCK_WIDTH;
	const height = isFiniteNumber(raw.height) && raw.height > 0 ? raw.height : DEFAULT_BLOCK_HEIGHT;
	const version = isFiniteNumber(raw.version) ? raw.version : INK_BLOCK_VERSION;

	const annotations: Annotation[] = [];
	let droppedAny = false;
	if (Array.isArray(raw.annotations)) {
		for (const entry of raw.annotations) {
			const annotation = readAnnotation(entry);
			if (annotation) annotations.push(annotation);
			else droppedAny = true;
		}
	} else if (raw.annotations !== undefined) {
		droppedAny = true;
	}

	// A block written by a *newer* version of the plugin may legitimately
	// hold things this build can't represent, so flag it rather than
	// pretending the result is complete — the caller refuses to overwrite
	// on that basis.
	const fromFuture = version > INK_BLOCK_VERSION;

	const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;

	return { data: { version, id, width, height, annotations }, malformed: droppedAny || fromFuture };
}

// The block's identity, read without parsing the rest of it — used when a
// save has to confirm the fence it is about to overwrite is its own and not
// a neighbour's. Returns null for anything unreadable, which the caller
// treats as "can't confirm", never as "matches".
export function readInkBlockId(source: string): string | null {
	try {
		const parsed: unknown = JSON.parse(source.trim());
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		const id = (parsed as { id?: unknown }).id;
		return typeof id === 'string' && id ? id : null;
	} catch {
		return null;
	}
}

export function serializeInkBlock(data: InkBlockData): string {
	// Compact rather than pretty-printed: this sits inside the user's own
	// note, where a few hundred lines of formatted JSON per drawing would
	// swamp the actual writing around it.
	return JSON.stringify({
		version: INK_BLOCK_VERSION,
		// First, so a block's identity is readable without parsing past the
		// stroke data — which for a densely drawn block is most of the line.
		...(data.id ? { id: data.id } : {}),
		width: data.width,
		height: data.height,
		annotations: data.annotations,
	});
}

export function inkBlockMarkdown(data: InkBlockData = emptyInkBlock()): string {
	return `\`\`\`${INK_BLOCK_LANGUAGE}\n${serializeInkBlock(data)}\n\`\`\``;
}
