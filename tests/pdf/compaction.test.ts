import { describe, expect, it } from 'vitest';
import { shouldCompact } from '../../src/pdf/compaction';

const MB = 1024 * 1024;

describe('shouldCompact', () => {
	it('lets a small appendix on a large book keep going', () => {
		expect(shouldCompact(40 * MB, 512 * 1024)).toBe(false);
	});

	it('compacts a small file once the appendix is a fifth of it', () => {
		// The percentage is what stops a small PDF doubling over a long
		// session.
		expect(shouldCompact(1 * MB, 205 * 1024)).toBe(true);
		expect(shouldCompact(1 * MB, 200 * 1024)).toBe(false);
	});

	it('caps a large book with an absolute ceiling, not a percentage', () => {
		// Whichever is *smaller*. A percentage alone scales the wrong way as
		// the library grows: 20% of a future 200 MB book would be 40 MB of
		// appendix before anything compacted.
		expect(shouldCompact(200 * MB, 9 * MB)).toBe(true);
		expect(shouldCompact(200 * MB, 7 * MB)).toBe(false);
	});

	it('treats a size it cannot read as a reason to compact', () => {
		// Erring toward a full rewrite costs time; erring the other way risks
		// appending onto a base we do not understand.
		expect(shouldCompact(Number.NaN, 1024)).toBe(true);
		expect(shouldCompact(0, 1024)).toBe(true);
	});

	it('does not compact a file nothing has been appended to yet', () => {
		expect(shouldCompact(40 * MB, 0)).toBe(false);
	});
});
