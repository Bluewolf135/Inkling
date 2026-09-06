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
	const { x, y, p } = value as { x?: unknown; y?: unknown; p?: unknown };
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

	const point: Point = { x, y };
	// Pressure was written but never read back, so a block saved a
	// tapered stroke and then redrew it flat about a second later, when
	// its own save re-rendered it. Out of range is dropped rather than
	// clamped: a value outside 0-1 did not come from a stylus, and
	// inventing a pressure is worse than having none.
	if (isFiniteNumber(p) && p >= 0 && p <= 1) point.p = p;
	return point;
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

// How precisely stroke coordinates are written into the note.
//
// A tenth of a unit is far finer than a pen tip: a block is stored 800
// units wide and shown around 700 CSS pixels, so 0.1 units is under a
// tenth of a pixel. JSON.stringify writes full float precision by
// default — "123.45678901234567" for a coordinate whose last twelve
// digits nobody can see — and with every stylus sample now captured
// (see annotate/pointer.ts) that is the bulk of the note.
//
// Measured on a five-second handwriting stroke at 120Hz: 42,302 bytes
// as written before, 18,082 after. That is parsing cost on every
// render, sync traffic on every save, and a wall of digits in the
// middle of the file.
const COORDINATE_DECIMALS = 1;
const PRESSURE_DECIMALS = 2;

function round(value: number, decimals: number): number {
	// The unary + drops a trailing ".0", which toFixed would otherwise
	// keep and JSON.stringify would faithfully write out.
	return +value.toFixed(decimals);
}

function compactPoint(point: Point): Point {
	const compact: Point = { x: round(point.x, COORDINATE_DECIMALS), y: round(point.y, COORDINATE_DECIMALS) };
	if (point.p !== undefined) compact.p = round(point.p, PRESSURE_DECIMALS);
	return compact;
}

// Rounds coordinates for storage without touching the annotations the
// surface is still drawing from — rounding those in place would move
// live ink under the pen, by a fraction of a pixel, on every save.
function compactAnnotation(annotation: Annotation): Annotation {
	if (annotation.kind === 'stroke') return { ...annotation, points: annotation.points.map(compactPoint) };
	if (annotation.kind === 'shape') {
		return { ...annotation, start: compactPoint(annotation.start), end: compactPoint(annotation.end) };
	}
	return annotation;
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
		annotations: data.annotations.map(compactAnnotation),
	});
}

export function inkBlockMarkdown(data: InkBlockData = emptyInkBlock()): string {
	return `\`\`\`${INK_BLOCK_LANGUAGE}\n${serializeInkBlock(data)}\n\`\`\``;
}

export interface InkBlockRange {
	// The fence lines themselves: the opening ```inkling and the closing ```.
	lineStart: number;
	lineEnd: number;
}

function isOpeningFence(line: string | undefined): boolean {
	const trimmed = line?.trimStart() ?? '';
	return trimmed.startsWith('```') && trimmed.includes(INK_BLOCK_LANGUAGE);
}

function isClosingFence(line: string | undefined): boolean {
	return (line?.trimStart() ?? '').startsWith('```');
}

// Finds a specific ink block in a note, by its own id.
//
// This exists because Obsidian's `getSectionInfo` cannot be trusted to say
// where a block is when a note holds several of them — it hands one block
// the line range of another, which is how a drawing ended up duplicated
// into its neighbour, and how refusing that write then lost the drawing
// instead. Searching the note for the block that actually carries our id
// answers the question directly rather than trusting a report of it.
//
// Returns null when there is no such block: it may not have been written
// yet, or the note may have been edited out from under us. The caller must
// treat that as "do not write anywhere", never as "write wherever you were
// told".
export function findInkBlockById(lines: readonly string[], blockId: string): InkBlockRange | null {
	if (!blockId) return null;

	for (let index = 0; index < lines.length; index++) {
		if (!isOpeningFence(lines[index])) continue;

		let close = index + 1;
		while (close < lines.length && !isClosingFence(lines[close])) close++;
		if (close >= lines.length) return null;

		const body = lines.slice(index + 1, close).join('\n');
		if (readInkBlockId(body) === blockId) return { lineStart: index, lineEnd: close };

		// Resume past this block's closing fence, so its contents can't be
		// mistaken for the start of another one.
		index = close;
	}

	return null;
}

// Finds the ink block whose body is exactly `body`, but only when the note
// holds precisely one of them.
//
// This is how a block with no id of its own gets located, and the
// uniqueness requirement is the whole point. Two ink blocks nobody has
// drawn in yet are byte-identical — the same fifty-five characters of empty
// JSON — so their text is not an identity, it is a description that fits
// both.
//
// Trusting it anyway is how a note lost work. Obsidian's getSectionInfo
// can hand a block the line range of a *different* block, the range was
// checked by comparing text, two empty blocks compared equal, and the save
// went through: one block's drawing written into another block's fence,
// which from the outside looks exactly like the work in the first block
// vanishing the moment the second one was touched.
//
// Returning null when the answer is ambiguous makes the save fail instead,
// and a failed save keeps the ink (see unsavedInk in markdown/inkBlock.ts)
// rather than putting it somewhere it does not belong.
export function findUniqueInkBlockByBody(lines: readonly string[], body: string): InkBlockRange | null {
	const wanted = body.trim();
	if (!wanted) return null;

	let found: InkBlockRange | null = null;
	for (let index = 0; index < lines.length; index++) {
		if (!isOpeningFence(lines[index])) continue;

		let close = index + 1;
		while (close < lines.length && !isClosingFence(lines[close])) close++;
		if (close >= lines.length) return null;

		if (lines.slice(index + 1, close).join('\n').trim() === wanted) {
			// A second match means the text identifies nothing.
			if (found) return null;
			found = { lineStart: index, lineEnd: close };
		}

		index = close;
	}

	return found;
}
