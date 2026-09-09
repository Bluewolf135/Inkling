import { describe, expect, it } from 'vitest';
import { recognizeShape } from '../../src/annotate/recognize';
import type { Point } from '../../src/annotate/types';

// A seeded generator, not Math.random: a recognition test that passes four
// times in five is worse than no test, because the failure arrives on
// someone else's machine with no way to reproduce it.
function jitter(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296 - 0.5;
	};
}

function circle(radius: number, wobble = 0, seed = 7): Point[] {
	const noise = jitter(seed);
	const points: Point[] = [];
	for (let step = 0; step <= 40; step++) {
		const angle = (step / 40) * Math.PI * 2;
		const r = radius + noise() * wobble;
		points.push({ x: 200 + Math.cos(angle) * r, y: 200 + Math.sin(angle) * r });
	}
	return points;
}

// An oval that is not a circle — which is what a hand actually draws, and
// what every circle helper in this file was carefully not producing.
function ellipse(a: number, b: number, wobble = 0, seed = 5): Point[] {
	const noise = jitter(seed);
	const points: Point[] = [];
	for (let step = 0; step <= 44; step++) {
		const angle = (step / 44) * Math.PI * 2;
		points.push({ x: 200 + Math.cos(angle) * a + noise() * wobble, y: 200 + Math.sin(angle) * b + noise() * wobble });
	}
	return points;
}

function box(size: number, wobble = 0, seed = 11): Point[] {
	const noise = jitter(seed);
	const corners: Point[] = [
		{ x: 100, y: 100 },
		{ x: 100 + size, y: 100 },
		{ x: 100 + size, y: 100 + size },
		{ x: 100, y: 100 + size },
		{ x: 100, y: 100 },
	];
	const points: Point[] = [];
	for (let index = 1; index < corners.length; index++) {
		const from = corners[index - 1];
		const to = corners[index];
		if (!from || !to) continue;
		for (let step = 0; step < 12; step++) {
			const t = step / 12;
			points.push({
				x: from.x + (to.x - from.x) * t + noise() * wobble,
				y: from.y + (to.y - from.y) * t + noise() * wobble,
			});
		}
	}
	points.push({ x: 100, y: 100 });
	return points;
}

function drag(from: Point, to: Point, wobble = 0, seed = 3): Point[] {
	const noise = jitter(seed);
	const points: Point[] = [];
	for (let step = 0; step <= 20; step++) {
		const t = step / 20;
		points.push({
			x: from.x + (to.x - from.x) * t + noise() * wobble,
			y: from.y + (to.y - from.y) * t + noise() * wobble,
		});
	}
	return points;
}

