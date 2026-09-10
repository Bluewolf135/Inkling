import { describe, expect, it, vi } from 'vitest';
import {
	appendBinarySafely,
	canAppendBinary,
	looksLikePdf,
	writeBinarySafely,
	type BinaryAppendTarget,
	type BinaryWriteTarget,
} from '../src/vaultWrite';

function pdfBytes(length = 1024): ArrayBuffer {
	const bytes = new Uint8Array(length);
	bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
	return bytes.buffer;
}

// A stand-in for the slice of the Vault API writeBinarySafely touches, with
// `reportedSize` standing in for what actually landed on disk — which is the
// only way to simulate a write that was cut short.
function fakeVault(options: { reportedSize?: (written: number) => number | null } = {}): BinaryWriteTarget<{ path: string }> & {
	written: ArrayBuffer[];
} {
	const written: ArrayBuffer[] = [];
	return {
		written,
		modifyBinary: vi.fn(async (_file: { path: string }, data: ArrayBuffer) => {
			written.push(data);
		}),
		adapter: {
			stat: vi.fn(async () => {
				const last = written[written.length - 1];
				if (!last) return null;
				const size = options.reportedSize ? options.reportedSize(last.byteLength) : last.byteLength;
				return size === null ? null : { type: 'file' as const, ctime: 0, mtime: 0, size };
			}),
		},
	};
}

const file = { path: 'books/textbook.pdf' };

describe('looksLikePdf', () => {
	it('accepts a real PDF header', () => {
		expect(looksLikePdf(pdfBytes())).toBe(true);
	});

	it('rejects an empty or detached buffer', () => {
		// The failure this exists for: handing modifyBinary a buffer that
		// went wrong would replace a textbook with nothing at all.
		expect(looksLikePdf(new ArrayBuffer(0))).toBe(false);
	});

	it('rejects something that is not a PDF at all', () => {
		expect(looksLikePdf(new TextEncoder().encode('x'.repeat(4096)).buffer)).toBe(false);
	});

	it('rejects a PDF header with nothing behind it', () => {
		expect(looksLikePdf(pdfBytes(16))).toBe(false);
	});
});

describe('writeBinarySafely', () => {
	it('writes bytes that pass both guards', async () => {
		const vault = fakeVault();
		await writeBinarySafely(vault, file, pdfBytes());
		expect(vault.written).toHaveLength(1);
	});

	it('refuses before writing when the bytes are not a PDF', async () => {
		const vault = fakeVault();
		await expect(writeBinarySafely(vault, file, new ArrayBuffer(0))).rejects.toThrow(/not a PDF/);
		// The point of the guard: the file was never touched.
		expect(vault.written).toHaveLength(0);
	});

	it('reports a write that was cut short', async () => {
		// A truncated file still opens far enough to look fine in a listing,
		// and under a live-replicating sync it reaches every other device
		// before anyone notices. Comparing sizes makes it loud.
		const vault = fakeVault({ reportedSize: (written) => Math.floor(written / 2) });
		await expect(writeBinarySafely(vault, file, pdfBytes())).rejects.toThrow(/did not complete/);
	});

	it('accepts a write it cannot stat rather than failing on the check itself', async () => {
		// stat is a convenience, not a contract — an adapter that declines to
		// answer must not turn a good save into a reported failure, which
		// would leave the pages dirty forever.
		const vault = fakeVault({ reportedSize: () => null });
		await expect(writeBinarySafely(vault, file, pdfBytes())).resolves.toBeUndefined();
	});
});

// A vault that actually holds a file's length, because every guard in the
// append path is about whether that length is what we think it is.
function fakeAppendVault(options: { size: number; withAppend?: boolean; sizeAfter?: (before: number, added: number) => number }) {
	let size = options.size;
	const appended: ArrayBuffer[] = [];
	const vault: BinaryAppendTarget<{ path: string }> & { appended: ArrayBuffer[] } = {
		appended,
		adapter: {
			stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size })),
		},
	};
	if (options.withAppend !== false) {
		vault.appendBinary = vi.fn(async (_file: { path: string }, data: ArrayBuffer) => {
			appended.push(data);
			size = options.sizeAfter ? options.sizeAfter(size, data.byteLength) : size + data.byteLength;
		});
	}
	return vault;
}

function appendix(text = '\n9 0 obj\n<< >>\nendobj\nxref\ntrailer\nstartxref\n9\n%%EOF\n'): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

describe('canAppendBinary', () => {
	it('detects the API when it is there', () => {
		expect(canAppendBinary(fakeAppendVault({ size: 100 }))).toBe(true);
	});

	it('reports its absence rather than throwing', () => {
		// minAppVersion is 1.4.4 and appendBinary is @since 1.12.3, so this is
		// a real case for anyone but the author.
		expect(canAppendBinary(fakeAppendVault({ size: 100, withAppend: false }))).toBe(false);
	});
});

describe('appendBinarySafely', () => {
	it('appends when the file is exactly the length the update was built on', async () => {
		const vault = fakeAppendVault({ size: 1024 });
		await appendBinarySafely(vault, file, appendix(), 1024);
		expect(vault.appended).toHaveLength(1);
	});

	it('refuses when the file changed size since it was read', async () => {
		// The one place incremental save is *more* dangerous than what it
		// replaces. An append onto a file sync moved underneath us produces a
		// corrupt PDF, where a full rewrite would merely lose the other edit —
		// so this check is load-bearing, not defensive.
		const vault = fakeAppendVault({ size: 2048 });
		await expect(appendBinarySafely(vault, file, appendix(), 1024)).rejects.toThrow(/changed underneath us/);
		expect(vault.appended).toHaveLength(0);
	});

	it('refuses an appendix that does not end at a PDF end-of-file marker', async () => {
		// looksLikePdf cannot apply to something that does not start with
		// %PDF-, so this is what replaces it: an appendix that does not end in
		// %%EOF is not an update section, whatever else it is.
		const vault = fakeAppendVault({ size: 1024 });
		await expect(appendBinarySafely(vault, file, appendix('nothing useful\n'), 1024)).rejects.toThrow(/%%EOF/);
		expect(vault.appended).toHaveLength(0);
	});

	it('refuses an appendix that merely mentions %%EOF somewhere in the middle', async () => {
		const vault = fakeAppendVault({ size: 1024 });
		await expect(appendBinarySafely(vault, file, appendix('%%EOF\nand then some more\n'), 1024)).rejects.toThrow(/%%EOF/);
		expect(vault.appended).toHaveLength(0);
	});

	it('refuses an empty appendix', async () => {
		const vault = fakeAppendVault({ size: 1024 });
		await expect(appendBinarySafely(vault, file, new ArrayBuffer(0), 1024)).rejects.toThrow();
		expect(vault.appended).toHaveLength(0);
	});

	it('reports an append that was cut short', async () => {
		// Same failure the replacement path guards against — the app killed
		// mid-write, which mobile OSes do aggressively — and the same way of
		// noticing, except the expected size is base plus appendix.
		const vault = fakeAppendVault({ size: 1024, sizeAfter: (before, added) => before + Math.floor(added / 2) });
		await expect(appendBinarySafely(vault, file, appendix(), 1024)).rejects.toThrow(/did not complete/);
	});

	it('refuses outright when the API is missing', async () => {
		const vault = fakeAppendVault({ size: 1024, withAppend: false });
		await expect(appendBinarySafely(vault, file, appendix(), 1024)).rejects.toThrow(/appendBinary/);
	});
});
