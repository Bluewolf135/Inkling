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
});
