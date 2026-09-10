import { describe, expect, it } from 'vitest';
import { maxWriteIntervalMs } from '../../src/pdf/saveCadence';

const MB = 1024 * 1024;

describe('maxWriteIntervalMs', () => {
	it('saves a small note often', () => {
		expect(maxWriteIntervalMs(0)).toBe(10_000);
		expect(maxWriteIntervalMs(4 * MB)).toBe(10_000);
	});

	it('backs off for a mid-sized document', () => {
		expect(maxWriteIntervalMs(5 * MB)).toBe(30_000);
		expect(maxWriteIntervalMs(25 * MB)).toBe(30_000);
	});

	it('backs off further for a large textbook', () => {
		expect(maxWriteIntervalMs(26 * MB)).toBe(60_000);
		expect(maxWriteIntervalMs(400 * MB)).toBe(60_000);
	});

	it('treats an unknown size as small rather than stalling saves', () => {
		// file.stat.size should always be there, but a missing or nonsense
		// value must not silently push a note to minute-long saves.
		expect(maxWriteIntervalMs(Number.NaN)).toBe(10_000);
		expect(maxWriteIntervalMs(Number.POSITIVE_INFINITY)).toBe(10_000);
		expect(maxWriteIntervalMs(-1)).toBe(10_000);
	});
});

describe('maxWriteIntervalMs on the incremental path', () => {
	const MB = 1024 * 1024;

	it('stops scaling with file size once the write is O(change)', () => {
		// The throttle exists because every write re-serializes the whole
		// document *and re-uploads the whole binary through a replicating
		// vault*. An append makes both of those the size of the change, so the
		// ceiling comes down to what worker CPU will bear rather than to what
		// 40 MB of I/O will bear.
		expect(maxWriteIntervalMs(40 * MB, true)).toBe(10_000);
		expect(maxWriteIntervalMs(40 * MB, false)).toBe(60_000);
	});

	it('leaves the size-scaled ceiling alone for a file that declined', () => {
		expect(maxWriteIntervalMs(10 * MB)).toBe(30_000);
	});
});
