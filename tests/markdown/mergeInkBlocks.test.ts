import { describe, expect, it } from 'vitest';
import { mergeInkBlocks } from '../../src/markdown/mergeInkBlocks';
import { emptyInkBlock, type InkBlockData } from '../../src/markdown/inkBlockFormat';
import type { Annotation } from '../../src/annotate/types';

// A block being torn down flushes its pending write, and teardown often
// happens *because* the file changed underneath it — a sync landing inside
// the debounce is exactly the case. Until now that write overwrote whatever
// the fence held, so the other device's strokes were lost silently.
//
// Refusing instead would lose ours instead of theirs, which is no better. A
// three-way merge is possible here because all three sides are in hand:
// what this view read (base), what it holds (ours), and what the file says
// now (theirs). Annotations are independent records with stable ids, so the
// merge is well defined rather than a guess.

function stroke(id: string, x = 0): Annotation {
	return {
		id,
		kind: 'stroke',
		tool: 'pen',
		color: '#1e1e1e',
		width: 2,
		points: [
			{ x, y: 0 },
			{ x: x + 10, y: 10 },
		],
	};
}

function block(annotations: Annotation[], extra: Partial<InkBlockData> = {}): InkBlockData {
	return { ...emptyInkBlock(), id: 'ink-1', annotations, ...extra };
}

const ids = (data: InkBlockData): string[] => data.annotations.map((a) => a.id);

// Annotation is a union and only a stroke has points, so the narrowing has
// to be explicit rather than assumed.
function firstX(data: InkBlockData): number | undefined {
	const first = data.annotations[0];
	return first && first.kind === 'stroke' ? first.points[0]?.x : undefined;
}

describe('mergeInkBlocks', () => {
	it('keeps both sides when each drew something new', () => {
		const base = block([stroke('shared')]);
		const ours = block([stroke('shared'), stroke('ours')]);
		const theirs = block([stroke('shared'), stroke('theirs')]);

		expect(ids(mergeInkBlocks(base, ours, theirs)).sort()).toEqual(['ours', 'shared', 'theirs']);
	});

	it('honours a stroke we erased', () => {
		const base = block([stroke('a'), stroke('b')]);
		const ours = block([stroke('a')]);
		const theirs = block([stroke('a'), stroke('b')]);

		expect(ids(mergeInkBlocks(base, ours, theirs))).toEqual(['a']);
	});

	it('honours a stroke they erased', () => {
		const base = block([stroke('a'), stroke('b')]);
		const ours = block([stroke('a'), stroke('b')]);
		const theirs = block([stroke('a')]);

		expect(ids(mergeInkBlocks(base, ours, theirs))).toEqual(['a']);
	});

	it('takes our version of a stroke we changed', () => {
		const base = block([stroke('a', 0)]);
		const ours = block([stroke('a', 99)]);
		const theirs = block([stroke('a', 0)]);

		expect(firstX(mergeInkBlocks(base, ours, theirs))).toBe(99);
	});

	it('takes their version of a stroke only they changed', () => {
		const base = block([stroke('a', 0)]);
		const ours = block([stroke('a', 0)]);
		const theirs = block([stroke('a', 77)]);

		expect(firstX(mergeInkBlocks(base, ours, theirs))).toBe(77);
	});

	it('prefers ours when both changed the same stroke', () => {
		// Someone has to win and it cannot be decided from the data. Ours is
		// the side whose pen just moved, so ours is the side still on screen.
		const base = block([stroke('a', 0)]);
		const ours = block([stroke('a', 11)]);
		const theirs = block([stroke('a', 22)]);

		expect(firstX(mergeInkBlocks(base, ours, theirs))).toBe(11);
	});

	it('keeps a stroke we changed even though they erased it', () => {
		// A deletion is cheap to redo and a stroke is not. Losing work is the
		// failure this whole path exists to prevent.
		const base = block([stroke('a', 0)]);
		const ours = block([stroke('a', 42)]);
		const theirs = block([]);

		expect(ids(mergeInkBlocks(base, ours, theirs))).toEqual(['a']);
	});

	it('changes nothing when all three agree', () => {
		const base = block([stroke('a'), stroke('b')]);

		expect(ids(mergeInkBlocks(base, block([stroke('a'), stroke('b')]), block([stroke('a'), stroke('b')])))).toEqual([
			'a',
			'b',
		]);
	});

	it('never duplicates a stroke both sides added under the same id', () => {
		const base = block([]);
		const ours = block([stroke('same', 1)]);
		const theirs = block([stroke('same', 2)]);

		expect(ids(mergeInkBlocks(base, ours, theirs))).toEqual(['same']);
	});

	it('keeps their order and puts our additions after it', () => {
		// Annotations paint in array order, so a merge that shuffled them
		// would silently restack overlapping ink.
		const base = block([stroke('x')]);
		const ours = block([stroke('x'), stroke('mine')]);
		const theirs = block([stroke('x'), stroke('t1'), stroke('t2')]);

		expect(ids(mergeInkBlocks(base, ours, theirs))).toEqual(['x', 't1', 't2', 'mine']);
	});

	describe('the block’s own fields', () => {
		it('takes our caption when we are the ones who changed it', () => {
			const base = block([], { caption: 'old' });
			const ours = block([], { caption: 'ours' });
			const theirs = block([], { caption: 'old' });

			expect(mergeInkBlocks(base, ours, theirs).caption).toBe('ours');
		});

		it('takes their caption when only they changed it', () => {
			const base = block([], { caption: 'old' });
			const ours = block([], { caption: 'old' });
			const theirs = block([], { caption: 'theirs' });

			expect(mergeInkBlocks(base, ours, theirs).caption).toBe('theirs');
		});

		it('keeps a resize we made', () => {
			const base = block([], { width: 800, height: 450 });
			const ours = block([], { width: 600, height: 400 });
			const theirs = block([], { width: 800, height: 450 });

			const merged = mergeInkBlocks(base, ours, theirs);
			expect([merged.width, merged.height]).toEqual([600, 400]);
		});

		it('keeps a resize they made', () => {
			const base = block([], { width: 800, height: 450 });
			const ours = block([], { width: 800, height: 450 });
			const theirs = block([], { width: 1000, height: 500 });

			const merged = mergeInkBlocks(base, ours, theirs);
			expect([merged.width, merged.height]).toEqual([1000, 500]);
		});
	});
});
