import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { classifyIncrementalSave } from '../../src/pdf/incrementalClassify';
import { toArrayBuffer } from '../../src/binary';

// Opt-in, because a suite that depends on the user's library cannot run in
// CI, depends on files not in the repository, and changes meaning every time
// a book is added or removed. Point it at one and it answers the only
// question the generated fixtures cannot:
//
//   INKLING_PDF_LIBRARY=/path/to/vault npx vitest run tests/pdf/vaultLibrary.test.ts
//
// What it checks is *total coverage*, not a decline rate. A library where
// every file declines is a disappointing result, not a failing test — the
// failure worth catching is a file the classifier cannot reach a decision
// about at all, because that is the case the whole decline path exists to
// make impossible.
const library = process.env.INKLING_PDF_LIBRARY;

function pdfsUnder(root: string, found: string[] = []): string[] {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) pdfsUnder(path, found);
		else if (entry.name.toLowerCase().endsWith('.pdf')) found.push(path);
	}
	return found;
}

describe.skipIf(!library)('the classifier against a real library', () => {
	it(
		'reaches a decision on every PDF it finds, without throwing',
		async () => {
			const files = pdfsUnder(library ?? '');
			expect(files.length).toBeGreaterThan(0);

			const declined: string[] = [];
			const byStyle = new Map<string, number>();

			for (const path of files) {
				const bytes = new Uint8Array(readFileSync(path));
				let doc: PDFDocument;
				try {
					doc = await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
				} catch {
					// A book Inkling cannot open for annotation either —
					// encrypted, most likely. Not this module's problem.
					continue;
				}

				// The property under test, and the only one asserted per file:
				// an answer, either way, with no exception escaping.
				const result = classifyIncrementalSave(bytes, doc);
				expect(typeof result.supported).toBe('boolean');

				if (result.supported) byStyle.set(result.style, (byStyle.get(result.style) ?? 0) + 1);
				else declined.push(`${path} — ${result.reason}`);

				// Cheap, and worth asserting per file rather than in aggregate:
				// a size mismatch here would mean the classifier read a file it
				// was not handed.
				expect(statSync(path).size).toBe(bytes.length);
			}

			// Printed rather than asserted on. The rate is information about
			// the library, not a property of the code.
			const supported = [...byStyle.values()].reduce((total, count) => total + count, 0);
			console.warn(
				`Inkling: ${supported} of ${supported + declined.length} files take the fast path ` +
					`(${[...byStyle].map(([style, count]) => `${count} ${style}`).join(', ') || 'none'}).`,
			);
			for (const line of declined) console.warn(`  declined: ${line}`);
		},
		300_000,
	);
});
