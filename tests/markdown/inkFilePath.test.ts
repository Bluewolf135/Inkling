import { describe, expect, it } from 'vitest';
import { inkFileName, inkFilePathFor, joinVaultPath } from '../../src/markdown/inkFilePath';

const attachments = (folder: string) => () => folder;

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
	it('follows the attachment folder by default', () => {
		expect(inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', attachments('Attachments'))).toBe('Attachments/Forces.ink');
	});

	it('asks for the attachment folder with the note and the ink file’s name', () => {
		const asked: Array<[string, string]> = [];
		inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', (note, name) => {
			asked.push([note, name]);
			return '/';
		});
		expect(asked).toEqual([['Physics/Forces.md', 'Forces.ink']]);
	});

	it('handles an attachment folder at the vault root', () => {
		expect(inkFilePathFor('Physics/Forces.md', 'attachments', 'Ink', attachments('/'))).toBe('Forces.ink');
	});

	it('can go beside the note', () => {
		expect(inkFilePathFor('Physics/Forces.md', 'beside-note', 'Ink', attachments('Attachments'))).toBe('Physics/Forces.ink');
		expect(inkFilePathFor('Forces.md', 'beside-note', 'Ink', attachments('Attachments'))).toBe('Forces.ink');
	});

	it('can go in a named folder', () => {
		expect(inkFilePathFor('Physics/Forces.md', 'folder', 'Ink/Blocks', attachments('Attachments'))).toBe('Ink/Blocks/Forces.ink');
	});
});
