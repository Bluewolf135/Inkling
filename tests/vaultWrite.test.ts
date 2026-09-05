import { describe, expect, it, vi } from 'vitest';
import { looksLikePdf, writeBinarySafely, type BinaryWriteTarget } from '../src/vaultWrite';

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
