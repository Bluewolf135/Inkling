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

// A circle as a hand actually draws one, which is not an ellipse plus
// jitter. Three things the generators above leave out, all of which the
// classifier has to survive:
//
//  - Low-frequency lumpiness. A hand's error is two or three broad bulges
//    around the loop, not independent per-sample noise. Jitter averages out
//    of a variance; lumps do not, and that is exactly why the previous fix
//    passed its tests and still could not classify a real circle.
//  - Uneven sampling. Pointer events arrive on a clock, so the pen leaves
//    more samples where it slowed down.
//  - An overshoot. The stroke carries past where it started rather than
//    meeting it.
function handCircle(seed: number, options: { radius?: number; lump?: number; tail?: number; aspect?: number } = {}): Point[] {
	const { radius = 90, lump = 0.1, tail = 0.1, aspect = 1 } = options;
	const noise = jitter(seed);
	const phase = [noise() * 6, noise() * 6, noise() * 6];
	const amp = [lump * (0.6 + noise()), lump * (0.5 + noise()) * 0.7, lump * (0.4 + noise()) * 0.5];
	const points: Point[] = [];
	for (let angle = 0; angle < Math.PI * 2 * (1 + tail); angle += 0.1 + 0.07 * (1 + Math.sin(angle * 1.7 + (phase[2] ?? 0)))) {
		const r =
			radius *
			(1 +
				(amp[0] ?? 0) * Math.sin(2 * angle + (phase[0] ?? 0)) +
				(amp[1] ?? 0) * Math.sin(3 * angle + (phase[1] ?? 0)) +
				(amp[2] ?? 0) * Math.sin(4 * angle + (phase[2] ?? 0)));
		points.push({ x: 300 + Math.cos(angle) * r * aspect, y: 300 + Math.sin(angle) * r });
	}
	return points;
}

// A box as a hand actually draws one: corners rounded off, edges bowed,
// sampled unevenly, closed with an overshoot. The rounded corners are the
// part that matters — they are what pulls a box toward a circle, so this is
// the generator that says whether circles were bought at their expense.
function handBox(seed: number, options: { w?: number; h?: number; round?: number; bow?: number } = {}): Point[] {
	const { w = 240, h = 200, round = 0.14, bow = 0.03 } = options;
	const noise = jitter(seed);
	const radius = Math.min(w, h) * round;
	const x0 = 120;
	const y0 = 140;
	const x1 = x0 + w;
	const y1 = y0 + h;
	const sides: Array<[Point, Point, number, number]> = [
		[{ x: x0 + radius, y: y0 }, { x: x1 - radius, y: y0 }, 0, -1],
		[{ x: x1, y: y0 + radius }, { x: x1, y: y1 - radius }, 1, 0],
		[{ x: x1 - radius, y: y1 }, { x: x0 + radius, y: y1 }, 0, 1],
		[{ x: x0, y: y1 - radius }, { x: x0, y: y0 + radius }, -1, 0],
	];
	const corners: Array<[Point, number, number]> = [
		[{ x: x1 - radius, y: y0 + radius }, -Math.PI / 2, 0],
		[{ x: x1 - radius, y: y1 - radius }, 0, Math.PI / 2],
		[{ x: x0 + radius, y: y1 - radius }, Math.PI / 2, Math.PI],
		[{ x: x0 + radius, y: y0 + radius }, Math.PI, Math.PI * 1.5],
	];

	const points: Point[] = [];
	for (let index = 0; index < 4; index++) {
		const side = sides[index];
		const corner = corners[index];
		if (!side || !corner) continue;
		const [from, to, nx, ny] = side;
		const span = Math.hypot(to.x - from.x, to.y - from.y);
		const depth = span * bow * (1 + noise());
		const steps = Math.max(4, Math.round(span / 14));
		for (let step = 0; step <= steps; step++) {
			const t = step / steps;
			const push = Math.sin(t * Math.PI) * depth;
			points.push({ x: from.x + (to.x - from.x) * t + nx * push, y: from.y + (to.y - from.y) * t + ny * push });
		}
		const [centre, fromAngle, toAngle] = corner;
		for (let step = 1; step < 5; step++) {
			const a = fromAngle + (toAngle - fromAngle) * (step / 5);
			points.push({ x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius });
		}
	}
	// The overshoot: back over the first few samples of the first side.
	for (let step = 0; step < Math.round(points.length * 0.06); step++) {
		const repeated = points[step];
		if (repeated) points.push(repeated);
	}
	return points;
}

