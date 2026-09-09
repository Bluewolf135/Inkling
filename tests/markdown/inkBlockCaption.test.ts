// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountNote, type TestNote } from '../harness/note';
import { INK_BLOCK_VERSION, parseInkBlock } from '../../src/markdown/inkBlockFormat';

// An ink block is invisible to a reader: a page of handwritten physics is,
// to anyone not looking at it, a JSON blob. A caption is the one line that
// says what the drawing is.
//
// Off by default, because a setting that changes how the plugin works the
// moment it is added is a setting that broke something. The asymmetry below
// is the part worth keeping straight: the setting governs whether a caption
// can be *written*, never whether one already written is *shown*.

let note: TestNote;

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	vi.useRealTimers();
});

function block(id: string, caption?: string): unknown {
	return {
		version: INK_BLOCK_VERSION,
		id,
		width: 800,
		height: 450,
		...(caption === undefined ? {} : { caption }),
		annotations: [],
	};
}

function noteHolding(body: unknown, blockId: string, blockCaptions: boolean): TestNote {
	return mountNote({
		path: `${blockId}.md`,
		contents: `# Notes\n\n\`\`\`inkling\n${JSON.stringify(body)}\n\`\`\`\n`,
		openInEditor: true,
		blockCaptions,
	});
}

function captionText(): string | null {
	return note.block(0).el.querySelector('.inkling-ink-block-caption')?.textContent ?? null;
}

function captionInput(): HTMLInputElement | null {
	return note.block(0).el.querySelector<HTMLInputElement>('.inkling-ink-block-caption-input');
}

function type(value: string): void {
	const input = captionInput();
	if (!input) throw new Error('this block offers no caption to write');
	input.value = value;
	input.dispatchEvent(new Event('change'));
}

describe('with captions turned off', () => {
	it('shows a caption the block already has', () => {
		// Hiding text someone wrote is worse than showing it, and a caption
		// written on a device where the setting is on syncs to one where it
		// is off. The setting is about writing captions, not about reading
		// them.
		note = noteHolding(block('ink-shown', 'Newton'), 'ink-shown', false);

		expect(captionText()).toBe('Newton');
	});

	it('offers no way to write one', () => {
		note = noteHolding(block('ink-shown-only', 'Newton'), 'ink-shown-only', false);

		expect(captionInput()).toBeNull();
	});

	it('renders nothing at all for a block without one', () => {
		note = noteHolding(block('ink-bare'), 'ink-bare', false);

		expect(captionText()).toBeNull();
		expect(captionInput()).toBeNull();
	});
});

describe('with captions turned on', () => {
	it('offers a caption to write on a block that has none', () => {
		note = noteHolding(block('ink-writable'), 'ink-writable', true);

		expect(captionInput()).not.toBeNull();
	});

	it('writes what was typed into the note', async () => {
		note = noteHolding(block('ink-typed'), 'ink-typed', true);

		type("Newton's second law");
		await note.flushWrites();

		expect(parseInkBlock(note.fenceBody(0)).data.caption).toBe("Newton's second law");
	});

	it('starts from the caption the block already has', () => {
		note = noteHolding(block('ink-prefilled', 'Existing'), 'ink-prefilled', true);

		expect(captionInput()?.value).toBe('Existing');
	});

	it('removes the caption from the note when it is cleared', async () => {
		note = noteHolding(block('ink-cleared', 'Existing'), 'ink-cleared', true);

		type('   ');
		await note.flushWrites();

		expect(note.fenceBody(0)).not.toContain('caption');
	});

	it('writes nothing when the caption did not change', async () => {
		note = noteHolding(block('ink-unchanged', 'Existing'), 'ink-unchanged', true);
		const before = note.contents();

		type('Existing');
		await note.flushWrites();

		expect(note.contents()).toBe(before);
	});

	it('offers nothing on a block it could not read', async () => {
		// A block that must never be saved over must not offer a field whose
		// whole purpose is to save something over it.
		note = mountNote({
			path: 'damaged.md',
			contents: '# Notes\n\n```inkling\n{"version":2,"id":"ink-damaged","annotations":[\n```\n',
			openInEditor: true,
			blockCaptions: true,
		});

		expect(captionInput()).toBeNull();
	});
});

describe('a caption that looks like markup', () => {
	it('is shown as the text it is', () => {
		// Block content is untrusted: notes sync between devices, get shared,
		// and can be hand-edited.
		note = noteHolding(block('ink-markup', '<b>not bold</b>'), 'ink-markup', false);

		expect(captionText()).toBe('<b>not bold</b>');
		expect(note.block(0).el.querySelector('b')).toBeNull();
	});
});
