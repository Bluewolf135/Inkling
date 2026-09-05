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