// A closed loop through the given corners — the shapes there is no tool for,
// which have to be refused rather than rounded to the nearer of the two.
function polygon(corners: Point[], perSide: number, seed: number, wobble = 3): Point[] {
	const noise = jitter(seed);
	const points: Point[] = [];
	for (let index = 0; index < corners.length; index++) {
		const from = corners[index];
		const to = corners[(index + 1) % corners.length];
		if (!from || !to) continue;
		for (let step = 0; step < perSide; step++) {
			const t = step / perSide;
			points.push({ x: from.x + (to.x - from.x) * t + noise() * wobble, y: from.y + (to.y - from.y) * t + noise() * wobble });
		}
	}
	const first = points[0];
	if (first) points.push({ ...first });
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

		it('gives the oval the bounds the pen drew, not a square (perfect ellipse)', () => {
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

	// Reported from use a second time: circles still snapped to squares,
	// against a suite that was passing. Everything above generates a
	// mathematically exact figure and adds independent per-sample jitter,
	// and jitter is not what a hand does — a hand is lumpy at low frequency,
	// samples unevenly, and overshoots the close. Jitter averages out of a
	// variance and lumpiness does not, so the old measure scored realistic
	// circles at 0.055-0.134 and realistic boxes at 0.073-0.093: ranges that
	// overlap, with no threshold to put between them.
	//
	// So these strokes are shaped like a hand's, and the classifier scores
	// the loop against both shapes it can draw rather than against one
	// abstract property of roundness. That is what has margin: every case
	// below fits its own shape at least twice as closely as the other.
	describe('strokes shaped like a hand’s', () => {
		it('calls a lumpy, unevenly sampled, overshooting loop an oval', () => {
			// The reported bug. Every one of these came out 'rectangle'.
			for (const seed of [3, 17, 42, 91, 128]) {
				expect(recognizeShape(handCircle(seed))?.tool, `seed ${seed}`).toBe('oval');
			}
		});

		it('still calls one an oval when it is lumpier still', () => {
			expect(recognizeShape(handCircle(23, { lump: 0.16 }))?.tool).toBe('oval');
		});

		it('calls a lumpy oval an oval at any aspect', () => {
			expect(recognizeShape(handCircle(51, { aspect: 1.6 }))?.tool).toBe('oval');
			expect(recognizeShape(handCircle(64, { aspect: 2.5 }))?.tool).toBe('oval');
		});

		it('is not thrown by an overshoot past the start', () => {
			expect(recognizeShape(handCircle(77, { tail: 0.2 }))?.tool).toBe('oval');
		});

		it('gives up on a loop that carries a quarter turn past its own start', () => {
			// Not this classifier's doing and not the reported bug: CLOSURE_RATIO
			// measures the gap between the endpoints against the path length, and
			// a stroke that runs a quarter turn long has endpoints too far apart
			// to read as a loop at all, so it never reaches the shape test. Pinned
			// because it is the edge of what snapping handles, and because it
			// fails the safe way — the freehand stroke is simply kept.
			expect(recognizeShape(handCircle(77, { tail: 0.24 }))).toBeNull();
		});

		it('has not bought circles at the expense of boxes', () => {
			// The other half of the trade, and the half a looser threshold
			// would have lost. Rounded corners are what pull a box toward a
			// circle, so a box drawn with them is the case that matters.
			for (const seed of [5, 31, 60]) {
				expect(recognizeShape(handBox(seed))?.tool, `seed ${seed}`).toBe('rectangle');
			}
			expect(recognizeShape(handBox(12, { round: 0.26 }))?.tool, 'very rounded').toBe('rectangle');
			expect(recognizeShape(handBox(19, { bow: 0.06 }))?.tool, 'bowed edges').toBe('rectangle');
			expect(recognizeShape(handBox(44, { w: 360, h: 120 }))?.tool, 'wide').toBe('rectangle');
			expect(recognizeShape(handBox(70, { w: 220, h: 210 }))?.tool, 'near-square').toBe('rectangle');
		});

		it('refuses a closed shape it has no tool for', () => {
			// Scoring both candidates and taking the nearer would make a
			// triangle whichever of the two it sat closer to. A shape that is
			// close to neither is left as drawn instead: these all sit at
			// 0.093 or worse against a 0.06 bound, because they are not a
			// near-miss of anything.
			expect(recognizeShape(polygon([{ x: 200, y: 100 }, { x: 320, y: 300 }, { x: 80, y: 300 }], 14, 8)), 'triangle').toBeNull();
			expect(
				recognizeShape(polygon([{ x: 200, y: 100 }, { x: 320, y: 200 }, { x: 200, y: 300 }, { x: 80, y: 200 }], 12, 4)),
				'diamond',
			).toBeNull();

			const figureEight: Point[] = [];
			for (let step = 0; step <= 60; step++) {
				const t = (step / 60) * Math.PI * 2;
				figureEight.push({ x: 200 + Math.sin(t) * 90, y: 200 + Math.sin(t * 2) * 60 });
			}
			expect(recognizeShape(figureEight), 'figure eight').toBeNull();
		});
	});
});