describe('recognizeShape', () => {
	it('recognises a hand-drawn circle', () => {
		expect(recognizeShape(circle(80, 6))?.tool).toBe('oval');
	});

	it('recognises a hand-drawn box', () => {
		expect(recognizeShape(box(120, 5))?.tool).toBe('rectangle');
	});

	it('recognises a hand-drawn line', () => {
		expect(recognizeShape(drag({ x: 20, y: 40 }, { x: 300, y: 60 }, 4))?.tool).toBe('line');
	});

	it('gives a recognised shape the stroke’s own bounds', () => {
		const recognized = recognizeShape(box(120, 2));
		expect(recognized?.start.x).toBeCloseTo(100, -1);
		expect(recognized?.end.x).toBeCloseTo(220, -1);
	});

	it('gives a recognised line the stroke’s own endpoints', () => {
		// Where the pen actually started and stopped, jitter included — a
		// snapped line that began somewhere the pen never touched would
		// read as the shape jumping.
		const recognized = recognizeShape(drag({ x: 20, y: 40 }, { x: 300, y: 60 }, 2));
		expect(recognized?.start.x).toBeCloseTo(20, -1);
		expect(recognized?.start.y).toBeCloseTo(40, -1);
		expect(recognized?.end.x).toBeCloseTo(300, -1);
	});

	it('refuses a scribble', () => {
		// The cost of a false negative is that nothing happens, which is what
		// the user was going to get anyway. The cost of a false positive is a
		// word of handwriting silently replaced by a rectangle.
		const scribble: Point[] = [];
		const noise = jitter(99);
		for (let step = 0; step < 60; step++) {
			scribble.push({ x: 100 + step * 3 + noise() * 40, y: 100 + Math.sin(step) * 30 + noise() * 40 });
		}
		expect(recognizeShape(scribble)).toBeNull();
	});

	it('refuses a letter', () => {
		// A cursive "e": open, curved, and nothing like a line.
		const letter: Point[] = [];
		for (let step = 0; step <= 30; step++) {
			const t = (step / 30) * Math.PI * 1.6;
			letter.push({ x: 100 + Math.cos(t) * 20, y: 100 + Math.sin(t * 1.5) * 25 });
		}
		expect(recognizeShape(letter)).toBeNull();
	});

	it('refuses a stroke too short to have a shape', () => {
		expect(recognizeShape([])).toBeNull();
		expect(recognizeShape([{ x: 1, y: 1 }])).toBeNull();
		expect(recognizeShape(drag({ x: 0, y: 0 }, { x: 10, y: 0 }).slice(0, 4))).toBeNull();
	});

	it('refuses a stroke with no length at all', () => {
		const held = Array.from({ length: 20 }, () => ({ x: 50, y: 50 }));
		expect(recognizeShape(held)).toBeNull();
	});

	it('tells a wobbly box from a wobbly circle', () => {
		// The one distinction most likely to go wrong, so it gets its own
		// test at a jitter level a real hand produces.
		expect(recognizeShape(box(150, 8))?.tool).toBe('rectangle');
		expect(recognizeShape(circle(75, 8))?.tool).toBe('oval');
	});

	// Reported from use: shapes snapped to squares and lines, and a circle
	// could not be drawn at all. Every circle above is a *perfect* one, which
	// is why nothing here caught it — a hand draws an ellipse, and an ellipse
	// only 1.3x wider than tall used to score 0.089 against a 0.07 threshold
	// and come out a rectangle. The radial measure is taken on the loop
	// squashed into a unit box now, so proportion no longer decides it.
	describe('an oval that is not a circle', () => {
		it('snaps to an oval at every aspect a hand produces', () => {
			for (const [a, b] of [
				[90, 70],
				[100, 60],
				[120, 40],
				[40, 120],
			]) {
				expect(recognizeShape(ellipse(a ?? 0, b ?? 0, 6))?.tool, `${a}x${b}`).toBe('oval');
			}
		});

		it('still calls a wide box a box', () => {
			// The fix must not buy circles by giving up rectangles: a
			// normalised square scores 0.115, well clear of the threshold.
			const wide: Point[] = [];
			const noise = jitter(11);
			const corners = [
				{ x: 100, y: 100 },
				{ x: 400, y: 100 },
				{ x: 400, y: 200 },
				{ x: 100, y: 200 },
				{ x: 100, y: 100 },
			];
			for (let index = 1; index < corners.length; index++) {
				const from = corners[index - 1];
				const to = corners[index];
				if (!from || !to) continue;
				for (let step = 0; step < 14; step++) {
					const t = step / 14;
					wide.push({ x: from.x + (to.x - from.x) * t + noise() * 6, y: from.y + (to.y - from.y) * t + noise() * 6 });
				}
			}
			wide.push({ x: 100, y: 100 });
			expect(recognizeShape(wide)?.tool).toBe('rectangle');
		});

		it('gives the oval the bounds the pen drew, not a square', () => {
			// Normalising is only how the loop is *judged*. The shape that
			// lands keeps the proportions of the stroke, or a wide oval drawn
			// round a phrase would snap into a circle over one word.
			const recognized = recognizeShape(ellipse(120, 40, 2));
			expect(recognized).not.toBeNull();
			if (!recognized) return;
			const width = recognized.end.x - recognized.start.x;
			const height = recognized.end.y - recognized.start.y;
			expect(width / height).toBeCloseTo(3, 0);
		});
	});
});
