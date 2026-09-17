import { describe, expect, it } from 'vitest';
import { emptyInkBlock, serializeInkBlock } from '../../src/markdown/inkBlockFormat';
import { inkFenceMarkdown, isInkFileFence, isVaultPath, parseInkFence, serializeInkFence } from '../../src/markdown/inkFence';

describe('telling the two formats apart', () => {
	it('calls JSON the old format', () => {
		expect(isInkFileFence(serializeInkBlock({ ...emptyInkBlock(), id: 'a' }))).toBe(false);
	});

	it('calls an empty fence the old format, which is what it has always been', () => {
		expect(isInkFileFence('')).toBe(false);
		expect(isInkFileFence('  \n ')).toBe(false);
	});

	it('calls a damaged JSON block the old format, so it keeps its own banner', () => {
		expect(isInkFileFence('{"version":2,"annotations":[{oops')).toBe(false);
		expect(isInkFileFence('"version": 2')).toBe(false);
	});

	it('calls key: value lines the new format, whichever key comes first', () => {
		expect(isInkFileFence('file: Attachments/Note.ink\nid: 2b')).toBe(true);
		expect(isInkFileFence('id: 2b\nfile: Attachments/Note.ink')).toBe(true);
		expect(isInkFileFence('id: 2b')).toBe(true);
	});
});

describe('parsing', () => {
	it('reads the two keys', () => {
		expect(parseInkFence("file: Attachments/Newton's Laws of Motion Exercises.ink\nid: 2b")).toEqual({
			kind: 'fence',
			fence: { file: "Attachments/Newton's Laws of Motion Exercises.ink", id: '2b', extra: [] },
		});
	});

	it('keeps a path holding a colon whole', () => {
		const read = parseInkFence('file: Ink/Lecture 3: forces.ink\nid: a');
		expect(read.kind === 'fence' && read.fence.file).toBe('Ink/Lecture 3: forces.ink');
	});

	it('preserves unknown lines through a rewrite, in order', () => {
		const read = parseInkFence('file: a.ink\nlayer: top\nid: x\nsomething a later version wrote');
		if (read.kind !== 'fence') throw new Error('expected a fence');
		expect(read.fence.extra).toEqual(['layer: top', 'something a later version wrote']);
		expect(serializeInkFence(read.fence)).toBe('file: a.ink\nid: x\nlayer: top\nsomething a later version wrote');
	});

	it.each([
		['id: x', 'missing-file'],
		['file: a.ink', 'missing-id'],
		['file: \nid: x', 'missing-file'],
		['file: a.ink\nid: x\nid: y', 'duplicate-key'],
		['file: /etc/passwd\nid: x', 'not-a-vault-path'],
		['file: C:/Users/a.ink\nid: x', 'not-a-vault-path'],
		['file: ../outside.ink\nid: x', 'not-a-vault-path'],
		['file: .inkling/a.ink\nid: x', 'not-a-vault-path'],
	])('calls %j damaged (%s)', (source, reason) => {
		expect(parseInkFence(source)).toEqual({ kind: 'damaged', reason });
	});
});

describe('vault paths', () => {
	it.each(['a.ink', 'Attachments/a.ink', 'Deep/er/a b.ink'])('accepts %s', (path) => {
		expect(isVaultPath(path)).toBe(true);
	});

	it.each(['', '/a.ink', 'a//b.ink', 'a\\b.ink', 'a/./b.ink', 'a/../b.ink', '.hidden/a.ink', 'a/', ' a.ink'])(
		'refuses %j',
		(path) => {
			expect(isVaultPath(path)).toBe(false);
		},
	);
});

describe('writing a fence into a note', () => {
	it('wraps the body in an inkling fence', () => {
		expect(inkFenceMarkdown({ file: 'a.ink', id: 'x', extra: [] })).toBe('```inkling\nfile: a.ink\nid: x\n```');
	});
});
