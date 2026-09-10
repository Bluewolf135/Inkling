// A ceiling on how long continuous handwriting can go without a save.
//
// pdf-lib has no incremental save: every write re-serializes the entire
// document, and in a live-replicating vault that means re-uploading the
// whole binary too. A flat five-second ceiling meant a 40 MB textbook was
// rewritten and re-replicated twelve times a minute for as long as the user
// kept writing.
//
// Scaling by size puts the cost where it belongs. The trade is that a crash
// loses up to one interval of ink rather than five seconds of it — bounded
// by the fact that a crash mid-write can no longer damage the file itself
// (see src/vaultWrite.ts), only lose strokes not yet committed.
//
// The trailing debounce (WRITE_DEBOUNCE_MS in src/pdfView.ts) is unchanged:
// a natural pause still saves promptly at any file size. This only governs
// the case where the user never pauses.
// **The incremental path changes what this is measuring.** When a file is on
// the fast path an autosave appends only the objects that changed: the disk
// write and the sync upload are the size of the edit, not the size of the
// book, and the only thing still scaling with the document is the
// verification parse — which runs in the writer worker and never blocks the
// pen. So the ceiling stops tracking file size and becomes the shortest one
// we use, which with the trailing debounce puts the worst a crash can cost at
// about a second of handwriting rather than up to a minute.
export function maxWriteIntervalMs(fileSizeBytes: number, incremental = false): number {
	const MB = 1024 * 1024;
	if (incremental) return 10_000;
	// A size we can't read is treated as small: erring toward saving more
	// often risks bandwidth, erring the other way risks the user's ink.
	if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 5 * MB) return 10_000;
	if (fileSizeBytes <= 25 * MB) return 30_000;
	return 60_000;
}
