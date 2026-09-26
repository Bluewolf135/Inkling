import { describe, expect, it } from 'vitest';
import { inkFileName, inkFilePathFor, joinVaultPath } from '../../src/markdown/inkFilePath';

// Stands in for Obsidian's fileManager.getAvailablePathForAttachment: the
// full path an attachment of that name would be saved at.
const attachments = (folder: string) => (name: string) => Promise.resolve(joinVaultPath(folder, name));

describe('naming an ink file', () => {
	it('takes the note’s name', () => {
		expect(inkFileName("Physics/Newton's Laws of Motion Exercises.md")).toBe("Newton's Laws of Motion Exercises.ink");
	});

	it('keeps dots that are part of the name', () => {
		expect(inkFileName('Lecture 3.1.md')).toBe('Lecture 3.1.ink');
	});
});

describe('joining a folder and a name', () => {
	it.each([
		['', 'a.ink'],
		['/', 'a.ink'],
		['Ink', 'Ink/a.ink'],
		['/Ink/', 'Ink/a.ink'],
	])('puts a.ink in %j as %s', (folder, expected) => {
		expect(joinVaultPath(folder, 'a.ink')).toBe(expected);
	});
});

describe('where a new ink file goes', () => {
	it('follows the attachment folder by default', async () => {
		expect(await inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', attachments('Attachments'))).toBe('Attachments/Forces.ink');
	});

	it('asks for the attachment path with the ink file’s name and the note', async () => {
		const asked: Array<[string, string]> = [];
		await inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', (name, note) => {
			asked.push([name, note]);
			return Promise.resolve(name);
		});
		expect(asked).toEqual([['Forces.ink', 'Physics/Forces.md']]);
	});

	// Obsidian answers with a free name, so once a note's ink file exists
	// the answer is "Forces 1.ink". Only its folder is taken: a second block
	// in the same note belongs in the same file.
	it('keeps the note’s ink file name when the attachment path is numbered', async () => {
		const numbered = () => Promise.resolve('Attachments/Forces 1.ink');
		expect(await inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', numbered)).toBe('Attachments/Forces.ink');
	});

	it('handles an attachment folder at the vault root', async () => {
		expect(await inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', attachments('/'))).toBe('Forces.ink');
	});

	it('handles an attachment folder beside the note', async () => {
		expect(await inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', attachments('Physics/assets'))).toBe('Physics/assets/Forces.ink');
	});

	it('can go beside the note', async () => {
		expect(await inkFilePathFor('Physics/Forces.md', 'beside-note', 'Ink', attachments('Attachments'))).toBe('Physics/Forces.ink');
		expect(await inkFilePathFor('Forces.md', 'beside-note', 'Ink', attachments('Attachments'))).toBe('Forces.ink');
	});

	it('can go in a named folder', async () => {
		expect(await inkFilePathFor('Physics/Forces.md', 'folder', 'Ink/Blocks', attachments('Attachments'))).toBe('Ink/Blocks/Forces.ink');
	});
});
