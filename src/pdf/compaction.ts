// When an accumulated appendix has grown past its worth.
//
// Appending forever makes a file that grows monotonically. Nothing breaks,
// but a long annotation session on a small PDF could double it — and erasing
// is worse than drawing, because an append-only format cannot remove
// anything: an erased annotation's dictionary and appearance stream stay in
// the file, merely marked free and unreachable.
//
// The bytes come back only here. **Compaction is the plugin's only garbage
// collector**, which is more than tidying: an eraser-heavy session is the
// case that reaches this rule first and the one its thresholds should be
// measured against.
//
// Both numbers are still guesses and should be checked against a real session
// before they are treated as settled.
const MB = 1024 * 1024;
const APPENDIX_FRACTION = 0.2;
const APPENDIX_CEILING_BYTES = 8 * MB;

export function shouldCompact(originalSize: number, appendedBytes: number): boolean {
	// A size we cannot read is a reason to rewrite: erring toward a full
	// rewrite costs time, erring the other way means appending onto a base we
	// do not understand.
	if (!Number.isFinite(originalSize) || originalSize <= 0) return true;

	// Whichever is smaller. The absolute ceiling stops a big book
	// accumulating a big appendix; the percentage stops a small one
	// compacting constantly. A percentage alone scales the wrong way as the
	// library grows — 20% of a future 200 MB book would be 40 MB of appendix
	// before anything compacted.
	const budget = Math.min(originalSize * APPENDIX_FRACTION, APPENDIX_CEILING_BYTES);
	return appendedBytes > budget;
}
