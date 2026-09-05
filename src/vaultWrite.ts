import type { DataAdapter } from 'obsidian';

// The single chokepoint every binary write to the vault goes through.
//
// Two guards, either of which leaves the file on disk exactly as it was:
//
// 1. **Before.** A buffer that isn't a PDF, or is implausibly short, never
//    reaches the file. writeDocument already verifies structure for the
//    annotation path (see pdf/annotationWriterCore.ts), but "Add page" does
//    its own read-modify-write and had nothing under it at all.
// 2. **After.** The file's size on disk is compared against what was
//    written. A write cut short — the app killed mid-save, which mobile
//    OSes do to backgrounded apps aggressively — leaves a shorter file, and
//    this is what notices. The caller keeps its pages dirty and retries.
//
// **What this is not, yet.** The design called for an atomic replace: write
// to a scratch path outside the sync tree, then rename over the target, so
// an interrupted write cannot damage the original at all. That needs a
// real-device spike first — three things have to hold, and none can be
// checked from here:
//
//   - that `adapter.writeBinary`/`rename` work inside a dot-folder on
//     Android as well as desktop;
//   - that a rename into the vault tree updates Obsidian's own file record
//     and fires its file events, since a write that bypasses those may
//     never reach a sync plugin at all — a silently unsynced edit would be
//     a worse failure than the one being fixed;
//   - that Self-hosted LiveSync ignores the scratch folder by default.
//
// Until those are confirmed, this is the fallback the design named: keep
// the verification, write through the Vault API so events fire normally,
// and give up only the interrupted-write protection specifically. The
// after-write size check recovers most of what that would have bought,
// because the damage becomes loud instead of silent.

// Every PDF starts with this, per the spec's own header requirement. Cheap
// to check and catches the failure that matters: handing modifyBinary a
// detached, empty, or wrong buffer, which would replace a textbook with
// nothing.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

// A PDF with a header, a trailer and one empty page is a few hundred bytes.
// Anything under this is not a document that lost some content; it is a
// buffer that went wrong.
const MIN_PLAUSIBLE_PDF_BYTES = 200;

export function looksLikePdf(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < MIN_PLAUSIBLE_PDF_BYTES) return false;
	const head = new Uint8Array(bytes, 0, PDF_MAGIC.length);
	return PDF_MAGIC.every((byte, index) => head[index] === byte);
}

// The slice of Obsidian's API this needs, rather than the whole Vault, so
// the tests can supply a fake without standing up an app. Generic in the
// file type for the same reason: all this needs from a file is its path, and a
// real Vault satisfies this structurally with TFile.
export interface BinaryWriteTarget<F> {
	modifyBinary(file: F, data: ArrayBuffer): Promise<void>;
	adapter: Pick<DataAdapter, 'stat'>;
}

export async function writeBinarySafely<F extends { path: string }>(
	vault: BinaryWriteTarget<F>,
	file: F,
	bytes: ArrayBuffer,
): Promise<void> {
	if (!looksLikePdf(bytes)) {
		throw new Error(`Inkling: refusing to write ${bytes.byteLength} bytes to ${file.path} — that is not a PDF.`);
	}

	const expected = bytes.byteLength;
	await vault.modifyBinary(file, bytes);

	// stat, not a re-read: comparing sizes costs nothing, where reading a
	// 40 MB book back after every autosave would be most of the cost of the
	// save itself. A truncated write is a short file, which this catches; a
	// write that landed the wrong *bytes* at the right length is what the
	// structural verification before it is for.
	const stat = await vault.adapter.stat(file.path);
	if (stat && stat.size !== expected) {
		throw new Error(
			`Inkling: ${file.path} is ${stat.size} bytes after writing ${expected} — the write did not complete.`,
		);
	}
}
