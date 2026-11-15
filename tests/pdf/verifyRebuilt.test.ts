import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { verifyRebuilt } from '../../src/pdf/verifyRebuilt';

async function pdfWithPages(count: number): Promise<ArrayBuffer> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < count; i++) doc.addPage([300, 400]);
	const bytes = await doc.save();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('verifyRebuilt', () => {
	it('passes a readable PDF with the pages the change meant to leave', async () => {
		await expect(verifyRebuilt(await pdfWithPages(3), 3)).resolves.toBeUndefined();
		await expect(verifyRebuilt(await pdfWithPages(3))).resolves.toBeUndefined();
	});

	it('refuses bytes that do not read back as a PDF', async () => {
		await expect(verifyRebuilt(new TextEncoder().encode('%PDF-1.7 but not really').buffer)).rejects.toThrow(/could not be read back/);
	});

	it('refuses a page count other than the one asked for', async () => {
		await expect(verifyRebuilt(await pdfWithPages(2), 3)).rejects.toThrow(/2 pages where 3 were expected/);
	});
});
