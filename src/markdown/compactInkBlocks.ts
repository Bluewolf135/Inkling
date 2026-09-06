import { SIMPLIFY_EPSILON, simplifyPoints } from '../annotate/simplify';
import { Annotation } from '../annotate/types';
import { INK_BLOCK_LANGUAGE, parseInkBlock, serializeInkBlock } from './inkBlockFormat';

export interface CompactResult {
	content: string;
	// Blocks actually rewritten.
	blocks: number;
	// Blocks deliberately left alone because they could not be fully read.
	skipped: number;
	pointsBefore: number;
	pointsAfter: number;
}

function isOpeningFence(line: string | undefined): boolean {
	const trimmed = line?.trimStart() ?? '';
	return trimmed.startsWith('```') && trimmed.includes(INK_BLOCK_LANGUAGE);
}

function isClosingFence(line: string | undefined): boolean {
	return (line?.trimStart() ?? '').startsWith('```');
}

function countPoints(annotations: Annotation[]): number {
	let total = 0;
	for (const annotation of annotations) {
		if (annotation.kind === 'stroke') total += annotation.points.length;
	}
	return total;
}

function simplifyAnnotations(annotations: Annotation[]): Annotation[] {
	return annotations.map((annotation) => {
		if (annotation.kind !== 'stroke') return annotation;
		const points = simplifyPoints(annotation.points, SIMPLIFY_EPSILON);
		return points.length === annotation.points.length ? annotation : { ...annotation, points };
	});
}

// Rewrites every ink block in a note with its strokes thinned, the way a
// stroke drawn today is thinned the moment it commits (see
// annotate/simplify.ts).
//
// This exists because that thinning only applies to new ink: a block
// written before it keeps every sample it captured until something rewrites
// it, and the notes that most need it are the oldest and densest ones. On a
// note of fourteen blocks that is most of the file, most of the parse on
// open, and most of what a live-replicating vault re-uploads on every save.
//
// Epsilon is applied in stored units, which is the space it is documented
// in: half a unit in an 800-wide block is under half a pixel as displayed.
//
// A block that cannot be fully parsed is left exactly as it was, and
// counted in `skipped`. That is the same rule the save path follows, for
// the same reason — rewriting something we only partly understood would
// discard the part we did not, and there is no getting it back.
export function compactInkBlocks(source: string): CompactResult {
	const lines = source.split('\n');
	const out: string[] = [];

	let blocks = 0;
	let skipped = 0;
	let pointsBefore = 0;
	let pointsAfter = 0;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!isOpeningFence(line)) {
			out.push(line ?? '');
			continue;
		}

		let close = index + 1;
		while (close < lines.length && !isClosingFence(lines[close])) close++;
		// An unterminated fence is not a block, it is the rest of the file.
		// Copy it through rather than guessing where it was meant to end.
		if (close >= lines.length) {
			out.push(line ?? '');
			continue;
		}

		const body = lines.slice(index + 1, close).join('\n');
		const { data, malformed } = parseInkBlock(body);

		if (malformed) {
			skipped++;
			for (let copy = index; copy <= close; copy++) out.push(lines[copy] ?? '');
			index = close;
			continue;
		}

		const before = countPoints(data.annotations);
		const annotations = simplifyAnnotations(data.annotations);
		const after = countPoints(annotations);

		pointsBefore += before;
		pointsAfter += after;

		// Nothing to gain here, so nothing is rewritten. Re-serializing
		// anyway would still change the bytes — a parsed annotation comes
		// back with its keys in the parser's order rather than the order it
		// was written in — and that would be a no-op edit to every block in
		// the note, re-uploaded through a replicating vault for no benefit.
		if (after === before) {
			for (let copy = index; copy <= close; copy++) out.push(lines[copy] ?? '');
			index = close;
			continue;
		}

		blocks++;
		out.push(line ?? '');
		out.push(serializeInkBlock({ ...data, annotations }));
		out.push(lines[close] ?? '');
		index = close;
	}

	return { content: out.join('\n'), blocks, skipped, pointsBefore, pointsAfter };
}
