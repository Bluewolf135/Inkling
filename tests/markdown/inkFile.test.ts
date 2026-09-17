import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { storedAnnotation } from '../../src/markdown/inkBlockFormat';
import {
	INK_FILE_VERSION,
	byteLength,
	emptyFileBlock,
	parseInkFile,
	readInkFileBlock,
	serializeInkFile,
	writeInkFileBlock,
	type InkFileContents,
} from '../../src/markdown/inkFile';

function stroke(id: string, p?: number): Annotation {
	return {
		id,
		kind: 'stroke',
		tool: 'pen',
		color: '#1e1e1e',
		width: 2,
		points: [
			{ x: 1, y: 2, ...(p === undefined ? {} : { p }) },
			{ x: 3, y: 4, ...(p === undefined ? {} : { p }) },
		],
	};
}

function readable(text: string): InkFileContents {
	const read = parseInkFile(text);
	if (read.kind !== 'readable') throw new Error(`expected a readable file, got ${read.kind}`);
	return read.contents;
}

async function fileHolding(blocks: Record<string, unknown>, extra: Array<[string, unknown]> = []): Promise<string> {
	return serializeInkFile({ extra, blocks: new Map(Object.entries(blocks)) });
}

describe('classifying a file', () => {
	it('reads a file this build wrote', async () => {
		const text = await fileHolding({ a: await writeInkFileBlock(undefined, emptyFileBlock()) });
		expect([...readable(text).blocks.keys()]).toEqual(['a']);
	});

	it('reads a file with no version as version 1', () => {
		expect(parseInkFile('{"blocks":{}}').kind).toBe('readable');
	});

	it('calls a newer version from the future, not damaged, whatever its blocks look like', () => {
		expect(parseInkFile('{"version":2,"blocks":"a newer shape"}')).toEqual({ kind: 'from-future', version: 2 });
	});

	it.each([
		['not JSON', '{"version":1,"blocks":{'],
		['empty', ''],
		['an array', '[]'],
		['blocks that are not a map', '{"version":1,"blocks":[]}'],
		['no blocks at all', '{"version":1}'],
		['a version that is not a whole number', '{"version":"1","blocks":{}}'],
	])('calls a file damaged when it is %s', (_label, text) => {
		expect(parseInkFile(text)).toEqual({ kind: 'damaged' });
	});
});

describe('one block', () => {
	it('round-trips a block with pressure and a caption', async () => {
		const block = { width: 800, height: 400, caption: 'friction on the ramp', annotations: [stroke('a', 0.5)] };
		const raw = await writeInkFileBlock(undefined, block);
		const text = await fileHolding({ b1: raw });

		const read = await readInkFileBlock(readable(text).blocks.get('b1'));
		expect(read.kind).toBe('decoded');
		if (read.kind !== 'decoded') return;
		expect(read.block.width).toBe(800);
		expect(read.block.height).toBe(400);
		expect(read.block.caption).toBe('friction on the ramp');
		expect(read.block.annotations.map(storedAnnotation)).toEqual(block.annotations.map(storedAnnotation));
	});

	it('writes no caption key when there is no caption', async () => {
		const raw = await writeInkFileBlock(undefined, emptyFileBlock());
		expect('caption' in raw).toBe(false);
		expect('codec' in raw).toBe(false);
	});

	it('keeps keys it does not recognise when a block is rewritten', async () => {
		const previous = { ...(await writeInkFileBlock(undefined, emptyFileBlock())), color: 'sepia' };
		const raw = await writeInkFileBlock(previous, { ...emptyFileBlock(), annotations: [stroke('a')] });
		expect(raw.color).toBe('sepia');
	});

	it('reads a block that is not an object as undecodable', async () => {
		expect(await readInkFileBlock('a string')).toEqual({ kind: 'undecodable' });
		expect(await readInkFileBlock(null)).toEqual({ kind: 'undecodable' });
	});
});

describe('carrying through what this build cannot read', () => {
	// The one that protects the most. The store holds parsed blocks, so a file
	// rebuilt only from what parsed would drop every block that did not — and
	// a stroke in one block would erase another on a file that was merely
	// written by a newer build or read on a weaker device.
	it('rewrites a different block and leaves every unreadable part byte for byte', async () => {
		const edited = await writeInkFileBlock(undefined, emptyFileBlock());
		const undecodable = { width: 800, height: 450, strokes: 'bm90IGRlZmxhdGU=' };
		const unsupported = { width: 800, height: 450, strokes: 'AAAA', codec: 'zstd' };
		const unknownKey = { ...(await writeInkFileBlock(undefined, emptyFileBlock())), layer: { opacity: 0.5 } };

		const original = await fileHolding(
			{ edited, undecodable, unsupported, unknownKey },
			[['device', 'tablet']],
		);
		const contents = readable(original);

		const blocks = new Map(contents.blocks);
		blocks.set('edited', await writeInkFileBlock(blocks.get('edited'), { ...emptyFileBlock(), annotations: [stroke('new')] }));
		const rewritten = serializeInkFile({ extra: contents.extra, blocks });

		const originalLines = original.split('\n');
		const rewrittenLines = rewritten.split('\n');
		for (const id of ['undecodable', 'unsupported', 'unknownKey']) {
			const line = originalLines.find((candidate) => candidate.trimStart().startsWith(`"${id}"`));
			if (!line) throw new Error(`no line for ${id}`);
			// Trailing comma aside, which depends only on position.
			const bare = line.replace(/,$/, '');
			expect(rewrittenLines.some((candidate) => candidate.replace(/,$/, '') === bare)).toBe(true);
		}
		expect(rewritten).toContain('"device": "tablet"');
		expect(readable(rewritten).blocks.size).toBe(4);
	});
});

describe('serializing', () => {
	it('stamps the current version', async () => {
		const text = await fileHolding({});
		expect((JSON.parse(text) as { version: unknown }).version).toBe(INK_FILE_VERSION);
	});

	it('puts one block on each line, so a line-based merge can work per block', async () => {
		const a = await writeInkFileBlock(undefined, emptyFileBlock());
		const b = await writeInkFileBlock(undefined, emptyFileBlock());
		const lines = (await fileHolding({ a, b })).split('\n');
		expect(lines.filter((line) => line.trimStart().startsWith('"a"'))).toHaveLength(1);
		expect(lines.filter((line) => line.trimStart().startsWith('"b"'))).toHaveLength(1);
	});

	it('measures size in bytes, not characters', () => {
		expect(byteLength('é')).toBe(2);
		expect(byteLength('e')).toBe(1);
	});
});
