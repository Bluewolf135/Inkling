import { describe, expect, it } from 'vitest';
import { extractionNotePath } from '../../src/extract/extract';

const PATTERN = '{folder}/{name} — annotations.md';

describe('extractionNotePath', () => {
	it('puts the note beside the book', () => {
		expect(extractionNotePath(PATTERN, 'Books/Physics/Griffiths.pdf')).toBe('Books/Physics/Griffiths — annotations.md');
	});

	it('handles a PDF at the vault root without a leading slash', () => {
		// {folder} is empty there, which would otherwise produce "/name.md" —
		// a path Obsidian would refuse.
		expect(extractionNotePath(PATTERN, 'Griffiths.pdf')).toBe('Griffiths — annotations.md');
	});

	it('strips the extension whatever case it was written in', () => {
		expect(extractionNotePath(PATTERN, 'Books/Scan.PDF')).toBe('Books/Scan — annotations.md');
	});

	it('leaves a dot inside the name alone', () => {
		expect(extractionNotePath(PATTERN, 'Papers/v1.2 draft.pdf')).toBe('Papers/v1.2 draft — annotations.md');
	});

	it('follows a pattern that puts every note in one folder', () => {
		expect(extractionNotePath('Annotations/{name}.md', 'Books/Physics/Griffiths.pdf')).toBe('Annotations/Griffiths.md');
	});
});
