# Ink Outside the Note, Phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A newly inserted ink block keeps its strokes in a per-note `.ink` file instead of in the note, saving by rewriting one compressed block in that file. Every existing in-note block keeps working exactly as it does today.

**Architecture:** Three pure modules (a stroke codec, the ink file format, and the three-line fence) sit under one store per ink file. The store holds the last good parse, queues writes, merges against changes made elsewhere and guards every write. `InkBlockView` stops owning its save path: the in-note logic moves behind an `InkBlockStorage` interface unchanged, and a second implementation talks to the store. The fence's own content decides which one a block gets.

**Tech Stack:** TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`), Obsidian plugin API 1.13, the web platform's `CompressionStream`/`DecompressionStream`, esbuild, Vitest (node and jsdom environments).

**Spec:** `docs/superpowers/specs/2026-09-16-ink-sidecar-files-design.md`

## Global Constraints

- **`isDesktopOnly: false`.** No Node or Electron APIs in `src/`. No `Buffer`: base64 goes through `btoa`/`atob`. Tests may use Node freely.
- **No new dependencies.** Compression is `CompressionStream('deflate')`, never `'deflate-raw'`, never a library.
- **Ink is the irreplaceable thing.** Every ambiguous case resolves toward keeping strokes. Nothing is deleted as a side effect.
- **The old format keeps working.** Every existing test under `tests/markdown/` passes unchanged at every commit. No test in those files may be edited to make it pass.
- `strokes` is an opaque string everywhere outside the codec. A block this build cannot decode is written back exactly as it was read, and so is every key this build does not recognise, both inside a block and at the top of the file.
- Not a hidden folder. Ink files are ordinary vault files reached through the Vault API.
- Obsidian conventions: `createEl`/`createDiv`, sentence-case copy, no `innerHTML`, notices prefixed `Inkling: `.
- Commit after every task. `npm run build`, `npm run lint` and `npm test` must all pass before each commit. Commit messages follow the repository's style: an imperative subject in plain words, a prose body, and the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

## Scope of this phase

The spec is four pieces of work that depend on each other in order. Each later piece is planned against the code the earlier one actually produced, not against a guess about it, so this plan covers only the first. It still ships something safe on its own: every state the later phases *handle* is a state this phase *refuses*, with a banner, and a refused save always goes to the rescue store.

| Phase | Covers | In this plan |
|---|---|---|
| 1 | Codec, ink file, fence, store, write queue, merge, write guards, external change, the storage split in `InkBlockView`, the location setting, the insert command | Yes |
| 2 | Missing file and missing block: the setting, restore from memory, trash and rescue store, "start a new drawing here" | No. Phase 1 shows both as read-only banners |
| 3 | Salvage, quarantine, confirming re-read, repair, undo | No. Phase 1 refuses a damaged file and never writes it |
| 4 | Fence scan, rewrite on rename, rename-to-match command, remove-unreferenced-blocks command | No. Phase 1 treats a renamed ink file as missing |

## Decisions made in planning

The spec leaves these open, or turned out to rest on something that does not hold. Each changes a task below.

1. **Inserting a block creates its entry in the ink file.** The spec defers creating the file until the first stroke. That makes a freshly inserted fence indistinguishable from one pasted from another vault, since both name a block the file does not hold, and the spec gives the two different behaviour: one should be drawable, the other should show the missing state. It also means a note that syncs to a second device before its ink file does would create a new file there on the first stroke, which is exactly the "empty file written over a file that was merely misplaced" the spec refuses elsewhere. Creating the entry at insert costs about 40 bytes per empty block (the Energy note's 38 come to under 2 KB) and makes both states unambiguous: **a block the file does not hold is always missing, and a file that does not exist is always missing.** No save path in this phase ever creates an ink file; only the insert command does.
2. **A save checks the file is still what the store last saw, in the same operation that writes it.** The spec relies on the external-change watch to catch edits from elsewhere. That event arrives asynchronously, so a sync landing inside that window would be overwritten. The store instead writes with `vault.process`, compares what is on disk with the text it last read or wrote (a string comparison, no parse), and writes only when they match. When they don't, it adopts what it found and merges. This costs one read of the file per save, on top of the spec's `adapter.stat`.
3. **The write guard for an empty stroke payload is a round trip.** The spec guards against "a block serialized with an empty stroke payload" being written over one whose view holds annotations. Zero annotations is a legitimate block (someone erased everything), so the guard cannot be a count. Instead every encoded block is decoded again before it is written, and the write is refused unless the decode succeeds with exactly as many annotations as were encoded. Decoding the largest block measured is 0.3 ms.
4. **`getNewFileParent(notePath, '<name>.ink')` is the attachment location.** Given a non-Markdown file name, Obsidian answers with the attachment folder rather than the new-note folder. Task 10 confirms this in the running app before the phase is called done.
5. **Merging is by revision, not by content.** Every block the store holds carries a revision number that changes whenever the block does. A view remembers the revision of the block it last put on screen, and the store merges whenever that differs from what it holds. A view that could not put a merged result on screen, because the pen was down, keeps its *old* base, which is what stops the next merge reading the other device's strokes as erasures.
6. **Views share one store per ink file, which lives while any view uses it** and is dropped once the last one is gone and its queue is empty.

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/markdown/inkFileCodec.ts` | Base64, deflate and inflate, availability detection, encoding and decoding one block's strokes. |
| `src/markdown/inkFile.ts` | Parse and classify an ink file, read and write one block, serialize the file. Carries through what it does not understand. |
| `src/markdown/inkFence.ts` | Tell the two fence formats apart; parse and serialize the three-line fence; decide what is a vault path. |
| `src/markdown/inkFileStore.ts` | One live ink file: load, hold, notify, queue writes, merge, guard. Also `InkFileStores`, the registry that shares stores between views and routes vault events to them. |
| `src/markdown/inkFileVaultIO.ts` | The store's `InkFileIO` over Obsidian's `Vault`. |
| `src/markdown/inkBlockStorage.ts` | The interface between `InkBlockView` and wherever its strokes are kept. |
| `src/markdown/inNoteStorage.ts` | Today's in-note save path, moved out of `inkBlock.ts` without changing behaviour. |
| `src/markdown/inkFileStorage.ts` | The ink-file implementation of `InkBlockStorage`. |
| `src/markdown/inkFilePath.ts` | Where a new ink file goes, from a note path and the settings. |
| `tests/markdown/inkFileCodec.test.ts` | Codec round trips, fallback, integrity. |
| `tests/markdown/inkFile.test.ts` | Classification, round trips, carry-through. |
| `tests/markdown/inkFence.test.ts` | Fence parsing and serialization. |
| `tests/markdown/inkFileStore.test.ts` | Store load, notifications, external change. |
| `tests/markdown/inkFileStoreWrites.test.ts` | Queue, collapse, merge, guards. |
| `tests/markdown/inkFilePath.test.ts` | Location resolution. |
| `tests/markdown/inkFileBlockIntegration.test.ts` | New-format blocks end to end through the note harness. |
| `tests/harness/inkFileIO.ts` | An in-memory `InkFileIO` with hooks for failure and concurrent change. |

**Modified files:**

| Path | Change |
|---|---|
| `src/markdown/inkBlockFormat.ts` | Export `readAnnotations`, extracted from `parseInkBlock`. |
| `src/markdown/inkBlock.ts` | `InkBlockView` takes an `InkBlockStorage`; the in-note path moves out; registration chooses a storage per fence and inserts new-format blocks. |
| `src/markdown/compactInkBlocks.ts` | Leaves new-format fences alone rather than counting them unreadable. |
| `src/settings.ts`, `src/settingsTab.ts` | `inkFileLocation` and `inkFileFolder`. |
| `src/main.ts` | Passes the new options to `registerInkBlock`. |
| `tests/harness/note.ts` | A vault holding more than one file, vault events for ink files, `registerEvent`, and helpers to read and seed ink files. |
| `tests/harness/obsidian.ts` | `Notice` records a fragment's text. |
| `tests/settings.test.ts`, `tests/settingsTab.test.ts` | Cover the two new settings. |
| `tests/markdown/compactInkBlocks.test.ts` | A new-format fence is untouched and uncounted. |
| `docs/superpowers/specs/2026-09-16-ink-sidecar-files-design.md` | Status line. |

---

### Task 1: The stroke codec

**Files:**
- Modify: `src/markdown/inkBlockFormat.ts` (the annotation loop inside `parseInkBlock`, lines 274–286)
- Create: `src/markdown/inkFileCodec.ts`
- Test: `tests/markdown/inkFileCodec.test.ts`

**Interfaces:**
- Consumes: `storedAnnotation(annotation: Annotation): Record<string, unknown>` from `inkBlockFormat.ts`.
- Produces:
  - `readAnnotations(value: unknown): { annotations: Annotation[]; dropped: number }` (in `inkBlockFormat.ts`)
  - `type StrokeCodec = 'deflate' | 'none'`
  - `deflateAvailable(): boolean`
  - `toBase64(bytes: Uint8Array): string`, `fromBase64(text: string): Uint8Array<ArrayBuffer> | null`
  - `encodeStrokes(annotations: readonly Annotation[]): Promise<{ strokes: string; codec: StrokeCodec }>`
  - `type DecodedStrokes = { kind: 'decoded'; annotations: Annotation[] } | { kind: 'undecodable' } | { kind: 'unsupported'; codec: string }`
  - `decodeStrokes(strokes: unknown, codec: unknown): Promise<DecodedStrokes>`

- [ ] **Step 1: Extract `readAnnotations`**

In `src/markdown/inkBlockFormat.ts`, add above `emptyInkBlock`:

```ts
// A list of stored annotations, read one at a time, with a count of those
// that could not be. Shared by the in-note block and the ink file, so the two
// formats cannot come to disagree about what a readable annotation is.
export function readAnnotations(value: unknown): { annotations: Annotation[]; dropped: number } {
	const annotations: Annotation[] = [];
	let dropped = 0;
	if (Array.isArray(value)) {
		for (const entry of value) {
			const annotation = readAnnotation(entry);
			if (annotation) annotations.push(annotation);
			else dropped += 1;
		}
	} else if (value !== undefined) {
		// Annotations that are not a list at all. Counted as one loss rather
		// than none: something was there, and it is not here.
		dropped += 1;
	}
	return { annotations, dropped };
}
```

and in `parseInkBlock` replace the block from `const annotations: Annotation[] = [];` through the closing brace of the `else if (raw.annotations !== undefined)` branch with:

```ts
	const { annotations, dropped } = readAnnotations(raw.annotations);
```

- [ ] **Step 2: Run the existing format tests**

Run: `npx vitest run tests/markdown/inkBlockFormat.test.ts tests/markdown/inkBlockFormatV2.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 3: Write the failing codec tests**

Create `tests/markdown/inkFileCodec.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { storedAnnotation } from '../../src/markdown/inkBlockFormat';
import { decodeStrokes, encodeStrokes, fromBase64, toBase64 } from '../../src/markdown/inkFileCodec';

// The codec is the only code that sees inside `strokes`. Everything above it
// treats the string as opaque, so what this has to get right is small and
// absolute: what goes in comes out, and anything that does not come out
// cleanly says so rather than inflating into plausible nonsense.

afterEach(() => {
	vi.unstubAllGlobals();
});

function pressureStroke(id: string): Annotation {
	return {
		id,
		kind: 'stroke',
		tool: 'pen',
		color: '#1e1e1e',
		width: 2,
		points: [
			{ x: 10, y: 20, p: 0.5 },
			{ x: 30.5, y: 40, p: 0.75 },
			{ x: 50, y: 60 },
		],
	};
}

function shape(id: string): Annotation {
	return { id, kind: 'shape', tool: 'oval', color: '#e03131', width: 3, start: { x: 1, y: 2 }, end: { x: 100, y: 80 } };
}

// A page of handwriting shaped the way real ink is: long strokes of nearby
// points at a tenth of a unit, which is what the compression ratio in the
// spec was measured on. Deterministic, so the size assertion cannot flake.
function handwriting(strokes: number, pointsPerStroke: number): Annotation[] {
	const annotations: Annotation[] = [];
	for (let s = 0; s < strokes; s++) {
		const points = [];
		for (let p = 0; p < pointsPerStroke; p++) {
			points.push({
				x: Math.round((40 + s * 7 + p * 1.3 + Math.sin(p / 3) * 4) * 10) / 10,
				y: Math.round((60 + (s % 12) * 30 + Math.cos(p / 4) * 6) * 10) / 10,
				p: Math.round((0.4 + 0.3 * Math.sin(p / 5)) * 100) / 100,
			});
		}
		annotations.push({ id: `ink-${s}`, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points });
	}
	return annotations;
}

function written(annotations: readonly Annotation[]): string {
	return JSON.stringify(annotations.map(storedAnnotation));
}

describe('base64', () => {
	it('round-trips every byte value, across the chunk boundary', () => {
		const bytes = new Uint8Array(70_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
		expect(fromBase64(toBase64(bytes))).toEqual(bytes);
	});

	it('refuses text that is not base64', () => {
		expect(fromBase64('not base64!')).toBeNull();
		expect(fromBase64('abc')).toBeNull();
		expect(fromBase64('ab{}')).toBeNull();
	});
});

describe('encoding and decoding strokes', () => {
	it('round-trips a stroke with pressure and a shape', async () => {
		const annotations = [pressureStroke('a'), shape('b')];
		const { strokes, codec } = await encodeStrokes(annotations);
		expect(codec).toBe('deflate');

		const decoded = await decodeStrokes(strokes, undefined);
		expect(decoded.kind).toBe('decoded');
		if (decoded.kind !== 'decoded') return;
		expect(decoded.annotations.map(storedAnnotation)).toEqual(annotations.map(storedAnnotation));
	});

	it('round-trips an empty block to a payload that is not empty', async () => {
		const { strokes } = await encodeStrokes([]);
		expect(strokes.length).toBeGreaterThan(0);
		expect(await decodeStrokes(strokes, undefined)).toEqual({ kind: 'decoded', annotations: [] });
	});

	it('stores a page of handwriting in well under half the bytes of its JSON', async () => {
		const annotations = handwriting(120, 150);
		const { strokes } = await encodeStrokes(annotations);
		expect(strokes.length).toBeLessThan(written(annotations).length * 0.5);
	});

	it('falls back to uncompressed base64 where the platform cannot deflate', async () => {
		vi.stubGlobal('CompressionStream', undefined);
		vi.stubGlobal('DecompressionStream', undefined);

		const annotations = [pressureStroke('a')];
		const { strokes, codec } = await encodeStrokes(annotations);
		expect(codec).toBe('none');

		const decoded = await decodeStrokes(strokes, 'none');
		expect(decoded.kind).toBe('decoded');
	});

	it('reports a deflated block as unsupported, not broken, where the platform cannot inflate', async () => {
		const { strokes } = await encodeStrokes([pressureStroke('a')]);
		vi.stubGlobal('DecompressionStream', undefined);

		expect(await decodeStrokes(strokes, undefined)).toEqual({ kind: 'unsupported', codec: 'deflate' });
	});

	it('reports a codec it has never heard of as unsupported', async () => {
		expect(await decodeStrokes('AAAA', 'zstd')).toEqual({ kind: 'unsupported', codec: 'zstd' });
	});

	it('refuses a block whose Adler-32 trailer does not match', async () => {
		const { strokes } = await encodeStrokes([pressureStroke('a')]);
		const bytes = fromBase64(strokes);
		if (!bytes) throw new Error('encoder produced invalid base64');
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;

		expect(await decodeStrokes(toBase64(bytes), undefined)).toEqual({ kind: 'undecodable' });
	});

	it('refuses a payload that is not base64, or not a string', async () => {
		expect(await decodeStrokes('%%%%', undefined)).toEqual({ kind: 'undecodable' });
		expect(await decodeStrokes(42, undefined)).toEqual({ kind: 'undecodable' });
		expect(await decodeStrokes('', undefined)).toEqual({ kind: 'undecodable' });
	});

	it('refuses a payload holding any annotation it cannot read, rather than keeping the rest', async () => {
		const json = JSON.stringify([storedAnnotation(pressureStroke('a')), { id: 'b', kind: 'stroke', tool: 'nope' }]);
		const strokes = toBase64(new TextEncoder().encode(json));
		expect(await decodeStrokes(strokes, 'none')).toEqual({ kind: 'undecodable' });
	});
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run tests/markdown/inkFileCodec.test.ts`
Expected: FAIL, cannot resolve `../../src/markdown/inkFileCodec`.

- [ ] **Step 5: Write the codec**

Create `src/markdown/inkFileCodec.ts`:

```ts
import type { Annotation } from '../annotate/types';
import { readAnnotations, storedAnnotation } from './inkBlockFormat';

// What one block's `strokes` string holds, and the only code that looks
// inside it.
//
// The annotations are written exactly as an in-note block writes them —
// storedAnnotation, rounded and flattened — then deflated and base64-encoded.
// Everything above this module treats the result as an opaque string, and
// that is load-bearing: a block this build cannot decode is carried through a
// rewrite untouched, which is only possible if nothing else ever needs to
// understand it.

export type StrokeCodec = 'deflate' | 'none';

// Whether this platform can deflate. Asked at every use rather than once at
// load, so a test can take it away, and because the answer costs nothing.
//
// CompressionStream exists on desktop Electron and in the WebViews Obsidian
// mobile uses, but that is the one thing in this design that can only be
// confirmed on a device. Its absence must degrade to storing a block
// uncompressed, never to failing to save.
export function deflateAvailable(): boolean {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

// String.fromCharCode takes its bytes as arguments, and an argument list has
// a length limit. A chunk this size is well inside it everywhere.
const BASE64_CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
	}
	return btoa(binary);
}

// Anchored, one character class, no alternation: linear in the input, so it
// is safe on a few hundred KB.
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	// atob tolerates whitespace and missing padding. A payload this module
	// wrote has neither, so either one means the string is not what was
	// written.
	if (text.length % 4 !== 0 || !BASE64_TEXT.test(text)) return null;
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

interface ByteTransform {
	readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly writable: WritableStream<BufferSource>;
}

// Streams one buffer through a transform and collects what comes out.
//
// Written against the streams themselves rather than Blob and Response, which
// are the shorter route and are not all present in every environment this
// runs in. Both sides are awaited together, so an error on either — a corrupt
// block fails on the readable side — rejects rather than hanging.
async function transform(bytes: Uint8Array<ArrayBuffer>, stream: ByteTransform): Promise<Uint8Array<ArrayBuffer>> {
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;

	const writing = (async () => {
		await writer.write(bytes);
		await writer.close();
	})();
	const reading = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			chunks.push(value);
			total += value.length;
		}
	})();
	await Promise.all([writing, reading]);

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export async function encodeStrokes(annotations: readonly Annotation[]): Promise<{ strokes: string; codec: StrokeCodec }> {
	const json = new TextEncoder().encode(JSON.stringify(annotations.map(storedAnnotation)));
	if (deflateAvailable()) {
		try {
			// 'deflate', not 'deflate-raw': the zlib wrapper's Adler-32 trailer is
			// the whole of this format's integrity checking.
			return { strokes: toBase64(await transform(json, new CompressionStream('deflate'))), codec: 'deflate' };
		} catch (error) {
			console.error('Inkling: compressing a block failed, so it is being stored uncompressed.', error);
		}
	}
	// Still base64. Everything that reads a file relies on `strokes` never
	// holding a brace or a quote, whatever produced it.
	return { strokes: toBase64(json), codec: 'none' };
}

export type DecodedStrokes =
	| { kind: 'decoded'; annotations: Annotation[] }
	// Something corrupted it.
	| { kind: 'undecodable' }
	// Nothing is wrong with it; this reader cannot open it.
	| { kind: 'unsupported'; codec: string };

const UNDECODABLE: DecodedStrokes = { kind: 'undecodable' };

export async function decodeStrokes(strokes: unknown, codec: unknown): Promise<DecodedStrokes> {
	// Absent means deflate, which is what every block written on a capable
	// device says by saying nothing.
	const name = codec === undefined ? 'deflate' : codec;
	if (typeof name !== 'string') return UNDECODABLE;
	if (name !== 'deflate' && name !== 'none') return { kind: 'unsupported', codec: name };
	if (name === 'deflate' && !deflateAvailable()) return { kind: 'unsupported', codec: name };

	if (typeof strokes !== 'string') return UNDECODABLE;
	const bytes = fromBase64(strokes);
	if (!bytes) return UNDECODABLE;

	let json = bytes;
	if (name === 'deflate') {
		try {
			json = await transform(bytes, new DecompressionStream('deflate'));
		} catch {
			return UNDECODABLE;
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
	} catch {
		return UNDECODABLE;
	}
	if (!Array.isArray(parsed)) return UNDECODABLE;

	// All or nothing. A block that decodes only partly is carried through
	// untouched and shown read-only; keeping what survived would mean the next
	// save wrote the rest away.
	const { annotations, dropped } = readAnnotations(parsed);
	if (dropped > 0) return UNDECODABLE;
	return { kind: 'decoded', annotations };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/markdown/inkFileCodec.test.ts tests/markdown/inkBlockFormat.test.ts tests/markdown/inkBlockFormatV2.test.ts`
Expected: PASS.

If `tsc` rejects a `Uint8Array` generic in Step 7, the fix is at the type annotation only: TypeScript 5.9's `BufferSource` wants `Uint8Array<ArrayBuffer>`, and `TextEncoder.encode` already returns one.

- [ ] **Step 7: Build, lint, full test run, commit**

Run: `npm run build && npm run lint && npm test`
Expected: all pass.

```bash
git add src/markdown/inkBlockFormat.ts src/markdown/inkFileCodec.ts tests/markdown/inkFileCodec.test.ts
git commit -m "Compress a block's strokes the way the ink file will store them" -m "The strokes of one block are written as an in-note block writes its annotations, then deflated and base64-encoded. A platform without CompressionStream stores the block uncompressed, a deflated block read there is reported as unsupported rather than broken, and a block failing its Adler-32 check or holding any unreadable annotation is reported as undecodable.

readAnnotations is pulled out of parseInkBlock so the two formats share one definition of a readable annotation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 2: The ink file format

**Files:**
- Create: `src/markdown/inkFile.ts`
- Test: `tests/markdown/inkFile.test.ts`

**Interfaces:**
- Consumes: `encodeStrokes`, `decodeStrokes` (Task 1); `DEFAULT_BLOCK_WIDTH`, `DEFAULT_BLOCK_HEIGHT` from `inkBlockFormat.ts`.
- Produces:
  - `INK_FILE_VERSION = 1`, `INK_FILE_EXTENSION = 'ink'`
  - `interface InkFileBlock { width: number; height: number; caption?: string; annotations: Annotation[] }`
  - `interface InkFileContents { extra: Array<[string, unknown]>; blocks: Map<string, unknown> }`
  - `type InkFileRead = { kind: 'readable'; contents: InkFileContents } | { kind: 'from-future'; version: number } | { kind: 'damaged' }`
  - `parseInkFile(text: string): InkFileRead`
  - `type BlockRead = { kind: 'decoded'; block: InkFileBlock } | { kind: 'undecodable' } | { kind: 'unsupported'; codec: string }`
  - `readInkFileBlock(raw: unknown): Promise<BlockRead>`
  - `writeInkFileBlock(previous: unknown, block: InkFileBlock): Promise<Record<string, unknown>>`
  - `serializeInkFile(contents: InkFileContents): string`
  - `byteLength(text: string): number`
  - `emptyFileBlock(): InkFileBlock`

- [ ] **Step 1: Write the failing tests**

Create `tests/markdown/inkFile.test.ts`:

```ts
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
		expect(JSON.parse(text).version).toBe(INK_FILE_VERSION);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/markdown/inkFile.test.ts`
Expected: FAIL, cannot resolve `../../src/markdown/inkFile`.

- [ ] **Step 3: Write the format**

Create `src/markdown/inkFile.ts`:

```ts
import type { Annotation } from '../annotate/types';
import { DEFAULT_BLOCK_HEIGHT, DEFAULT_BLOCK_WIDTH } from './inkBlockFormat';
import { decodeStrokes, encodeStrokes } from './inkFileCodec';

// A file of ink blocks, one per note by convention, holding what an in-note
// block used to hold in the note itself.
//
// The structure stays in text and only the coordinates are opaque. A damaged
// file can be inspected and partly rescued by hand, a caption can be fixed in
// a text editor, and a sync merge can operate a block at a time, while the
// coordinates, which are 99% of the bytes and none of the meaning, are
// deflated per block.
//
// Everything here is untrusted input, for the same reasons an in-note block
// is: files sync, get shared, and can be hand-edited.

// Governs the structure of the file and nothing else. Compression is per
// block, and so is the fallback when a device cannot compress, so it is
// described per block (see `codec`) rather than here.
export const INK_FILE_VERSION = 1;
export const INK_FILE_EXTENSION = 'ink';

export interface InkFileBlock {
	width: number;
	height: number;
	caption?: string;
	annotations: Annotation[];
}

export function emptyFileBlock(): InkFileBlock {
	return { width: DEFAULT_BLOCK_WIDTH, height: DEFAULT_BLOCK_HEIGHT, annotations: [] };
}

// A file as read, before any block is decoded. Blocks stay exactly as the
// JSON held them, whatever that was, so a block this build cannot read can
// still be written back.
export interface InkFileContents {
	// Top-level keys other than `version` and `blocks`, in the order read.
	extra: Array<[string, unknown]>;
	blocks: Map<string, unknown>;
}

export type InkFileRead =
	| { kind: 'readable'; contents: InkFileContents }
	// Valid, and written by a newer Inkling. Never written over, never repaired.
	| { kind: 'from-future'; version: number }
	// Not JSON, or JSON that is not a block map.
	| { kind: 'damaged' };

const DAMAGED: InkFileRead = { kind: 'damaged' };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseInkFile(text: string): InkFileRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return DAMAGED;
	}
	if (!isRecord(parsed)) return DAMAGED;

	const version = parsed.version === undefined ? INK_FILE_VERSION : parsed.version;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return DAMAGED;
	// Before looking at the blocks: a newer version may have changed what a
	// block map looks like, and that is not damage.
	if (version > INK_FILE_VERSION) return { kind: 'from-future', version };
	if (!isRecord(parsed.blocks)) return DAMAGED;

	const extra = Object.entries(parsed).filter(([key]) => key !== 'version' && key !== 'blocks');
	return { kind: 'readable', contents: { extra, blocks: new Map(Object.entries(parsed.blocks)) } };
}

export type BlockRead =
	| { kind: 'decoded'; block: InkFileBlock }
	| { kind: 'undecodable' }
	| { kind: 'unsupported'; codec: string };

export async function readInkFileBlock(raw: unknown): Promise<BlockRead> {
	if (!isRecord(raw)) return { kind: 'undecodable' };
	const strokes = await decodeStrokes(raw.strokes, raw.codec);
	if (strokes.kind !== 'decoded') return strokes;

	const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
	return {
		kind: 'decoded',
		block: {
			width: positive(raw.width) ?? DEFAULT_BLOCK_WIDTH,
			height: positive(raw.height) ?? DEFAULT_BLOCK_HEIGHT,
			...(caption ? { caption } : {}),
			annotations: strokes.annotations,
		},
	};
}

const KNOWN_BLOCK_KEYS = new Set(['width', 'height', 'caption', 'strokes', 'codec']);

// A block ready to be serialized, keeping every key of `previous` this build
// does not own, so a future version's additions survive this version's saves.
//
// Built on a null prototype: a hand-edited or hostile file can hold a key
// called "__proto__", and assigning that on an ordinary object would set the
// prototype instead of carrying the key.
export async function writeInkFileBlock(previous: unknown, block: InkFileBlock): Promise<Record<string, unknown>> {
	const { strokes, codec } = await encodeStrokes(block.annotations);
	const next = Object.create(null) as Record<string, unknown>;
	next.width = block.width;
	next.height = block.height;
	const caption = block.caption?.trim();
	if (caption) next.caption = caption;
	if (isRecord(previous)) {
		for (const [key, value] of Object.entries(previous)) {
			if (!KNOWN_BLOCK_KEYS.has(key)) next[key] = value;
		}
	}
	// Absent means deflate, so a capable device writes nothing extra.
	if (codec !== 'deflate') next.codec = codec;
	// Last, so the readable part of a block comes first on its line.
	next.strokes = strokes;
	return next;
}

// One block per line. Obsidian never opens this file in an editor, so a long
// line costs nothing, and one block per line is what lets a line-based sync
// merge treat two blocks edited on two devices as two unrelated changes.
export function serializeInkFile(contents: InkFileContents): string {
	const lines = ['{', `  "version": ${INK_FILE_VERSION},`];
	for (const [key, value] of contents.extra) {
		lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	}

	const entries = [...contents.blocks];
	if (entries.length === 0) {
		lines.push('  "blocks": {}');
	} else {
		lines.push('  "blocks": {');
		entries.forEach(([id, raw], index) => {
			const comma = index < entries.length - 1 ? ',' : '';
			lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(raw)}${comma}`);
		});
		lines.push('  }');
	}
	lines.push('}');
	return `${lines.join('\n')}\n`;
}

// What a file of this text occupies on disk. Everything written is ASCII
// except a caption, which holds whatever the user typed, so string length
// disagrees with the file the moment a caption holds an accent — and a
// size check that cried "truncated" on every such save would be worse than
// none.
export function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/markdown/inkFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Build, lint, test, commit**

Run: `npm run build && npm run lint && npm test`

```bash
git add src/markdown/inkFile.ts tests/markdown/inkFile.test.ts
git commit -m "Read and write the ink file, keeping what this build cannot read" -m "A file classifies as readable, from the future, or damaged, and each block within a readable one as decoded, undecodable, or unsupported. A block this build cannot decode, and any key it does not recognise at either level, is written back exactly as it was read, so saving one block can never erase another.

The file keeps one block per line, so a line-based sync merge can treat edits to two blocks as unrelated changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 3: The fence

**Files:**
- Create: `src/markdown/inkFence.ts`
- Test: `tests/markdown/inkFence.test.ts`

**Interfaces:**
- Consumes: `INK_BLOCK_LANGUAGE` from `inkBlockFormat.ts`.
- Produces:
  - `interface InkFence { file: string; id: string; extra: string[] }`
  - `type InkFenceDamage = 'missing-file' | 'missing-id' | 'not-a-vault-path' | 'duplicate-key'`
  - `type InkFenceRead = { kind: 'fence'; fence: InkFence } | { kind: 'damaged'; reason: InkFenceDamage }`
  - `isInkFileFence(source: string): boolean`
  - `parseInkFence(source: string): InkFenceRead`
  - `serializeInkFence(fence: InkFence): string`
  - `inkFenceMarkdown(fence: InkFence): string`
  - `isVaultPath(path: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/markdown/inkFence.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/markdown/inkFence.test.ts`
Expected: FAIL, cannot resolve `../../src/markdown/inkFence`.

- [ ] **Step 3: Write the fence module**

Create `src/markdown/inkFence.ts`:

```ts
import { INK_BLOCK_LANGUAGE } from './inkBlockFormat';

// The three lines a block leaves in the note once its ink lives in a file.
//
//     ```inkling
//     file: Attachments/Newton's Laws of Motion Exercises.ink
//     id: 2b
//     ```
//
// `file` is explicit rather than derived from the note's name, so a fence
// means the same thing wherever it is pasted: a copied block shares the
// original's ink, which is what was asked for.

export interface InkFence {
	file: string;
	id: string;
	// Every other non-blank line, trimmed, in order. Kept rather than parsed,
	// so a line a later version adds survives this version rewriting the fence.
	extra: string[];
}

export type InkFenceDamage = 'missing-file' | 'missing-id' | 'not-a-vault-path' | 'duplicate-key';

export type InkFenceRead = { kind: 'fence'; fence: InkFence } | { kind: 'damaged'; reason: InkFenceDamage };

// A line that opens with a key. Anchored, and linear in the line.
const KEY_LINE = /^[A-Za-z][A-Za-z0-9_-]*\s*:/;

// Which format a fence holds, decided by its content. JSON — anything opening
// with a brace, and an empty fence, which has always meant an empty in-note
// block — is the old format; a body opening with a `key:` line is the new
// one. Anything else goes to the old format's parser, which already knows how
// to show a block it cannot read.
export function isInkFileFence(source: string): boolean {
	const trimmed = source.trim();
	if (!trimmed || trimmed.startsWith('{')) return false;
	return KEY_LINE.test(trimmed);
}

// A path inside the vault, as the Vault API names one. Anything absolute,
// anything climbing out, and anything hidden is refused: Obsidian's Vault API
// does not see paths beginning with a dot at all, and ink that silently stops
// syncing is the worst failure available.
export function isVaultPath(path: string): boolean {
	if (!path || path !== path.trim()) return false;
	if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
	return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'));
}

export function parseInkFence(source: string): InkFenceRead {
	let file: string | undefined;
	let id: string | undefined;
	const extra: string[] = [];

	for (const raw of source.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const colon = line.indexOf(':');
		const key = colon > 0 ? line.slice(0, colon).trim() : '';
		const value = colon > 0 ? line.slice(colon + 1).trim() : '';

		if (key === 'file' || key === 'id') {
			// Two answers to where the ink is is no answer. Refusing is what
			// stops a save guessing between them.
			if ((key === 'file' ? file : id) !== undefined) return { kind: 'damaged', reason: 'duplicate-key' };
			if (key === 'file') file = value;
			else id = value;
			continue;
		}
		extra.push(line);
	}

	if (!file) return { kind: 'damaged', reason: 'missing-file' };
	if (!id) return { kind: 'damaged', reason: 'missing-id' };
	if (!isVaultPath(file)) return { kind: 'damaged', reason: 'not-a-vault-path' };
	return { kind: 'fence', fence: { file, id, extra } };
}

export function serializeInkFence(fence: InkFence): string {
	return [`file: ${fence.file}`, `id: ${fence.id}`, ...fence.extra].join('\n');
}

export function inkFenceMarkdown(fence: InkFence): string {
	return `\`\`\`${INK_BLOCK_LANGUAGE}\n${serializeInkFence(fence)}\n\`\`\``;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/markdown/inkFence.test.ts`
Expected: PASS.

- [ ] **Step 5: Build, lint, test, commit**

Run: `npm run build && npm run lint && npm test`

```bash
git add src/markdown/inkFence.ts tests/markdown/inkFence.test.ts
git commit -m "Read the three-line fence a block leaves in its note" -m "A fence names its ink file and its block. The format is decided by the fence's own content: JSON, or nothing, is an in-note block as before, and key: value lines are the new format. A fence missing either key, naming either twice, or naming a path outside the vault or inside a hidden folder is damaged. Lines this build does not recognise survive a rewrite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 4: The store, reading

**Files:**
- Create: `src/markdown/inkFileStore.ts`
- Create: `tests/harness/inkFileIO.ts`
- Test: `tests/markdown/inkFileStore.test.ts`

**Interfaces:**
- Consumes: `parseInkFile`, `readInkFileBlock`, `InkFileBlock`, `InkFileContents`, `BlockRead` (Task 2).
- Produces:
  - `interface InkFileIO { read(path: string): Promise<string | null>; replaceIf(path: string, expected: string | null, next: string): Promise<ReplaceResult>; size(path: string): Promise<number | null> }`
  - `type ReplaceResult = { written: true } | { written: false; found: string | null }`
  - `type InkFileStatus = { kind: 'loading' } | { kind: 'readable' } | { kind: 'absent' } | { kind: 'from-future'; version: number } | { kind: 'damaged' }`
  - `type BlockState = { kind: 'decoded'; block: InkFileBlock; revision: number; strokes: string } | { kind: 'undecodable' } | { kind: 'unsupported'; codec: string } | { kind: 'absent' }`
  - `type StoreChange = ReadonlySet<string> | 'all'`, `type StoreListener = (change: StoreChange, origin: object | null) => void`
  - `class InkFileStore { readonly path: string; constructor(path: string, io: InkFileIO); status(): InkFileStatus; load(): Promise<void>; whenIdle(): Promise<void>; blockState(id: string): BlockState; subscribe(listener: StoreListener): () => void; fileChanged(): void; fileDeleted(): void }`
  - `class InkFileStores { constructor(io: InkFileIO); acquire(path: string): InkFileStore; release(path: string): void; isHeld(path: string): boolean; fileChanged(path: string): void; fileDeleted(path: string): void; fileRenamed(oldPath: string, newPath: string): void }`
  - Test harness: `memoryInkFileIO(initial?: Record<string, string>): MemoryInkFileIO` and `inkFileText(blocks: Record<string, InkFileBlock | unknown>, extra?: Array<[string, unknown]>): Promise<string>`

- [ ] **Step 1: Write the in-memory IO**

Create `tests/harness/inkFileIO.ts`:

```ts
import type { InkFileIO, ReplaceResult } from '../../src/markdown/inkFileStore';
import { serializeInkFile, writeInkFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';

// Ink files held in a Map, with the failures a real vault produces on demand.
//
// Every write goes through replaceIf, which is the store's only way to write,
// so a hook placed there sees exactly the moments at which a change landing
// from elsewhere matters.
export interface MemoryInkFileIO extends InkFileIO {
	files: Map<string, string>;
	/** Every call to read, including the store's verification re-read. */
	reads: number;
	/** Every write that reached a file. */
	writes: number;
	/** Runs at the start of the next replaceIf, then clears itself — a sync landing mid-save. */
	beforeReplace: ((path: string) => void) | null;
	/** Leaves only the first half of the next write on disk — the app killed mid-save. */
	truncateNextWrite: boolean;
	/** Throws from the next write. */
	failNextWrite: boolean;
}

export function memoryInkFileIO(initial: Record<string, string> = {}): MemoryInkFileIO {
	const io: MemoryInkFileIO = {
		files: new Map(Object.entries(initial)),
		reads: 0,
		writes: 0,
		beforeReplace: null,
		truncateNextWrite: false,
		failNextWrite: false,
		read: async (path) => {
			io.reads += 1;
			return io.files.get(path) ?? null;
		},
		size: async (path) => {
			const text = io.files.get(path);
			return text === undefined ? null : new TextEncoder().encode(text).length;
		},
		replaceIf: async (path, expected, next): Promise<ReplaceResult> => {
			const hook = io.beforeReplace;
			io.beforeReplace = null;
			hook?.(path);
			if (io.failNextWrite) {
				io.failNextWrite = false;
				throw new Error('disk full');
			}
			const current = io.files.get(path) ?? null;
			if (current !== expected) return { written: false, found: current };
			io.files.set(path, io.truncateNextWrite ? next.slice(0, Math.floor(next.length / 2)) : next);
			io.truncateNextWrite = false;
			io.writes += 1;
			return { written: true };
		},
	};
	return io;
}

function isFileBlock(value: unknown): value is InkFileBlock {
	return typeof value === 'object' && value !== null && Array.isArray((value as { annotations?: unknown }).annotations);
}

/** An ink file's text. An InkFileBlock is encoded; anything else is written as the raw block. */
export async function inkFileText(blocks: Record<string, unknown>, extra: Array<[string, unknown]> = []): Promise<string> {
	const raw = new Map<string, unknown>();
	for (const [id, block] of Object.entries(blocks)) {
		raw.set(id, isFileBlock(block) ? await writeInkFileBlock(undefined, block) : block);
	}
	return serializeInkFile({ extra, blocks: raw });
}
```

- [ ] **Step 2: Write the failing store tests**

Create `tests/markdown/inkFileStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { emptyFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { InkFileStore, InkFileStores, type StoreChange } from '../../src/markdown/inkFileStore';
import { inkFileText, memoryInkFileIO } from '../harness/inkFileIO';

const PATH = 'Attachments/Physics.ink';

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

function record(store: InkFileStore): StoreChange[] {
	const changes: StoreChange[] = [];
	store.subscribe((change) => changes.push(change));
	return changes;
}

describe('opening an ink file', () => {
	it('reports a file that does not exist as absent', async () => {
		const store = new InkFileStore(PATH, memoryInkFileIO());
		await store.load();
		expect(store.status()).toEqual({ kind: 'absent' });
		expect(store.blockState('a')).toEqual({ kind: 'absent' });
	});

	it('decodes each block and says which it could not', async () => {
		const io = memoryInkFileIO({
			[PATH]: await inkFileText({
				good: holding('s1'),
				broken: { width: 800, height: 450, strokes: '%%%%' },
				foreign: { width: 800, height: 450, strokes: 'AAAA', codec: 'zstd' },
			}),
		});
		const store = new InkFileStore(PATH, io);
		await store.load();

		expect(store.status()).toEqual({ kind: 'readable' });
		const good = store.blockState('good');
		expect(good.kind === 'decoded' && good.block.annotations.map((a) => a.id)).toEqual(['s1']);
		expect(good.kind === 'decoded' && good.strokes.length).toBeGreaterThan(0);
		expect(store.blockState('broken')).toEqual({ kind: 'undecodable' });
		expect(store.blockState('foreign')).toEqual({ kind: 'unsupported', codec: 'zstd' });
		expect(store.blockState('elsewhere')).toEqual({ kind: 'absent' });
	});

	it('reports a file from a newer version as that, not as damage', async () => {
		const store = new InkFileStore(PATH, memoryInkFileIO({ [PATH]: '{"version":7,"blocks":{}}' }));
		await store.load();
		expect(store.status()).toEqual({ kind: 'from-future', version: 7 });
	});

	it('reports a file it cannot parse as damaged', async () => {
		const store = new InkFileStore(PATH, memoryInkFileIO({ [PATH]: '{"version":1,"blocks":{"a": {' }));
		await store.load();
		expect(store.status()).toEqual({ kind: 'damaged' });
	});

	it('loads once however many blocks ask', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding() }) });
		const store = new InkFileStore(PATH, io);
		await Promise.all([store.load(), store.load(), store.load()]);
		expect(io.reads).toBe(1);
	});
});

describe('a change made elsewhere', () => {
	it('re-reads only the blocks that changed, and says which', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1'), b: holding('s2') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const before = store.blockState('a');
		const changes = record(store);

		io.files.set(PATH, await inkFileText({ a: holding('s1'), b: holding('s2', 's3') }));
		store.fileChanged();
		await store.whenIdle();

		expect(changes).toEqual([new Set(['b'])]);
		expect(store.blockState('a')).toEqual(before);
		const b = store.blockState('b');
		expect(b.kind === 'decoded' && b.block.annotations).toHaveLength(2);
	});

	it('says nothing when the file holds what it already had', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		store.fileChanged();
		await store.whenIdle();

		expect(changes).toEqual([]);
	});

	it('reports a block that disappeared from the file', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1'), b: holding() }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		io.files.set(PATH, await inkFileText({ a: holding('s1') }));
		store.fileChanged();
		await store.whenIdle();

		expect(changes).toEqual([new Set(['b'])]);
		expect(store.blockState('b')).toEqual({ kind: 'absent' });
	});

	// A sync caught mid-write leaves a partial file on disk for a moment. What
	// the session already holds is the better copy, and nothing should stop.
	it('does not let a damaged read displace a good one', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		io.files.set(PATH, '{"version":1,"blocks":{"a":');
		store.fileChanged();
		await store.whenIdle();

		expect(store.status()).toEqual({ kind: 'readable' });
		expect(store.blockState('a').kind).toBe('decoded');
		expect(changes).toEqual([]);
	});

	it('goes absent when the file is deleted', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding('s1') }) });
		const store = new InkFileStore(PATH, io);
		await store.load();
		const changes = record(store);

		io.files.delete(PATH);
		store.fileDeleted();
		await store.whenIdle();

		expect(store.status()).toEqual({ kind: 'absent' });
		expect(changes).toEqual(['all']);
	});
});

describe('sharing stores', () => {
	it('hands every block naming a file the same store', () => {
		const stores = new InkFileStores(memoryInkFileIO());
		expect(stores.acquire(PATH)).toBe(stores.acquire(PATH));
	});

	it('lets a store go once nothing uses it and its queue is empty', async () => {
		const stores = new InkFileStores(memoryInkFileIO());
		const store = stores.acquire(PATH);
		stores.acquire(PATH);
		stores.release(PATH);
		await store.whenIdle();
		expect(stores.isHeld(PATH)).toBe(true);

		stores.release(PATH);
		await store.whenIdle();
		await Promise.resolve();
		expect(stores.isHeld(PATH)).toBe(false);
	});

	it('routes a change to the store for that path only', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding() }), 'Other.ink': await inkFileText({}) });
		const stores = new InkFileStores(io);
		const store = stores.acquire(PATH);
		await store.load();
		const readsBefore = io.reads;

		stores.fileChanged('Other.ink');
		await store.whenIdle();
		expect(io.reads).toBe(readsBefore);

		stores.fileChanged(PATH);
		await store.whenIdle();
		expect(io.reads).toBe(readsBefore + 1);
	});

	// Phase 4 rewrites the fences. Until then a renamed file is, to a fence
	// naming its old path, a missing one.
	it('treats a renamed file as gone from its old path', async () => {
		const io = memoryInkFileIO({ [PATH]: await inkFileText({ a: holding() }) });
		const stores = new InkFileStores(io);
		const store = stores.acquire(PATH);
		await store.load();

		stores.fileRenamed(PATH, 'Attachments/Renamed.ink');
		await store.whenIdle();
		expect(store.status()).toEqual({ kind: 'absent' });
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/markdown/inkFileStore.test.ts`
Expected: FAIL, cannot resolve `../../src/markdown/inkFileStore`.

- [ ] **Step 4: Write the store's read side**

Create `src/markdown/inkFileStore.ts`:

```ts
import { parseInkFile, readInkFileBlock, type BlockRead, type InkFileBlock, type InkFileContents } from './inkFile';

// One live ink file, shared by every block that names it.
//
// It reads the file, holds the last parse that succeeded, tells blocks when
// something they show has changed, and — see the write half below — queues
// every write to the file one after another. Everything that changes what
// the store holds runs through that one queue, reads included, so an
// external change and a save can never interleave halfway through either.
//
// Pure of Obsidian: the file is reached through InkFileIO, which the plugin
// implements over the Vault (inkFileVaultIO.ts) and the tests over a Map.

export interface InkFileIO {
	/** The file's text, or null when there is no file at `path`. */
	read(path: string): Promise<string | null>;
	/**
	 * Writes `next` only if the file still reads `expected` (null: only if it
	 * does not exist, creating it). The comparison and the write are one
	 * operation, so a change landing between them cannot be overwritten.
	 */
	replaceIf(path: string, expected: string | null, next: string): Promise<ReplaceResult>;
	/** The file's size on disk in bytes, or null when that cannot be known. */
	size(path: string): Promise<number | null>;
}

export type ReplaceResult = { written: true } | { written: false; found: string | null };

export type InkFileStatus =
	| { kind: 'loading' }
	| { kind: 'readable' }
	// No file at this path. Blocks already held are kept, not forgotten: they
	// may be the only copy there is.
	| { kind: 'absent' }
	| { kind: 'from-future'; version: number }
	// Unreadable, with no good parse held from earlier in the session.
	| { kind: 'damaged' };

export type BlockState =
	| { kind: 'decoded'; block: InkFileBlock; revision: number; strokes: string }
	| { kind: 'undecodable' }
	| { kind: 'unsupported'; codec: string }
	| { kind: 'absent' };

export type StoreChange = ReadonlySet<string> | 'all';
// `origin` is whoever caused the change — a block's own storage for its own
// save, null for anything that came from the file.
export type StoreListener = (change: StoreChange, origin: object | null) => void;

interface HeldBlock {
	read: BlockRead;
	// The block exactly as the file held it, serialized, which is how a
	// re-read tells a block that changed from one that did not without
	// decoding either.
	json: string;
	// Changes whenever the block does. See the write half: a save merges
	// whenever the revision it was based on is not the one held.
	revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class InkFileStore {
	private current: InkFileStatus = { kind: 'loading' };
	// The last parse that succeeded, blocks still raw. Null until one has.
	private contents: InkFileContents | null = null;
	private readonly held = new Map<string, HeldBlock>();
	// The file's text as last read or written; null when there was no file.
	// A save writes only over exactly this.
	private lastText: string | null = null;
	private revisions = 0;
	private readonly listeners = new Set<StoreListener>();
	private tail: Promise<unknown> = Promise.resolve();
	private loading: Promise<void> | null = null;

	constructor(
		readonly path: string,
		private readonly io: InkFileIO,
	) {}

	status(): InkFileStatus {
		return this.current;
	}

	load(): Promise<void> {
		this.loading ??= this.enqueue(() => this.readFromDisk());
		return this.loading;
	}

	/** Settles once everything queued so far has run. */
	async whenIdle(): Promise<void> {
		await this.tail;
	}

	blockState(id: string): BlockState {
		const held = this.held.get(id);
		if (!held) return { kind: 'absent' };
		if (held.read.kind !== 'decoded') return held.read;
		return { kind: 'decoded', block: held.read.block, revision: held.revision, strokes: this.strokesOf(id) };
	}

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	fileChanged(): void {
		void this.enqueue(() => this.readFromDisk());
	}

	fileDeleted(): void {
		void this.enqueue(() => this.adopt(null, null));
	}

	// The opaque stroke payload, which is what the rescue store compares a
	// held drawing against to prove the file has not moved on.
	private strokesOf(id: string): string {
		const raw = this.contents?.blocks.get(id);
		return isRecord(raw) && typeof raw.strokes === 'string' ? raw.strokes : '';
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task);
		// The queue survives a task that throws; the caller still sees it.
		this.tail = run.catch(() => undefined);
		return run;
	}

	private notify(change: StoreChange, origin: object | null): void {
		for (const listener of [...this.listeners]) listener(change, origin);
	}

	private async readFromDisk(): Promise<void> {
		let text: string | null;
		try {
			text = await this.io.read(this.path);
		} catch (error) {
			console.error(`Inkling: could not read ${this.path}.`, error);
			// Not the same as absent: something is there. Nothing is known about
			// it, so nothing may be written over it.
			if (this.current.kind === 'loading') {
				this.current = { kind: 'damaged' };
				this.notify('all', null);
			}
			return;
		}
		await this.adopt(text, null);
	}

	// Takes on what the file says now.
	private async adopt(text: string | null, origin: object | null): Promise<void> {
		if (text === null) {
			if (this.current.kind === 'absent') return;
			this.lastText = null;
			this.current = { kind: 'absent' };
			this.notify('all', origin);
			return;
		}

		// Almost always our own write, reported back by the vault.
		if (text === this.lastText && this.current.kind !== 'loading') return;

		const read = parseInkFile(text);
		if (read.kind === 'damaged') {
			// A damaged read never displaces a good one. A file caught mid-sync
			// is partial for a moment and whole a moment later, and the session
			// goes on serving what it holds while that settles. lastText is left
			// alone, so a save made meanwhile sees the file is not what it last
			// saw and refuses rather than writing over it.
			if (this.contents && this.current.kind === 'readable') return;
			this.current = { kind: 'damaged' };
			this.notify('all', origin);
			return;
		}

		if (read.kind === 'from-future') {
			this.lastText = text;
			this.current = { kind: 'from-future', version: read.version };
			this.notify('all', origin);
			return;
		}

		const changed = new Set<string>();
		const next = new Map<string, HeldBlock>();
		for (const [id, raw] of read.contents.blocks) {
			const json = JSON.stringify(raw);
			const previous = this.held.get(id);
			if (previous && previous.json === json) {
				next.set(id, previous);
				continue;
			}
			next.set(id, { read: await readInkFileBlock(raw), json, revision: ++this.revisions });
			changed.add(id);
		}
		for (const id of this.held.keys()) {
			if (!next.has(id)) changed.add(id);
		}

		this.held.clear();
		for (const [id, block] of next) this.held.set(id, block);
		this.contents = read.contents;
		this.lastText = text;

		const wasReadable = this.current.kind === 'readable';
		this.current = { kind: 'readable' };
		if (!wasReadable) this.notify('all', origin);
		else if (changed.size > 0) this.notify(changed, origin);
	}
}

// Every store in use, so blocks naming the same file share one — which is
// what makes a copied fence show the original's ink, and what keeps two
// blocks in one note from racing each other to write the same file.
export class InkFileStores {
	private readonly entries = new Map<string, { store: InkFileStore; users: number }>();

	constructor(private readonly io: InkFileIO) {}

	acquire(path: string): InkFileStore {
		let entry = this.entries.get(path);
		if (!entry) {
			entry = { store: new InkFileStore(path, this.io), users: 0 };
			this.entries.set(path, entry);
		}
		entry.users += 1;
		return entry.store;
	}

	// A store outlives its last user until its queue is empty, so a block that
	// flushes a save as it is torn down still gets that save written.
	release(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		entry.users -= 1;
		if (entry.users > 0) return;
		void entry.store.whenIdle().then(() => {
			if (entry.users <= 0 && this.entries.get(path) === entry) this.entries.delete(path);
		});
	}

	isHeld(path: string): boolean {
		return this.entries.has(path);
	}

	fileChanged(path: string): void {
		this.entries.get(path)?.store.fileChanged();
	}

	fileDeleted(path: string): void {
		this.entries.get(path)?.store.fileDeleted();
	}

	// Until fences are rewritten on rename, a fence naming the old path is
	// naming a file that is not there.
	fileRenamed(oldPath: string, newPath: string): void {
		this.fileDeleted(oldPath);
		this.fileChanged(newPath);
	}
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/markdown/inkFileStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Build, lint, test, commit**

Run: `npm run build && npm run lint && npm test`

```bash
git add src/markdown/inkFileStore.ts tests/harness/inkFileIO.ts tests/markdown/inkFileStore.test.ts
git commit -m "Hold one live copy of each ink file" -m "A store reads an ink file once for every block that names it, reports it absent, from the future or damaged, and tells blocks which of them changed when the file changes elsewhere. A damaged read never displaces a parse the session already holds, and a deleted file's blocks stay held.

Stores are shared by path and let go once nothing uses them and nothing is queued. A renamed file reads as missing at its old path until fences are rewritten on rename.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 5: The store, writing

**Files:**
- Modify: `src/markdown/inkFileStore.ts`
- Test: `tests/markdown/inkFileStoreWrites.test.ts`

**Interfaces:**
- Consumes: Task 4's store; `writeInkFileBlock`, `serializeInkFile`, `byteLength` (Task 2); `decodeStrokes` (Task 1); `mergeInkBlocks(base, ours, theirs)` and `INK_BLOCK_VERSION`, `InkBlockData`.
- Produces, on `InkFileStore`:
  - `updateBlock(id: string, writer: object, data: InkFileBlock, base: BlockBase): Promise<WriteOutcome>`
  - `createBlock(id: string, data: InkFileBlock): Promise<WriteOutcome>`
- And exported:
  - `interface BlockBase { block: InkFileBlock; revision: number }`
  - `type WriteRefusal = 'not-writable' | 'block-absent' | 'block-unreadable' | 'block-exists' | 'encoding-mismatch' | 'no-blocks-over-blocks' | 'moved-on' | 'failed'`
  - `type WriteOutcome = { kind: 'written'; block: InkFileBlock; revision: number; merged: boolean } | { kind: 'refused'; reason: WriteRefusal }`
  - `toInkBlockData(block: InkFileBlock, id?: string): InkBlockData`
  - `toFileBlock(data: InkBlockData): InkFileBlock`

- [ ] **Step 1: Write the failing tests**

Create `tests/markdown/inkFileStoreWrites.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { decodeStrokes } from '../../src/markdown/inkFileCodec';
import { emptyFileBlock, parseInkFile, readInkFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { InkFileStore, type BlockBase } from '../../src/markdown/inkFileStore';
import { inkFileText, memoryInkFileIO, type MemoryInkFileIO } from '../harness/inkFileIO';

// Spied on rather than replaced, so every test but one runs the real codec.
vi.mock('../../src/markdown/inkFileCodec', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/markdown/inkFileCodec')>();
	return { ...actual, decodeStrokes: vi.fn(actual.decodeStrokes) };
});

const PATH = 'Attachments/Physics.ink';

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

async function opened(blocks: Record<string, unknown>): Promise<{ io: MemoryInkFileIO; store: InkFileStore }> {
	const io = memoryInkFileIO({ [PATH]: await inkFileText(blocks) });
	const store = new InkFileStore(PATH, io);
	await store.load();
	return { io, store };
}

function baseOf(store: InkFileStore, id: string): BlockBase {
	const state = store.blockState(id);
	if (state.kind !== 'decoded') throw new Error(`block ${id} is ${state.kind}`);
	return { block: state.block, revision: state.revision };
}

async function idsOnDisk(io: MemoryInkFileIO, id: string): Promise<string[]> {
	const read = parseInkFile(io.files.get(PATH) ?? '');
	if (read.kind !== 'readable') throw new Error(`file on disk is ${read.kind}`);
	const block = await readInkFileBlock(read.contents.blocks.get(id));
	if (block.kind !== 'decoded') throw new Error(`block ${id} on disk is ${block.kind}`);
	return block.block.annotations.map((a) => a.id);
}

const writer = {};

describe('saving a block', () => {
	it('writes it to the file and moves its revision on', async () => {
		const { io, store } = await opened({ a: holding() });
		const base = baseOf(store, 'a');

		const outcome = await store.updateBlock('a', writer, holding('s1'), base);

		expect(outcome).toMatchObject({ kind: 'written', merged: false });
		expect(await idsOnDisk(io, 'a')).toEqual(['s1']);
		expect(baseOf(store, 'a').revision).not.toBe(base.revision);
	});

	it('tells other blocks, naming who saved', async () => {
		const { store } = await opened({ a: holding() });
		const heard: Array<[unknown, unknown]> = [];
		store.subscribe((change, origin) => heard.push([change, origin]));

		await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));

		expect(heard).toEqual([[new Set(['a']), writer]]);
	});

	it('lands two blocks saved in the same moment', async () => {
		const { io, store } = await opened({ a: holding(), b: holding() });

		await Promise.all([
			store.updateBlock('a', {}, holding('s1'), baseOf(store, 'a')),
			store.updateBlock('b', {}, holding('s2'), baseOf(store, 'b')),
		]);

		expect(await idsOnDisk(io, 'a')).toEqual(['s1']);
		expect(await idsOnDisk(io, 'b')).toEqual(['s2']);
	});

	it('collapses a save superseded while it was still queued', async () => {
		const { io, store } = await opened({ a: holding() });
		const base = baseOf(store, 'a');

		const first = store.updateBlock('a', writer, holding('s1'), base);
		const second = store.updateBlock('a', writer, holding('s1', 's2'), base);
		const outcomes = await Promise.all([first, second]);

		expect(io.writes).toBe(1);
		expect(outcomes[0]).toEqual(outcomes[1]);
		expect(await idsOnDisk(io, 'a')).toEqual(['s1', 's2']);
	});

	it('does not collapse two different blocks saving the same block id', async () => {
		const { io, store } = await opened({ a: holding() });
		const base = baseOf(store, 'a');

		await Promise.all([
			store.updateBlock('a', { copy: 1 }, holding('mine'), base),
			store.updateBlock('a', { copy: 2 }, holding('yours'), base),
		]);

		expect(io.writes).toBe(2);
		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['mine', 'yours']);
	});

	it('verifies the first write after opening, and only that one', async () => {
		const { io, store } = await opened({ a: holding() });
		const readsAtOpen = io.reads;

		await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));
		expect(io.reads).toBe(readsAtOpen + 1);

		await store.updateBlock('a', writer, holding('s1', 's2'), baseOf(store, 'a'));
		expect(io.reads).toBe(readsAtOpen + 1);
	});
});

describe('a save that lands after the file changed elsewhere', () => {
	it('merges with a change it had not heard about yet', async () => {
		const { io, store } = await opened({ a: holding('shared') });
		const base = baseOf(store, 'a');
		// Changed on disk with no event: the sync landed and the vault has not
		// said so yet.
		const theirs = await inkFileText({ a: holding('shared', 'theirs') });
		io.beforeReplace = () => io.files.set(PATH, theirs);

		const outcome = await store.updateBlock('a', writer, holding('shared', 'ours'), base);

		expect(outcome).toMatchObject({ kind: 'written', merged: true });
		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['ours', 'shared', 'theirs']);
	});

	it('merges with a change it has already re-read', async () => {
		const { io, store } = await opened({ a: holding('shared') });
		const base = baseOf(store, 'a');
		io.files.set(PATH, await inkFileText({ a: holding('shared', 'theirs') }));
		store.fileChanged();
		await store.whenIdle();

		const outcome = await store.updateBlock('a', writer, holding('shared', 'ours'), base);

		expect(outcome).toMatchObject({ kind: 'written', merged: true });
		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['ours', 'shared', 'theirs']);
	});

	it('honours an erasure made here', async () => {
		const { io, store } = await opened({ a: holding('keep', 'erase') });
		const base = baseOf(store, 'a');
		io.files.set(PATH, await inkFileText({ a: holding('keep', 'erase', 'theirs') }));

		await store.updateBlock('a', writer, holding('keep'), base);

		expect((await idsOnDisk(io, 'a')).sort()).toEqual(['keep', 'theirs']);
	});

	it('keeps a different block changed elsewhere', async () => {
		const { io, store } = await opened({ a: holding(), b: holding() });
		io.files.set(PATH, await inkFileText({ a: holding(), b: holding('theirs') }));

		await store.updateBlock('a', writer, holding('ours'), baseOf(store, 'a'));

		expect(await idsOnDisk(io, 'a')).toEqual(['ours']);
		expect(await idsOnDisk(io, 'b')).toEqual(['theirs']);
	});
});

describe('refusing', () => {
	it.each([
		['from a newer version', '{"version":9,"blocks":{}}'],
		['damaged', '{"version":1,"blocks":{'],
	])('never writes a file %s', async (_label, text) => {
		const io = memoryInkFileIO({ [PATH]: text });
		const store = new InkFileStore(PATH, io);
		await store.load();

		const outcome = await store.updateBlock('a', writer, holding('s1'), { block: holding(), revision: 0 });

		expect(outcome).toEqual({ kind: 'refused', reason: 'not-writable' });
		expect(io.files.get(PATH)).toBe(text);
	});

	it('never creates a file a save expected to find', async () => {
		const io = memoryInkFileIO();
		const store = new InkFileStore(PATH, io);
		await store.load();

		const outcome = await store.updateBlock('a', writer, holding('s1'), { block: holding(), revision: 0 });

		expect(outcome).toEqual({ kind: 'refused', reason: 'not-writable' });
		expect(io.files.has(PATH)).toBe(false);
	});

	it('refuses a block the file does not hold', async () => {
		const { store } = await opened({ a: holding() });
		expect(await store.updateBlock('b', writer, holding('s1'), { block: holding(), revision: 0 })).toEqual({
			kind: 'refused',
			reason: 'block-absent',
		});
	});

	it('refuses a block it could not decode', async () => {
		const { io, store } = await opened({ a: { width: 800, height: 450, strokes: '%%%%' } });
		const before = io.files.get(PATH);
		expect(await store.updateBlock('a', writer, holding('s1'), { block: holding(), revision: 0 })).toEqual({
			kind: 'refused',
			reason: 'block-unreadable',
		});
		expect(io.files.get(PATH)).toBe(before);
	});

	it('refuses a file that went bad on disk since it was read', async () => {
		const { io, store } = await opened({ a: holding() });
		io.files.set(PATH, '{"version":1,"blocks":{"a":');

		const outcome = await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));

		expect(outcome).toEqual({ kind: 'refused', reason: 'not-writable' });
		expect(io.files.get(PATH)).toBe('{"version":1,"blocks":{"a":');
	});

	it('refuses a block whose encoding does not decode back to what was encoded', async () => {
		const { io, store } = await opened({ a: holding() });
		const before = io.files.get(PATH);
		vi.mocked(decodeStrokes).mockResolvedValueOnce({ kind: 'decoded', annotations: [] });

		const outcome = await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'));

		expect(outcome).toEqual({ kind: 'refused', reason: 'encoding-mismatch' });
		expect(io.files.get(PATH)).toBe(before);
	});

	it('reports a write that failed and leaves the file as it was', async () => {
		const { io, store } = await opened({ a: holding() });
		const before = io.files.get(PATH);
		io.failNextWrite = true;

		expect(await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'))).toEqual({ kind: 'refused', reason: 'failed' });
		expect(io.files.get(PATH)).toBe(before);
	});

	// The failure a backgrounded app on mobile is killed into.
	it('notices a write cut short, and will not write over what it left', async () => {
		const { io, store } = await opened({ a: holding() });
		io.truncateNextWrite = true;

		expect(await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'))).toEqual({ kind: 'refused', reason: 'failed' });
		const truncated = io.files.get(PATH);

		expect(await store.updateBlock('a', writer, holding('s1'), baseOf(store, 'a'))).toEqual({
			kind: 'refused',
			reason: 'not-writable',
		});
		expect(io.files.get(PATH)).toBe(truncated);
	});

	// A caption is the one part of the file that can hold something other than
	// ASCII, and a size compared in characters would call every such save cut
	// short.
	it('does not mistake a caption with an accent for a write cut short', async () => {
		const { store } = await opened({ a: holding() });
		const outcome = await store.updateBlock('a', writer, { ...holding('s1'), caption: 'réaction normale' }, baseOf(store, 'a'));
		expect(outcome.kind).toBe('written');
	});
});

describe('carrying through', () => {
	it('keeps every block and key it could not read when another block is saved', async () => {
		const undecodable = { width: 800, height: 450, strokes: 'bm90IGRlZmxhdGU=' };
		const unsupported = { width: 800, height: 450, strokes: 'AAAA', codec: 'zstd' };
		const io = memoryInkFileIO({
			[PATH]: await inkFileText({ edited: holding(), undecodable, unsupported }, [['device', 'tablet']]),
		});
		const store = new InkFileStore(PATH, io);
		await store.load();

		await store.updateBlock('edited', writer, holding('s1'), baseOf(store, 'edited'));

		const text = io.files.get(PATH) ?? '';
		expect(text).toContain(`"undecodable": ${JSON.stringify(undecodable)}`);
		expect(text).toContain(`"unsupported": ${JSON.stringify(unsupported)}`);
		expect(text).toContain('"device": "tablet"');
	});
});

describe('creating a block', () => {
	it('creates the file for the first block', async () => {
		const io = memoryInkFileIO();
		const store = new InkFileStore(PATH, io);
		await store.load();

		expect(await store.createBlock('a', emptyFileBlock())).toMatchObject({ kind: 'written' });
		expect(store.status()).toEqual({ kind: 'readable' });
		expect(await idsOnDisk(io, 'a')).toEqual([]);
	});

	it('adds to a file that exists', async () => {
		const { io, store } = await opened({ a: holding('s1') });
		await store.createBlock('b', emptyFileBlock());
		expect(await idsOnDisk(io, 'a')).toEqual(['s1']);
		expect(await idsOnDisk(io, 'b')).toEqual([]);
	});

	it('refuses an id the file already holds', async () => {
		const { store } = await opened({ a: holding('s1') });
		expect(await store.createBlock('a', emptyFileBlock())).toEqual({ kind: 'refused', reason: 'block-exists' });
	});

	it('refuses a file it cannot read', async () => {
		const io = memoryInkFileIO({ [PATH]: '{"version":1,"blocks":{' });
		const store = new InkFileStore(PATH, io);
		await store.load();
		expect(await store.createBlock('a', emptyFileBlock())).toEqual({ kind: 'refused', reason: 'not-writable' });
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/markdown/inkFileStoreWrites.test.ts`
Expected: FAIL, `store.updateBlock is not a function`.

- [ ] **Step 3: Add the write half**

In `src/markdown/inkFileStore.ts`, replace the import line with:

```ts
import { INK_BLOCK_VERSION, type InkBlockData } from './inkBlockFormat';
import { decodeStrokes } from './inkFileCodec';
import {
	byteLength,
	parseInkFile,
	readInkFileBlock,
	serializeInkFile,
	writeInkFileBlock,
	type BlockRead,
	type InkFileBlock,
	type InkFileContents,
} from './inkFile';
import { mergeInkBlocks } from './mergeInkBlocks';
```

Add after the `StoreListener` type:

```ts
// What a block last put on screen: the data, and the revision it came from.
export interface BlockBase {
	block: InkFileBlock;
	revision: number;
}

export type WriteRefusal =
	// The file is absent, from the future, damaged, or not what was last read
	// and unreadable now.
	| 'not-writable'
	| 'block-absent'
	| 'block-unreadable'
	| 'block-exists'
	// The encoded block did not decode back to what was encoded.
	| 'encoding-mismatch'
	| 'no-blocks-over-blocks'
	// The file kept changing underneath every attempt.
	| 'moved-on'
	| 'failed';

export type WriteOutcome =
	| { kind: 'written'; block: InkFileBlock; revision: number; merged: boolean }
	| { kind: 'refused'; reason: WriteRefusal };

// A save that finds the file changed goes round again, merging. More than a
// few in a row is not a race, it is something rewriting the file constantly,
// and the drawing is safer held than chasing it.
const MAX_WRITE_ATTEMPTS = 3;

function refused(reason: WriteRefusal): WriteOutcome {
	return { kind: 'refused', reason };
}

// The in-note block's shape, which is what the merge and the rescue store
// already speak.
export function toInkBlockData(block: InkFileBlock, id?: string): InkBlockData {
	return {
		version: INK_BLOCK_VERSION,
		...(id ? { id } : {}),
		width: block.width,
		height: block.height,
		...(block.caption ? { caption: block.caption } : {}),
		annotations: block.annotations,
	};
}

export function toFileBlock(data: InkBlockData): InkFileBlock {
	return {
		width: data.width,
		height: data.height,
		...(data.caption?.trim() ? { caption: data.caption.trim() } : {}),
		// A copy of the list: the store holds this as the block's base, and
		// must not see a live array change underneath it.
		annotations: [...data.annotations],
	};
}

interface PendingUpdate {
	id: string;
	writer: object;
	data: InkFileBlock;
	base: BlockBase;
	waiters: Array<(outcome: WriteOutcome) => void>;
}
```

Add these fields to `InkFileStore`, after `loading`:

```ts
	// Saves queued and not yet started, so a later save from the same block
	// can take the place of an earlier one rather than follow it.
	private readonly pending: PendingUpdate[] = [];
	// The first write after the file is opened is read back and parsed. A file
	// that was already wrong shows it there; after that, a size check is enough.
	private verifyNextWrite = true;
```

Add these public methods after `fileDeleted()`:

```ts
	/**
	 * Saves one block. `writer` is whoever is saving — one block view — and
	 * `base` is the block as that writer last showed it. When the store holds a
	 * different revision by the time the save runs, the three are merged.
	 */
	updateBlock(id: string, writer: object, data: InkFileBlock, base: BlockBase): Promise<WriteOutcome> {
		const queued = this.pending.find((update) => update.id === id && update.writer === writer);
		if (queued) {
			// Collapsed into the later save. Only for the same writer: two blocks
			// showing one drawing are two sets of strokes, and both must land.
			queued.data = data;
			queued.base = base;
			return new Promise((resolve) => queued.waiters.push(resolve));
		}

		const update: PendingUpdate = { id, writer, data, base, waiters: [] };
		this.pending.push(update);
		return this.enqueue(async () => {
			this.pending.splice(this.pending.indexOf(update), 1);
			const outcome = await this.commit(update.id, update.data, update.base, update.writer);
			for (const waiter of update.waiters) waiter(outcome);
			return outcome;
		});
	}

	/** Adds a block the file does not hold yet, creating the file if there is none. */
	createBlock(id: string, data: InkFileBlock): Promise<WriteOutcome> {
		return this.enqueue(() => this.commit(id, data, null, null));
	}
```

Add this private method after `adopt`:

```ts
	private async commit(id: string, data: InkFileBlock, base: BlockBase | null, writer: object | null): Promise<WriteOutcome> {
		const creating = base === null;

		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
			const status = this.current.kind;
			// Only creating a block may create a file. A save that finds no file
			// is a save for a file that went missing, and writing it would put a
			// one-block file over one that was merely misplaced.
			if (status !== 'readable' && !(creating && status === 'absent')) return refused('not-writable');

			// Blocks held from a file that has since gone are not written into a
			// new one as a side effect of inserting a block.
			const from = status === 'absent' ? null : this.contents;
			const current = status === 'absent' ? undefined : this.held.get(id);

			let next = data;
			let merged = false;
			if (base === null) {
				if (current) return refused('block-exists');
			} else {
				if (!current) return refused('block-absent');
				if (current.read.kind !== 'decoded') return refused('block-unreadable');
				if (current.revision !== base.revision) {
					next = toFileBlock(
						mergeInkBlocks(toInkBlockData(base.block), toInkBlockData(data), toInkBlockData(current.read.block)),
					);
					merged = true;
				}
			}

			const raw = await writeInkFileBlock(from?.blocks.get(id), next);

			// Before: the block must decode back to what was encoded. This is
			// what stops an empty or corrupt payload being written over a block
			// whose view holds annotations — and a legitimately empty block
			// still passes, because it decodes to zero of zero.
			const check = await decodeStrokes(raw.strokes, raw.codec);
			if (check.kind !== 'decoded' || check.annotations.length !== next.annotations.length) {
				console.error(`Inkling: block ${id} did not encode faithfully, so ${this.path} was not written.`);
				return refused('encoding-mismatch');
			}

			const blocks = new Map(from?.blocks ?? []);
			blocks.set(id, raw);
			// Before: a serialization holding no blocks never goes over a file
			// that held some. Unreachable from a save, which always adds one; it
			// guards whatever writes through here next.
			if ((from?.blocks.size ?? 0) > 0 && blocks.size === 0) return refused('no-blocks-over-blocks');

			const contents: InkFileContents = { extra: from?.extra ?? [], blocks };
			const text = serializeInkFile(contents);

			let result: ReplaceResult;
			try {
				result = await this.io.replaceIf(this.path, status === 'absent' ? null : this.lastText, text);
			} catch (error) {
				console.error(`Inkling: could not write ${this.path}.`, error);
				return refused('failed');
			}

			if (!result.written) {
				// The file is not what was last seen. A file gone bad refuses
				// outright: there is nothing to merge into, and writing over it
				// is exactly what repair (not a save) is for.
				if (result.found !== null && parseInkFile(result.found).kind === 'damaged') return refused('not-writable');
				await this.adopt(result.found, null);
				continue;
			}

			// After: a write cut short leaves a shorter file. lastText is left as
			// it was, so the next save finds the file changed, reads what was
			// left, and refuses rather than writing on the strength of it.
			let size: number | null = null;
			try {
				size = await this.io.size(this.path);
			} catch {
				size = null;
			}
			if (size !== null && size !== byteLength(text)) {
				console.error(`Inkling: ${this.path} is ${size} bytes after writing ${byteLength(text)}; the write did not complete.`);
				return refused('failed');
			}

			if (this.verifyNextWrite) {
				let reread: string | null = null;
				try {
					reread = await this.io.read(this.path);
				} catch {
					reread = null;
				}
				const read = reread === null ? null : parseInkFile(reread);
				if (read?.kind !== 'readable' || JSON.stringify(read.contents.blocks.get(id)) !== JSON.stringify(raw)) {
					console.error(`Inkling: ${this.path} did not read back as written.`);
					return refused('failed');
				}
				this.verifyNextWrite = false;
			}

			if (status === 'absent') this.held.clear();
			this.contents = contents;
			this.lastText = text;
			const revision = ++this.revisions;
			this.held.set(id, { read: { kind: 'decoded', block: next }, json: JSON.stringify(raw), revision });
			this.current = { kind: 'readable' };
			this.notify(status === 'readable' ? new Set([id]) : 'all', writer);
			return { kind: 'written', block: next, revision, merged };
		}

		return refused('moved-on');
	}
```

- [ ] **Step 4: Run the store tests**

Run: `npx vitest run tests/markdown/inkFileStore.test.ts tests/markdown/inkFileStoreWrites.test.ts`
Expected: PASS.

- [ ] **Step 5: Build, lint, test, commit**

Run: `npm run build && npm run lint && npm test`

```bash
git add src/markdown/inkFileStore.ts tests/markdown/inkFileStoreWrites.test.ts
git commit -m "Write a block to its ink file, one save at a time" -m "Saves to one ink file run one after another, and a save superseded by the same block before it ran is folded into the later one. A save writes only over the text the store last saw, in the same operation as the check; when the file changed elsewhere it reads what is there and merges by annotation, against the revision the block last showed.

A save never creates a file, never writes a file from the future or one it cannot read, and never writes a block that does not decode back to what was encoded. The first write after opening is read back; every write is checked for size in bytes. Blocks and keys this build cannot read survive every save.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 6: Move the in-note save path behind a storage interface

A refactor with no change in behaviour. **The existing ink block tests are the specification for this task and none of them may be edited.** If one fails, the refactor is wrong.

**Files:**
- Create: `src/markdown/inkBlockStorage.ts`
- Create: `src/markdown/inNoteStorage.ts`
- Modify: `src/markdown/inkBlock.ts`

**Interfaces:**
- Consumes: everything `inkBlock.ts` uses today.
- Produces:
  - `interface BlockRefusal { message: string; recoverable?: { kept: number; dropped: number } }`
  - `type StorageWriteResult = { kind: 'saved' } | { kind: 'retry'; afterMs: number } | { kind: 'held' }`
  - `interface StorageHost { show(data: InkBlockData): boolean; refuse(refusal: BlockRefusal): void; lift(): void; isRefused(): boolean; hasUnsavedWork(): boolean; isDetached(): boolean; scheduleWrite(): void }`
  - `interface InkBlockStorage { readonly rescuePath: string; readonly blockId: string; rescueSource(): string; open(host: StorageHost): void; write(data: InkBlockData): Promise<StorageWriteResult>; close(): void }`
  - `class InNoteStorage implements InkBlockStorage { constructor(plugin: Plugin, ctx: MarkdownPostProcessorContext, containerEl: HTMLElement, source: string) }`
  - `InkBlockView` constructor becomes `(plugin, ctx, containerEl, storage: InkBlockStorage, toolState, captionsEnabled)` and the class `implements StorageHost`.

- [ ] **Step 1: Confirm the baseline**

Run: `npx vitest run tests/markdown`
Expected: PASS. Note the test count; it must be identical at Step 6.

- [ ] **Step 2: Write the interface**

Create `src/markdown/inkBlockStorage.ts`:

```ts
import type { InkBlockData } from './inkBlockFormat';

// What a block view needs from wherever its strokes are kept.
//
// A block's strokes used to live only inside its own fence, and the view held
// the whole of that save path: finding the fence, merging into it, choosing
// between the editor and the file, putting the scroll back. Ink kept in a
// file of its own needs none of that and some things of its own, so the view
// keeps what is common — mounting, the tool strip, the caption, the resize
// handle, the debounce and the rescue store — and asks one of these for the
// rest.

// Something that stops a block being saved, and what to tell the reader.
export interface BlockRefusal {
	message: string;
	// Offered only for an in-note block that partly parsed: what survived is
	// real, and the reader may choose to keep it.
	recoverable?: { kept: number; dropped: number };
}

export type StorageWriteResult =
	| { kind: 'saved' }
	// Not saved, for a reason that usually passes. The view holds the drawing
	// and tries again after this long.
	| { kind: 'retry'; afterMs: number }
	// Not saved. The storage has said whatever needed saying; the view keeps
	// the drawing somewhere that survives a quit.
	| { kind: 'held' };

// The view, as a storage sees it.
export interface StorageHost {
	/**
	 * Shows `data`. The first call is the block's initial load and always
	 * succeeds; a refusal the block starts with must be given before it. A
	 * later call replaces what is on screen only when nothing unsaved is on it,
	 * and says whether it did.
	 */
	show(data: InkBlockData): boolean;
	/** Stops the block being saved, replacing any refusal already shown. */
	refuse(refusal: BlockRefusal): void;
	lift(): void;
	isRefused(): boolean;
	hasUnsavedWork(): boolean;
	isDetached(): boolean;
	scheduleWrite(): void;
}

export interface InkBlockStorage {
	/** The rescue store's key for this block: a path, and the block's id. */
	readonly rescuePath: string;
	readonly blockId: string;
	/** What a held drawing must match to be adopted: the block as stored now. */
	rescueSource(): string;
	/** Called once, when the view is ready to be shown something. */
	open(host: StorageHost): void;
	/** Never throws. */
	write(data: InkBlockData): Promise<StorageWriteResult>;
	close(): void;
}
```

- [ ] **Step 3: Move the in-note path**

Create `src/markdown/inNoteStorage.ts`. Every comment below is moved from `inkBlock.ts` with its method; only the plumbing changes, and it is listed after the code.

```ts
import { MarkdownPostProcessorContext, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { findScrollParent } from '../annotate';
import { createId } from '../annotate/id';
import {
	INK_BLOCK_VERSION,
	findInkBlockById,
	findUniqueInkBlockByBody,
	parseInkBlock,
	serializeInkBlock,
	type InkBlockData,
	type InkBlockDamage,
} from './inkBlockFormat';
import type { BlockRefusal, InkBlockStorage, StorageHost, StorageWriteResult } from './inkBlockStorage';
import { mergeInkBlocks } from './mergeInkBlocks';

// A block whose strokes live in its own fence, as every block did before ink
// files: saving rewrites the fence, through the editor when the note is open
// and through the file when it is not.

// How long to wait before trying again when the block cannot be found
// in its own note, and how many times. A note being actively edited can
// briefly not contain the fence a save is looking for — the user is
// midway through cutting and pasting a section, say. Retrying rather
// than giving up is what stops a transient state from needing a
// re-render to recover from.
const LOCATE_RETRY_MS = 1200;
const LOCATE_RETRIES = 4;

// How long to keep restoring the note's scroll position after a save. See
// keepScrollPosition — the scroll that has to be undone happens *after* the
// edit that caused it, and in reading view after the re-render later still,
// so one synchronous reset is not enough. Short enough that a deliberate
// scroll begun in the same breath as a pen-lift is at worst briefly
// interrupted.
const SCROLL_RESTORE_MS = 120;
```

Then, in this order, move from `src/markdown/inkBlock.ts` into this file, **verbatim including their comments**:

1. `function damageMessage(damage: InkBlockDamage): string` (inkBlock.ts lines 185–200).

and add after it:

```ts
function refusalFor(damage: InkBlockDamage): BlockRefusal {
	// Only a partly-read block is offered a way out, and the reason is the
	// whole shape of this feature. Nothing survived an unreadable one, so
	// there is nothing to keep. A block from a newer version did not fail
	// to parse so much as fail to be understood — what this build dropped
	// is most likely what that version added, so "keep what survived"
	// there means "throw away the part written by the newer plugin".
	if (damage.kind === 'partial') {
		return { message: damageMessage(damage), recoverable: { kept: damage.kept, dropped: damage.dropped } };
	}
	return { message: damageMessage(damage) };
}

export class InNoteStorage implements InkBlockStorage {
	readonly rescuePath: string;
	readonly blockId: string;
	// The exact text this block rendered from — what a save checks before
	// overwriting a fence. See locate/findUniqueInkBlockByBody for why "it's
	// an ink block" was not enough.
	private renderedSource: string;
	private readonly initial: InkBlockData;
	private readonly damage: InkBlockDamage;
	private host: StorageHost | null = null;
	// One report per view, not one per save: a mismatch repeats on every
	// debounce tick for as long as the note is open.
	private reportedMismatch = false;
	// Consecutive failures to find this block in its own note. Reset on
	// every successful save.
	private locateFailures = 0;
	// Said once per view, like the locate-failure notice: a refusal repeats
	// on every retry, and a notice per attempt is noise about one problem.
	private reportedStaleWrite = false;
	private disposeRepairWatch: (() => void) | null = null;

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		source: string,
	) {
		const { data, damage } = parseInkBlock(source);
		// A block written before ids existed picks one up the first time it
		// saves; until then it is located by its exact source text instead.
		this.blockId = data.id ?? createId();
		this.renderedSource = source.trim();
		this.initial = { ...data, id: this.blockId };
		this.damage = damage;
		this.rescuePath = ctx.sourcePath;
	}

	rescueSource(): string {
		return this.renderedSource;
	}

	open(host: StorageHost): void {
		this.host = host;
		if (this.damage.kind !== 'none') {
			// Deliberately never saves over it: a block this build can't fully
			// read is far more likely to be from a newer version of the
			// plugin, or damaged in a way the original could still recover,
			// than something worth replacing with what little parsed.
			host.refuse(refusalFor(this.damage));
			this.watchForRepair();
		}
		host.show(this.initial);
	}

	close(): void {
		this.disposeRepairWatch?.();
		this.disposeRepairWatch = null;
	}
```

2. `watchForRepair` (lines 583–599), unchanged except `private`.
3. `recheckDamage` (lines 601–647), with its body from `if (this.detached) return;` onwards replaced by:

```ts
	private async recheckDamage(): Promise<void> {
		const host = this.host;
		if (!host || host.isDetached()) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		let contents: string;
		try {
			contents = await this.plugin.app.vault.cachedRead(file);
		} catch {
			return;
		}
		// Reading the file is asynchronous, so the block can have been
		// detached while it was in flight.
		if (host.isDetached()) return;

		const lines = contents.split('\n');
		// A block whose id was inside the JSON that failed to parse cannot be
		// located at all, and there is no honest way to guess which fence
		// became which — guessing at one is how a drawing once reached another
		// block. Its banner waits for the note to re-render, as it always did.
		const range = this.locate(lines);
		if (!range) return;

		const body = lines.slice(range.lineStart + 1, range.lineEnd).join('\n');
		const { data, damage } = parseInkBlock(body);

		if (damage.kind !== 'none') {
			// Damaged now, and the refusal has to come back. Nothing is
			// re-seeded: what is on screen is what the user drew, and
			// replacing it with the partial parse of a file we have just
			// refused to write would take strokes off the screen on the
			// strength of a version we do not trust.
			if (host.isRefused()) return;
			host.refuse(refusalFor(damage));
			return;
		}

		if (!host.isRefused()) return;
		host.lift();
		this.renderedSource = body.trim();
		host.show({ ...data, id: this.blockId });
	}
```

4. `keepScrollPosition` (lines 991–1020), unchanged.
5. The write path, replacing `write()` (lines 1022–1132):

```ts
	async write(data: InkBlockData): Promise<StorageWriteResult> {
		const restoreScroll = this.keepScrollPosition();

		const editor = this.findOpenEditor();
		if (editor) {
			// Through the editor, not the file, whenever the note is open:
			// this lands as an ordinary edit in the same document the user is
			// working in — one undo step, no external-modification reload,
			// and no fight with unsaved changes the editor hasn’t flushed to
			// disk yet.
			// One call, not one per line. Reading the document a line at a
			// time costs a tree lookup and a string slice apiece, which was
			// tolerable at 409 lines and is not at 7,788 — the count on the
			// largest note in the vault once stored JSON began wrapping. This
			// runs on the main thread while the pen is still moving.
			const lines = editor.getValue().split('\n');

			const range = this.locate(lines);
			if (!range) return this.locateFailed();

			const serialized = this.bodyToWrite(lines, range, data);
			if (serialized === null) return this.refuseStaleWrite();

			editor.replaceRange(`${serialized}\n`, { line: range.lineStart + 1, ch: 0 }, { line: range.lineEnd, ch: 0 });
			this.renderedSource = serialized;
			this.locateFailures = 0;
			restoreScroll();
			return { kind: 'saved' };
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		// No editor and no file: there is nowhere left to write, so the only
		// copy of this drawing is the one being held.
		if (!(file instanceof TFile)) return { kind: 'held' };

		try {
			let wrote = false;
			let refused = false;
			let written = '';
			await this.plugin.app.vault.process(file, (contents) => {
				const lines = contents.split('\n');
				const range = this.locate(lines);
				if (!range) return contents;
				const body = this.bodyToWrite(lines, range, data);
				if (body === null) {
					refused = true;
					return contents;
				}
				written = body;
				lines.splice(range.lineStart + 1, range.lineEnd - range.lineStart - 1, body);
				wrote = true;
				return lines.join('\n');
			});
			if (refused) return this.refuseStaleWrite();
			if (!wrote) return this.locateFailed();
			this.renderedSource = written;
			this.locateFailures = 0;
			restoreScroll();
			return { kind: 'saved' };
		} catch (error) {
			console.error('Inkling: failed to save an ink block.', error);
			new Notice('Inkling: could not save this ink block. Your drawing is still on screen and will be saved again shortly.');
			return { kind: 'held' };
		}
	}
```

6. `bodyToWrite` (lines 1173–1200) with the signature `private bodyToWrite(lines: readonly string[], range: { lineStart: number; lineEnd: number }, data: InkBlockData): string | null` and `this.data` replaced by `data` in its two uses. Move the long comment above `locate` (lines 1147–1172) with it, where it currently sits.
7. `refuseStaleWrite` (lines 1202–1215) returning `StorageWriteResult`: delete its `unsavedInk.persist(...)` line (the view persists on `held`) and end both paths with `return { kind: 'held' };`.
8. `locate` (lines 1217–1222), unchanged.
9. `handleLocateFailure` (lines 1224–1241) renamed and reshaped, keeping its comment:

```ts
	// The block is not where it should be. The drawing is already held (see
	// the view's write), so nothing is lost either way — but a retry usually
	// resolves it without the user ever knowing, and only a run of failures
	// is worth telling them about.
	private locateFailed(): StorageWriteResult {
		this.locateFailures += 1;
		if (this.locateFailures <= LOCATE_RETRIES) return { kind: 'retry', afterMs: LOCATE_RETRY_MS };
		this.reportMismatch();
		return { kind: 'held' };
	}
```

10. `reportMismatch` (lines 1243–1255) and `findOpenEditor` (lines 1257–1287), unchanged. Close the class.

`INK_BLOCK_VERSION` is imported for `damageMessage`.

- [ ] **Step 4: Reshape `InkBlockView`**

In `src/markdown/inkBlock.ts`:

**Imports.** Replace the `obsidian` import with `import { MarkdownPostProcessorContext, MarkdownRenderChild, Plugin, setIcon, setTooltip } from 'obsidian';`. Replace the `./inkBlockFormat` import with `import { INK_BLOCK_LANGUAGE, InkBlockData, emptyInkBlock, inkBlockMarkdown } from './inkBlockFormat';`. Delete the `./mergeInkBlocks` import. Add:

```ts
import { InNoteStorage } from './inNoteStorage';
import type { BlockRefusal, InkBlockStorage, StorageHost, StorageWriteResult } from './inkBlockStorage';
```

**Delete** from module scope: `LOCATE_RETRY_MS`, `LOCATE_RETRIES`, `SCROLL_RESTORE_MS` with their comments, and `damageMessage`.

**Fields.** Change the class line to `class InkBlockView implements StorageHost {`. Delete the fields `readOnly`, `renderedSource`, `reportedMismatch`, `locateFailures`, `damage`, `disposeRepairWatch`, `reportedStaleWrite` with their comments. Keep `blockId` as `private readonly blockId: string;` with the comment reduced to `// This block's own identity, as its storage names it.` Add:

```ts
	// Whether the storage has shown this block anything yet. Nothing is drawn,
	// seeded or saved before it has: a block that waits on a file must not
	// accept ink it has nowhere to put, nor seed an empty store over it.
	private loaded = false;
	// Why this block may not be saved, if it may not. Can change underneath a
	// rendered block — a sync conflict resolves, or a file comes back.
	private refusal: BlockRefusal | null = null;
	// A save in flight. Counts as unsaved work: what is on screen may be newer
	// than what the storage holds until it lands.
	private writing = false;
```

**Constructor.** New signature:

```ts
	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		private readonly storage: InkBlockStorage,
		toolState: ToolState,
		private readonly captionsEnabled: () => boolean,
	) {
```

Replace the constructor's body up to and including `this.retained = retainedHistoryFor(...)` with:

```ts
		this.blockId = storage.blockId;
		// Until the storage shows something. Its size is what the block holds
		// space with, so a block waiting on a file reserves the default.
		this.data = { ...emptyInkBlock(), id: this.blockId };

		// The same key the recovery map uses, and for the same reason: it is
		// the one name for this block that survives its own save.
		this.stripKey = recoveryKey(ctx.sourcePath, this.blockId);

		this.retained = retainedHistoryFor(recoveryKey(ctx.sourcePath, this.blockId));
```

Keep the controller construction, `setCanManagePages`, `suggestTool`, the toolbar host, surface and content creation and the aspect-ratio line unchanged. Then replace everything from `this.contentEl = content;` to the end of the constructor with:

```ts
		this.contentEl = content;

		// Blocks open closed to editing, and the toggle below is what opens
		// them. A note is read far more often than it is drawn in, and a
		// surface that takes ink the moment anything touches it is a surface
		// that collects stray marks from a stylus resting on the way past —
		// on the one screen, a tablet, where the pen is also how you scroll.
		//
		// This is separate from a refusal, which means the block must *never*
		// be written. That one is permanent and the toggle cannot lift it;
		// this one is the user's to change whenever they like.
		this.controller.setReadOnly(true);

		this.buildToolbarToggle();
		// Built for every block and shown only while the block is open and may
		// be saved: a handle that appears to resize a block and then silently
		// forgets would be worse than not having one.
		this.buildResizeHandle();

		// After everything the storage may call back into exists. An in-note
		// block answers synchronously, so its banner and caption land now, in
		// the same order in the DOM as they always did.
		storage.open(this);

		// Last: a block rebuilt by its own save mounts synchronously, and
		// mounting seeds the surface from what the storage just showed.
		this.watchVisibility();
	}
```

**New host methods.** Add after the constructor:

```ts
	show(data: InkBlockData): boolean {
		if (this.detached) return false;

		if (!this.loaded) {
			this.loaded = true;
			// Ink from a save that failed before this block was re-rendered is
			// strictly newer than what the storage holds — that is what the
			// failed save was trying to update. Adopting it here, and saving
			// again below, is what turns a failed save into a delayed one
			// rather than into lost work.
			//
			// Declined unless it matches the block as stored now: across a quit,
			// sync can have brought back a newer version of this block from
			// another device, and putting a held drawing over that would
			// overwrite work rather than rescue it.
			const rescued = unsavedInk.get(this.storage.rescuePath, this.blockId, this.storage.rescueSource());
			this.data = rescued ? { ...rescued, id: this.blockId } : { ...data, id: this.blockId };
			this.applyAspect();
			// After any refusal the block starts with, which decides whether a
			// caption may be written: a block that must never be saved over must
			// not offer a field whose only purpose is to save something over it.
			this.buildCaption();
			this.applyEditability();
			if (this.mounted && !this.seeded) this.seed();
			// So the rescued ink is on screen before the save that persists it
			// is attempted.
			if (rescued && this.writable()) this.scheduleWrite();
			return true;
		}

		// Never over unsaved work. The storage merges it at the next save
		// instead, which keeps both.
		if (this.hasUnsavedWork()) return false;
		this.data = { ...data, id: this.blockId };
		this.applyAspect();
		// Only if the store has already been given this block's annotations;
		// otherwise the next mount seeds from the data set just above, which
		// is the same answer one step later.
		if (this.seeded) this.controller.seedPage(BLOCK_PAGE, this.toSurface(this.data.annotations));
		return true;
	}

	refuse(refusal: BlockRefusal): void {
		this.refusal = refusal;
		this.bannerEl?.remove();
		this.buildBanner(refusal);
		// Told directly, not left to the toggle. The controller learns its
		// read-only state inside setOpen, so a block whose tool strip is
		// already open would keep taking ink until the next time someone
		// closed and reopened it — which is the whole window this refusal
		// exists to close.
		this.applyEditability();
	}

	lift(): void {
		this.refusal = null;
		this.bannerEl?.remove();
		this.bannerEl = null;
		// The mirror of refuse, and the reason that one is not enough on its
		// own: a repaired block whose strip was already open looked editable
		// and silently refused every stroke, because the controller was never
		// told the refusal had been lifted.
		this.applyEditability();
	}

	isRefused(): boolean {
		return this.refusal !== null;
	}

	hasUnsavedWork(): boolean {
		return this.writeHandle !== null || this.writing || this.controller.isGestureActive();
	}

	isDetached(): boolean {
		return this.detached;
	}

	private writable(): boolean {
		return this.loaded && this.refusal === null;
	}

	private applyEditability(): void {
		const open = this.disposeToolbar !== null;
		this.controller.setReadOnly(!open || !this.writable());
		this.setResizeHandleVisible(open && this.writable());
	}

	private applyAspect(): void {
		this.surfaceEl.setCssProps({ '--inkling-block-aspect': `${this.data.width} / ${this.data.height}` });
	}

	private seed(): void {
		this.seeded = true;
		this.controller.seedPage(BLOCK_PAGE, this.toSurface(this.data.annotations));
	}
```

**`buildCaption`.** Change its first condition to `if (!this.captionsEnabled() || !this.writable()) {`. In both branches, after the element is created, move it above the resize handle so it keeps its place under the banner:

```ts
			const caption = this.containerEl.createDiv({ cls: 'inkling-ink-block-caption', text });
			if (this.resizeHandleEl) this.containerEl.insertBefore(caption, this.resizeHandleEl);
			return;
```

and, for the input, `if (this.resizeHandleEl) this.containerEl.insertBefore(input, this.resizeHandleEl);` directly after `const input = ...`.

**`buildBanner`.** Change the signature to `private buildBanner(refusal: BlockRefusal): void`. After `this.bannerEl = banner;` add `this.surfaceEl.insertAdjacentElement('afterend', banner);`. Use `refusal.message` for the text. Replace the partial check and its comment (that comment moved to `refusalFor`) with:

```ts
		if (!refusal.recoverable) return;
		this.buildRecoveryAction(banner, refusal.recoverable.kept, refusal.recoverable.dropped);
```

**`recoverWhatSurvived`.** Body becomes `this.lift(); void this.write();`.

**Delete** `watchForRepair`, `recheckDamage`, `isDamaged`, `applyDamage`, `clearDamage`, `keepScrollPosition`, `bodyToWrite`, `refuseStaleWrite`, `locate`, `handleLocateFailure`, `reportMismatch`, `findOpenEditor`, and the orphaned comment blocks above `bodyToWrite` and `locate` (now in `inNoteStorage.ts`).

**`buildToolbarToggle`.** In `setOpen`, replace `this.controller.setReadOnly(!open || this.readOnly);` with `this.applyEditability();` keeping the comment above it (change "A block we could not fully read" to "A block that may not be saved"), and delete the `this.setResizeHandleVisible(open);` line.

**`applyHeight`.** Replace its aspect `setCssProps` line with `this.applyAspect();`.

**`buildResizeHandle`.** Replace `this.setResizeHandleVisible(this.disposeToolbar !== null);` with `this.setResizeHandleVisible(this.disposeToolbar !== null && this.writable());`.

**`mountSurface`.** Replace the `if (!this.seeded) { ... } else if` head with:

```ts
		if (!this.seeded) {
			// Only ever on the first mount, and only once the storage has shown
			// this block something. mountPage repaints from the store, which is
			// the live truth once anything has been drawn, so reseeding on a
			// remount would put the stored version back and throw away every
			// stroke made since.
			if (this.loaded) this.seed();
		} else if (Math.abs(previous - this.scale) > 0.001) {
```

**`scheduleWrite`.** Make it public, and change the guard to `if (this.detached || !this.writable()) return;`.

**`write`.** Replace the whole method with:

```ts
	private async write(): Promise<void> {
		this.writeHandle = null;
		if (this.detached || !this.writable()) return;

		// Saving can re-render this block; doing that mid-stroke would destroy
		// the surface the stroke is being drawn on. Gestures are short, so
		// waiting one out costs nothing.
		if (this.controller.isGestureActive()) {
			this.writeHandle = window.setTimeout(() => void this.write(), GESTURE_RETRY_MS);
			return;
		}

		// The store is only the truth once it has been seeded. A block that
		// has never been mounted — one recovering unsaved ink while still
		// scrolled off screen, most importantly — has an *empty* store, and
		// writing that would erase the drawing this save exists to protect.
		if (this.seeded) {
			this.data = { ...this.data, annotations: this.toStored(this.controller.getPageAnnotations(BLOCK_PAGE)) };
		}
		// Held from here on, not only on failure. Every path a storage takes can
		// end without writing, and each of those used to leave the drawing on
		// screen and nothing stored, which the next re-render then discarded.
		// Holding first and forgetting on success means the only way to lose
		// ink is to lose the session.
		unsavedInk.hold(this.storage.rescuePath, this.blockId, this.data, this.storage.rescueSource());

		// The storage call starts synchronously, before the first await, so a
		// block flushing its save as it is torn down still gets it started.
		this.writing = true;
		let result: StorageWriteResult;
		try {
			result = await this.storage.write(this.data);
		} finally {
			this.writing = false;
		}

		switch (result.kind) {
			case 'saved':
				unsavedInk.forget(this.storage.rescuePath, this.blockId);
				return;
			case 'retry':
				// Written out before the retry rather than after the last one.
				// Retries usually resolve within a few seconds, but those are
				// seconds in which the only copy is in memory, and a crash is
				// exactly the event this exists for.
				unsavedInk.persist(this.storage.rescuePath, this.blockId);
				if (this.writeHandle !== null) window.clearTimeout(this.writeHandle);
				this.writeHandle = window.setTimeout(() => void this.write(), result.afterMs);
				return;
			case 'held':
				unsavedInk.persist(this.storage.rescuePath, this.blockId);
				return;
		}
	}
```

**`detach`.** Replace `this.disposeRepairWatch?.(); this.disposeRepairWatch = null;` with `this.storage.close();`.

**`registerInkBlock`.** Replace the processor body with:

```ts
	plugin.registerMarkdownCodeBlockProcessor(INK_BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(
			new InkBlockChild(el, () => {
				const storage = new InNoteStorage(plugin, ctx, el, source);
				return new InkBlockView(plugin, ctx, el, storage, toolState, captionsEnabled);
			}),
		);
	});
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors. An error naming a deleted field (`readOnly`, `damage`, `renderedSource`) is a use this list missed; replace it with `!this.writable()`, `this.refusal`, or `this.storage.rescueSource()` respectively.

- [ ] **Step 6: Run the ink block tests**

Run: `npx vitest run tests/markdown`
Expected: PASS, with the same test count as Step 1.

- [ ] **Step 7: Build, lint, test, commit**

Run: `npm run build && npm run lint && npm test`

```bash
git add src/markdown/inkBlock.ts src/markdown/inkBlockStorage.ts src/markdown/inNoteStorage.ts
git commit -m "Move an ink block's save path out of its view" -m "InkBlockView owned everything about saving a block into its own fence: finding it, merging into it, choosing between the editor and the file, putting the scroll back, and watching for repair. That now lives in InNoteStorage behind an InkBlockStorage interface, and the view keeps what any block needs whatever holds its strokes: mounting, the tool strip, the caption, the resize handle, the debounce, and the rescue store.

The view now waits to be shown something before it seeds, draws or saves, which an in-note block does at once. No behaviour changes; the existing ink block tests are unchanged and pass.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 7: Blocks whose ink lives in a file

**Files:**
- Create: `src/markdown/inkFileStorage.ts`
- Create: `src/markdown/inkFileVaultIO.ts`
- Modify: `src/markdown/inkFileStore.ts` (add `InkFileStores.whenIdle`)
- Modify: `src/markdown/inkBlockStorage.ts` (add `afterWrite`)
- Modify: `src/markdown/inkBlock.ts` (dispatch, vault events, return value, `afterWrite` call)
- Modify: `src/markdown/compactInkBlocks.ts`
- Modify: `tests/harness/note.ts`
- Test: `tests/markdown/inkFileBlockIntegration.test.ts`, `tests/markdown/compactInkBlocks.test.ts`

**Interfaces:**
- Consumes: `InkFileStores`, `toFileBlock`, `toInkBlockData`, `BlockBase`, `WriteRefusal` (Tasks 4–5); `isInkFileFence`, `parseInkFence`, `InkFenceRead`, `InkFenceDamage` (Task 3); `InkBlockStorage`, `StorageHost` (Task 6).
- Produces:
  - `InkBlockStorage.afterWrite?(): void`, called by the view once a write has settled and the view is no longer writing.
  - `InkBlockStorage.heldWhileRefused?(): void`, called by the view when it held a drawing because the block was refused after being drawn in.
  - `InkBlockView.write()` holds and persists, rather than drops, a scheduled save that finds the block refused.
  - `class InkFileStorage implements InkBlockStorage { constructor(stores: InkFileStores, fence: InkFenceRead) }`
  - `vaultInkFileIO(vault: Vault): InkFileIO`
  - `InkFileStores.whenIdle(): Promise<void>`
  - `registerInkBlock(...)` returns `interface InkBlockRegistration { whenIdle(): Promise<void> }`
  - Harness: `MountNoteOptions.inkFiles?: Record<string, string>`; `TestNote.settle()`, `inkFile(path)`, `setInkFile(path, text)`, `syncInkFile(path, text)`, `deleteInkFile(path)`, `inkStrokeCount(path, id)`.

- [ ] **Step 1: Let the harness hold ink files**

In `tests/harness/note.ts`:

Add imports:

```ts
import { parseInkFile, readInkFileBlock } from '../../src/markdown/inkFile';
```

Add to `TestNote`:

```ts
	/** Let every ink file store finish what it has queued, and the promises after it. */
	settle(): Promise<void>;
	/** An ink file's text, or undefined when there is none. */
	inkFile(path: string): string | undefined;
	/** Change an ink file behind the plugin's back. */
	setInkFile(path: string, text: string): void;
	/** Change an ink file and announce it, as a sync landing would. */
	syncInkFile(path: string, text: string): Promise<void>;
	/** Delete an ink file and announce it. */
	deleteInkFile(path: string): Promise<void>;
	/** Stroke annotations in one block of an ink file, or -1 when it cannot be read. */
	inkStrokeCount(path: string, id: string): Promise<number>;
```

Add to `MountNoteOptions`:

```ts
	/** Ink files in the vault beside the note, by path. */
	inkFiles?: Record<string, string>;
```

In `mountNote`, after `const file = new TFile(path);`:

```ts
	const inkFiles = new Map(Object.entries(options.inkFiles ?? {}));
```

Replace the `vault` object with:

```ts
	const fire = (event: string, target: TFile): void => {
		for (const listener of [...listeners]) {
			if (listener.event === event) listener.cb(target);
		}
	};

	const vault = {
		getAbstractFileByPath: (wanted: string) => (wanted === path ? file : null),
		getFileByPath: (wanted: string) => (wanted === path ? file : inkFiles.has(wanted) ? new TFile(wanted) : null),
		// Every folder exists. Nothing under test depends on creating one.
		getFolderByPath: (wanted: string) => ({ path: wanted }),
		createFolder: async () => undefined,
		read: async (target: TFile) => {
			if (target.path === path) return contents;
			const text = inkFiles.get(target.path);
			if (text === undefined) throw new Error(`no such file: ${target.path}`);
			return text;
		},
		create: async (target: string, data: string) => {
			if (target === path || inkFiles.has(target)) throw new Error(`file already exists: ${target}`);
			inkFiles.set(target, data);
			const created = new TFile(target);
			fire('create', created);
			return created;
		},
		process: async (target: TFile, fn: (data: string) => string) => {
			if (target.path === path) {
				contents = fn(contents);
				return contents;
			}
			const current = inkFiles.get(target.path);
			if (current === undefined) throw new Error(`no such file: ${target.path}`);
			const next = fn(current);
			if (next !== current) {
				inkFiles.set(target.path, next);
				// Obsidian reports the plugin's own writes back to it, and the
				// store has to cope with hearing about them. The note's own
				// writes are not reported, as before this harness held ink files.
				fire('modify', target);
			}
			return next;
		},
		cachedRead: async (target: TFile) => {
			if (target.path !== path) throw new Error(`no such file: ${target.path}`);
			return contents;
		},
		adapter: {
			stat: async (wanted: string) => {
				const text = wanted === path ? contents : inkFiles.get(wanted);
				return text === undefined ? null : { type: 'file', ctime: 0, mtime: 0, size: new TextEncoder().encode(text).length };
			},
		},
		on: (event: string, cb: (file: TFile) => void): VaultListener => {
			const ref = { event, cb };
			listeners.push(ref);
			return ref;
		},
		offref: (ref: VaultListener) => {
			const at = listeners.indexOf(ref);
			if (at >= 0) listeners.splice(at, 1);
		},
	};
```

Move the `listeners` declaration (and its `VaultListener` type and comment) above `fire`.

In `plugin`, add `registerEvent: () => undefined,`.

Replace the `registerInkBlock(...)` call with:

```ts
	const registration = registerInkBlock(plugin as unknown as Plugin, toolState, () => options.blockCaptions ?? false);
```

Add, before the `return {`:

```ts
	// Ink file work runs on real streams (deflate is not a timer), so it is
	// awaited rather than advanced past, a few rounds deep because a store
	// settling can start a block saving.
	const settle = async (): Promise<void> => {
		for (let round = 0; round < 5; round++) {
			await registration.whenIdle();
			await vi.advanceTimersByTimeAsync(0);
		}
	};
```

In the returned object, change `flushWrites` to:

```ts
		flushWrites: async () => {
			await vi.advanceTimersByTimeAsync(WRITE_SETTLE_MS);
			await settle();
		},
```

change `sync` to fire through `fire('modify', file)` in place of its loop, and add:

```ts
		settle,
		inkFile: (inkPath) => inkFiles.get(inkPath),
		setInkFile: (inkPath, text) => {
			inkFiles.set(inkPath, text);
		},
		syncInkFile: async (inkPath, text) => {
			const existed = inkFiles.has(inkPath);
			inkFiles.set(inkPath, text);
			fire(existed ? 'modify' : 'create', new TFile(inkPath));
			await settle();
		},
		deleteInkFile: async (inkPath) => {
			inkFiles.delete(inkPath);
			fire('delete', new TFile(inkPath));
			await settle();
		},
		inkStrokeCount: async (inkPath, id) => {
			const read = parseInkFile(inkFiles.get(inkPath) ?? '');
			if (read.kind !== 'readable') return -1;
			const block = await readInkFileBlock(read.contents.blocks.get(id));
			return block.kind === 'decoded' ? block.block.annotations.filter((a) => a.kind === 'stroke').length : -1;
		},
```

Do not run the suite yet: `registerInkBlock` returns nothing until Step 7, so every harness test fails at `settle()` until then.

- [ ] **Step 2: Write the failing integration tests**

Create `tests/markdown/inkFileBlockIntegration.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { emptyFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { inkFenceMarkdown } from '../../src/markdown/inkFence';
import { emptyInkBlock, inkBlockMarkdown } from '../../src/markdown/inkBlockFormat';
import { inkFileText } from '../harness/inkFileIO';
import { mountNote, type TestNote } from '../harness/note';

// A block whose strokes live in an ink file, from pen to disk. The note is
// the thing that must not change; the file is where the work has to land.

const INK = 'Ink/Physics.ink';
const STROKE: Array<[number, number]> = [
	[100, 100],
	[150, 120],
	[200, 100],
];

let note: TestNote;

beforeEach(() => {
	document.body.innerHTML = '';
	window.localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 30, y: 40 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

function fence(id: string, file = INK): string {
	return inkFenceMarkdown({ file, id, extra: [] });
}

function noteText(...blocks: string[]): string {
	return ['# Physics', '', ...blocks.flatMap((block) => [block, '', 'Prose between.', ''])].join('\n');
}

async function open(contents: string, inkFiles: Record<string, string>): Promise<TestNote> {
	const mounted = mountNote({ path: 'Physics.md', contents, inkFiles, openInEditor: true });
	await mounted.settle();
	return mounted;
}

function banner(index = 0): string | null {
	return note.block(index).el.querySelector('.inkling-ink-block-banner-text')?.textContent ?? null;
}

describe('a block whose ink is in a file', () => {
	beforeEach(async () => {
		note = await open(noteText(fence('a')), { [INK]: await inkFileText({ a: holding() }) });
	});

	it('writes a stroke to the ink file', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, 'a')).toBe(1);
	});

	it('leaves the note exactly as it was', async () => {
		const before = note.contents();
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.contents()).toBe(before);
	});

	it('shows no banner', () => {
		expect(banner()).toBeNull();
	});
});

describe('an in-note block and an ink-file block in one note', () => {
	beforeEach(async () => {
		note = await open(noteText(inkBlockMarkdown({ ...emptyInkBlock(), id: 'old' }), fence('new')), {
			[INK]: await inkFileText({ new: holding() }),
		});
	});

	it('saves each where it lives', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		note.block(1).openForEditing();
		note.block(1).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(1);
		expect(await note.inkStrokeCount(INK, 'new')).toBe(1);
	});
});

describe('a fence copied so two blocks show one drawing', () => {
	beforeEach(async () => {
		note = await open(noteText(fence('shared'), fence('shared')), { [INK]: await inkFileText({ shared: holding() }) });
	});

	it('keeps what was drawn in both', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		note.block(1).openForEditing();
		note.block(1).drawStroke([
			[300, 300],
			[320, 330],
		]);
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, 'shared')).toBe(2);
	});
});

describe('a change to the ink file made elsewhere', () => {
	it('is merged with a save that had not heard of it', async () => {
		note = await open(noteText(fence('a')), { [INK]: await inkFileText({ a: holding() }) });
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		note.setInkFile(INK, await inkFileText({ a: holding('theirs') }));
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, 'a')).toBe(2);
	});

	it('is taken on by a block nobody is drawing in, and survives its next save', async () => {
		note = await open(noteText(fence('a')), { [INK]: await inkFileText({ a: holding() }) });
		await note.syncInkFile(INK, await inkFileText({ a: holding('theirs') }));

		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, 'a')).toBe(2);
	});
});

describe('blocks that may not be saved', () => {
	it.each([
		['the ink file does not exist', {}, 'cannot find the ink file'],
		['the ink file holds no such block', { [INK]: 'placeholder' }, 'holds no drawing for this block'],
		['the ink file is from a newer version', { [INK]: '{"version":4,"blocks":{}}' }, 'newer version of Inkling'],
		['the ink file cannot be read', { [INK]: '{"version":1,"blocks":{"a":' }, 'could not read the ink file'],
	])('refuse ink, change nothing, and say why, when %s', async (_label, files: Record<string, string>, says) => {
		const inkFiles = files[INK] === 'placeholder' ? { [INK]: await inkFileText({ other: holding() }) } : files;
		note = await open(noteText(fence('a')), inkFiles);
		const before = note.inkFile(INK);

		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.inkFile(INK)).toBe(before);
		expect(banner()).toContain(says);
	});

	it('refuses a fence that does not name its file', async () => {
		note = await open(noteText('```inkling\nid: a\n```'), {});
		expect(banner()).toContain('does not say which ink file');
	});
});

describe('an ink file deleted while its note is open', () => {
	beforeEach(async () => {
		note = await open(noteText(fence('a')), { [INK]: await inkFileText({ a: holding() }) });
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.deleteInkFile(INK);
		await note.flushWrites();
	});

	it('is not recreated by a save', () => {
		expect(note.inkFile(INK)).toBeUndefined();
	});

	it('keeps the drawing somewhere that survives quitting', () => {
		expect(Object.keys(window.localStorage).some((key) => key === `inkling:unsaved:${INK}::a`)).toBe(true);
	});

	it('saves the drawing once the file comes back', async () => {
		await note.syncInkFile(INK, await inkFileText({ a: holding() }));
		await note.flushWrites();

		expect(banner()).toBeNull();
		expect(await note.inkStrokeCount(INK, 'a')).toBe(1);
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/markdown/inkFileBlockIntegration.test.ts`
Expected: FAIL. Blocks render as unreadable in-note blocks.

- [ ] **Step 4: Write the vault IO**

Create `src/markdown/inkFileVaultIO.ts`:

```ts
import type { Vault } from 'obsidian';
import type { InkFileIO, ReplaceResult } from './inkFileStore';

// The store's file access, over Obsidian's Vault. Through the Vault API
// rather than the adapter, so every write fires the events sync plugins and
// the store's own external-change watch depend on.

async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
	const segments = path.split('/').slice(0, -1);
	for (let depth = 1; depth <= segments.length; depth++) {
		const folder = segments.slice(0, depth).join('/');
		if (vault.getFolderByPath(folder)) continue;
		try {
			await vault.createFolder(folder);
		} catch (error) {
			// Created by something else in the meantime is fine; anything else
			// is a failure the store reports.
			if (!vault.getFolderByPath(folder)) throw error;
		}
	}
}

export function vaultInkFileIO(vault: Vault): InkFileIO {
	return {
		read: async (path) => {
			const file = vault.getFileByPath(path);
			return file ? vault.read(file) : null;
		},
		size: async (path) => (await vault.adapter.stat(path))?.size ?? null,
		replaceIf: async (path, expected, next): Promise<ReplaceResult> => {
			const file = vault.getFileByPath(path);
			if (expected === null) {
				if (file) return { written: false, found: await vault.read(file) };
				await ensureParentFolder(vault, path);
				await vault.create(path, next);
				return { written: true };
			}
			if (!file) return { written: false, found: null };

			// Read, compare and write under the vault's own lock, so nothing can
			// land between the comparison and the write.
			const mismatch: { found: string | null } = { found: null };
			await vault.process(file, (current) => {
				if (current === expected) return next;
				mismatch.found = current;
				return current;
			});
			return mismatch.found === null ? { written: true } : { written: false, found: mismatch.found };
		},
	};
}
```

- [ ] **Step 5: Let the registry and the storage interface report back**

In `src/markdown/inkFileStore.ts`, add to `InkFileStores`:

```ts
	/** Settles once every store in use has run everything it has queued. */
	async whenIdle(): Promise<void> {
		await Promise.all([...this.entries.values()].map((entry) => entry.store.whenIdle()));
	}
```

In `src/markdown/inkBlockStorage.ts`, add to `InkBlockStorage`:

```ts
	/**
	 * Called once a write has settled and the view no longer counts it as
	 * unsaved work — the first moment the storage can put a merged result on
	 * screen.
	 */
	afterWrite?(): void;
```

and:

```ts
	/**
	 * Called when the view held a drawing because the block was refused after
	 * it was drawn in, so the storage can save it once the refusal lifts.
	 */
	heldWhileRefused?(): void;
```

In `src/markdown/inkBlock.ts`'s `write()`, directly after the `finally { this.writing = false; }` block, add:

```ts
		this.storage.afterWrite?.();
```

and replace the guard at the top of `write()`, `if (this.detached || !this.writable()) return;`, with:

```ts
		if (this.detached || !this.loaded) return;

		// Refused after it was drawn in — an in-note block found damaged by a
		// sync, or an ink file deleted inside the debounce. What is on screen
		// was never saved, and the refusal is exactly why it cannot be now, so
		// it is held somewhere that survives a quit rather than dropped.
		if (this.refusal !== null) {
			if (this.seeded) {
				this.data = { ...this.data, annotations: this.toStored(this.controller.getPageAnnotations(BLOCK_PAGE)) };
			}
			unsavedInk.hold(this.storage.rescuePath, this.blockId, this.data, this.storage.rescueSource());
			unsavedInk.persist(this.storage.rescuePath, this.blockId);
			this.storage.heldWhileRefused?.();
			return;
		}
```

Only a block that had a save scheduled reaches this: `scheduleWrite` still refuses a block that is not writable, so a block refused from the start never gets here.

- [ ] **Step 6: Write the ink-file storage**

Create `src/markdown/inkFileStorage.ts`:

```ts
import { Notice } from 'obsidian';
import { createId } from '../annotate/id';
import { emptyInkBlock, type InkBlockData } from './inkBlockFormat';
import type { BlockRefusal, InkBlockStorage, StorageHost, StorageWriteResult } from './inkBlockStorage';
import type { InkFenceDamage, InkFenceRead } from './inkFence';
import { INK_FILE_VERSION } from './inkFile';
import {
	toFileBlock,
	toInkBlockData,
	type BlockBase,
	type BlockState,
	type InkFileStatus,
	type InkFileStore,
	type InkFileStores,
	type StoreChange,
	type WriteRefusal,
} from './inkFileStore';

// A block whose strokes live in an ink file. Saving writes one block of that
// file through the store every block naming it shares; the note is never
// touched, so none of the in-note path's fence search, merge into the note,
// or scroll restoration exists here.

// A save that failed for a reason that may pass — the vault threw, or the file
// kept changing — is tried again this many times before the drawing is only
// held.
const FAILED_SAVE_RETRY_MS = 2000;
const FAILED_SAVE_RETRIES = 3;

function fenceMessage(reason: InkFenceDamage): string {
	switch (reason) {
		case 'missing-file':
			return 'This ink block does not say which ink file holds its drawing, so it cannot be shown or saved. Its fence needs a "file:" line.';
		case 'missing-id':
			return 'This ink block does not say which drawing in its ink file is its own, so it cannot be shown or saved. Its fence needs an "id:" line.';
		case 'duplicate-key':
			return 'This ink block names its ink file or its id twice, so Inkling cannot tell which is meant and will not save it.';
		case 'not-a-vault-path':
			return 'This ink block names an ink file outside the vault or in a hidden folder, so it cannot be shown or saved.';
	}
}

function refusalFor(status: InkFileStatus, state: BlockState, path: string): BlockRefusal | null {
	switch (status.kind) {
		case 'absent':
			return { message: `Inkling cannot find the ink file ${path}, so this block will not be saved. Anything drawn here is held on this device.` };
		case 'from-future':
			return {
				message: `The ink file ${path} was written by a newer version of Inkling (format ${status.version}; this version reads format ${INK_FILE_VERSION}), so this block will not be saved over it. Update Inkling to edit it.`,
			};
		case 'damaged':
			return { message: `Inkling could not read the ink file ${path}, so this block will not be saved over it.` };
		case 'loading':
		case 'readable':
			break;
	}
	switch (state.kind) {
		case 'absent':
			return { message: `The ink file ${path} holds no drawing for this block, so it will not be saved.` };
		case 'undecodable':
			return { message: `Inkling could not read this block's drawing in ${path}, so it will not be saved over it. The file's other drawings are unaffected.` };
		case 'unsupported':
			return { message: `This block's drawing is stored with ${state.codec} compression, which this device cannot read, so it will not be saved over it.` };
		case 'decoded':
			return null;
	}
}

export class InkFileStorage implements InkBlockStorage {
	readonly rescuePath: string;
	readonly blockId: string;
	private host: StorageHost | null = null;
	private store: InkFileStore | null = null;
	private unsubscribe: (() => void) | null = null;
	// The block as this view last put it on screen, and the revision that was.
	// A save based on a revision the store has moved past is merged — and a
	// merged result this view could not show leaves this unchanged, so the
	// next merge does not read the other side's strokes as erasures.
	private base: BlockBase | null = null;
	private strokes = '';
	private shown = false;
	private refusalShown: string | null = null;
	// A save refused because the block could not be written. Tried again as
	// soon as it can be.
	private waitingToSave = false;
	private failedSaves = 0;
	private closed = false;

	constructor(
		private readonly stores: InkFileStores,
		private readonly fence: InkFenceRead,
	) {
		this.rescuePath = fence.kind === 'fence' ? fence.fence.file : '';
		this.blockId = fence.kind === 'fence' ? fence.fence.id : createId();
	}

	rescueSource(): string {
		return this.strokes;
	}

	open(host: StorageHost): void {
		this.host = host;
		if (this.fence.kind === 'damaged') {
			host.refuse({ message: fenceMessage(this.fence.reason) });
			host.show(emptyInkBlock());
			return;
		}
		const store = this.stores.acquire(this.fence.fence.file);
		this.store = store;
		this.unsubscribe = store.subscribe((change, origin) => this.storeChanged(change, origin));
		void store.load().then(() => this.reflect());
	}

	async write(data: InkBlockData): Promise<StorageWriteResult> {
		const store = this.store;
		if (!store || !this.base) return { kind: 'held' };

		const outcome = await store.updateBlock(this.blockId, this, toFileBlock(data), this.base);
		if (outcome.kind === 'written') {
			this.failedSaves = 0;
			// A merged result goes on screen in afterWrite, when the view can
			// take it; until then the base stays what the screen shows.
			if (!outcome.merged) {
				this.base = { block: outcome.block, revision: outcome.revision };
				const state = store.blockState(this.blockId);
				if (state.kind === 'decoded' && state.revision === outcome.revision) this.strokes = state.strokes;
			}
			return { kind: 'saved' };
		}
		return this.refused(outcome.reason);
	}

	afterWrite(): void {
		this.reflect();
	}

	heldWhileRefused(): void {
		this.waitingToSave = true;
	}

	close(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.store) this.stores.release(this.store.path);
		this.host = null;
	}

	private storeChanged(change: StoreChange, origin: object | null): void {
		// This block's own save; write() has already dealt with it.
		if (origin === this) return;
		if (change !== 'all' && !change.has(this.blockId)) return;
		this.reflect();
	}

	// Makes the block show what the store holds for it, or why it cannot.
	private reflect(): void {
		const host = this.host;
		const store = this.store;
		if (this.closed || !host || !store) return;
		const status = store.status();
		if (status.kind === 'loading') return;
		const state = store.blockState(this.blockId);

		const refusal = refusalFor(status, state, store.path);
		if (refusal) {
			if (!host.isRefused() || this.refusalShown !== refusal.message) host.refuse(refusal);
			this.refusalShown = refusal.message;
			if (!this.shown) {
				this.shown = true;
				host.show(emptyInkBlock());
			}
			return;
		}
		if (state.kind !== 'decoded') return;

		if (host.isRefused()) {
			host.lift();
			this.refusalShown = null;
		}

		if (this.base?.revision !== state.revision) {
			const previous = this.strokes;
			// Set first: the view compares a rescued drawing against it the
			// first time it is shown something.
			this.strokes = state.strokes;
			if (host.show(toInkBlockData(state.block, this.blockId))) {
				this.shown = true;
				this.base = { block: state.block, revision: state.revision };
			} else {
				this.strokes = previous;
			}
		}

		if (this.waitingToSave && this.base) {
			this.waitingToSave = false;
			host.scheduleWrite();
		}
	}

	private refused(reason: WriteRefusal): StorageWriteResult {
		switch (reason) {
			case 'not-writable':
			case 'block-absent':
			case 'block-unreadable':
			case 'block-exists':
				// The banner says why, once reflect has seen what the store saw.
				this.waitingToSave = true;
				this.reflect();
				return { kind: 'held' };
			case 'failed':
			case 'moved-on':
			case 'encoding-mismatch':
			case 'no-blocks-over-blocks':
				this.failedSaves += 1;
				if (this.failedSaves <= FAILED_SAVE_RETRIES && reason !== 'encoding-mismatch') {
					return { kind: 'retry', afterMs: FAILED_SAVE_RETRY_MS };
				}
				if (this.failedSaves === FAILED_SAVE_RETRIES + 1 || reason === 'encoding-mismatch') {
					console.error(`Inkling: could not save ink block ${this.blockId} to ${this.rescuePath} (${reason}). The drawing is held on this device.`);
					new Notice('Inkling: could not save this ink block to its ink file. Your drawing is still on screen and is held on this device.');
				}
				return { kind: 'held' };
		}
	}
}
```

- [ ] **Step 7: Choose a storage per fence**

In `src/markdown/inkBlock.ts`, add imports:

```ts
import { isInkFileFence, parseInkFence } from './inkFence';
import { InkFileStorage } from './inkFileStorage';
import { InkFileStores } from './inkFileStore';
import { vaultInkFileIO } from './inkFileVaultIO';
```

Change `registerInkBlock` to:

```ts
export interface InkBlockRegistration {
	/** Settles once every ink file store has run what it has queued. */
	whenIdle(): Promise<void>;
}

export function registerInkBlock(plugin: Plugin, toolState: ToolState, captionsEnabled: () => boolean): InkBlockRegistration {
	// Once per load. Entries belong to blocks that may never be opened again,
	// so nothing else will ever expire them, and localStorage is small enough
	// that a fortnight of abandoned drawings is worth sweeping out.
	unsavedInk.purgeExpired();

	// One per load, shared by every block naming the same ink file.
	const vault = plugin.app.vault;
	const stores = new InkFileStores(vaultInkFileIO(vault));
	plugin.registerEvent(vault.on('modify', (file) => stores.fileChanged(file.path)));
	plugin.registerEvent(vault.on('create', (file) => stores.fileChanged(file.path)));
	plugin.registerEvent(vault.on('delete', (file) => stores.fileDeleted(file.path)));
	plugin.registerEvent(vault.on('rename', (file, oldPath) => stores.fileRenamed(oldPath, file.path)));

	plugin.registerMarkdownCodeBlockProcessor(INK_BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(
			new InkBlockChild(el, () => {
				// Decided by the fence's own content, so a vault can hold both
				// formats indefinitely and neither is a fallback for the other.
				const storage = isInkFileFence(source)
					? new InkFileStorage(stores, parseInkFence(source))
					: new InNoteStorage(plugin, ctx, el, source);
				return new InkBlockView(plugin, ctx, el, storage, toolState, captionsEnabled);
			}),
		);
	});
```

keep the `insert-ink-block` command unchanged for now, and end the function with `return { whenIdle: () => stores.whenIdle() };`.

- [ ] **Step 8: Run the integration tests**

Run: `npx vitest run tests/markdown/inkFileBlockIntegration.test.ts`
Expected: PASS.

If "survives its next save" fails with one stroke instead of two, the view took the synced block but the storage's base did not move with it; check `reflect` sets `base` only when `show` returns true. If a refusal test finds the file changed, a save path wrote before `reflect` saw the status; check `write` returns `held` when `this.base` is null.

- [ ] **Step 9: Leave new-format fences out of compaction**

In `tests/markdown/compactInkBlocks.test.ts`, add:

```ts
describe('a fence whose ink lives in a file', () => {
	it('is left exactly as it is and not counted as unreadable', () => {
		const source = '# Note\n\n```inkling\nfile: Ink/Note.ink\nid: a\n```\n';
		const result = compactInkBlocks(source);
		expect(result.content).toBe(source);
		expect(result.skipped).toBe(0);
		expect(result.blocks).toBe(0);
	});
});
```

Run: `npx vitest run tests/markdown/compactInkBlocks.test.ts` — expected: FAIL, `skipped` is 1.

In `src/markdown/compactInkBlocks.ts`, import `isInkFileFence` from `./inkFence`, and directly after `const body = lines.slice(index + 1, close).join('\n');` add:

```ts
		// Its strokes are in an ink file, compressed, and nothing here applies.
		// Not counted as skipped: nothing is wrong with it.
		if (isInkFileFence(body)) {
			for (let copy = index; copy <= close; copy++) out.push(lines[copy] ?? '');
			index = close;
			continue;
		}
```

Run the test again — expected: PASS.

- [ ] **Step 10: Build, lint, full test run, commit**

Run: `npm run build && npm run lint && npm test`
Expected: all pass, including every existing ink block test.

```bash
git add src/markdown/inkFileStorage.ts src/markdown/inkFileVaultIO.ts src/markdown/inkFileStore.ts src/markdown/inkBlockStorage.ts src/markdown/inkBlock.ts src/markdown/compactInkBlocks.ts tests/harness/note.ts tests/markdown/inkFileBlockIntegration.test.ts tests/markdown/compactInkBlocks.test.ts
git commit -m "Draw in a block whose ink lives in a file" -m "A fence holding file: and id: lines now renders a block whose strokes are read from and saved to that ink file, leaving the note untouched. Blocks naming the same file share one store, so a copied fence shows and edits the same drawing, and a change made elsewhere is taken on by a block nobody is drawing in or merged into the next save of one somebody is.

A block whose file is missing, from a newer version or unreadable, whose drawing the file does not hold or cannot decode, or whose fence is damaged, shows why and refuses ink. A save it could not make is held on the device and written once the block can be saved again. Compaction leaves these fences alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 8: Where ink files go, and inserting a block that uses one

**Files:**
- Create: `src/markdown/inkFilePath.ts`
- Modify: `src/settings.ts`, `src/settingsTab.ts`, `src/main.ts`, `src/markdown/inkBlock.ts`
- Modify: `tests/harness/note.ts`, `tests/harness/obsidian.ts`
- Test: `tests/markdown/inkFilePath.test.ts`, `tests/settings.test.ts`, `tests/settingsTab.test.ts`, `tests/markdown/inkFileBlockIntegration.test.ts`

**Interfaces:**
- Consumes: `isVaultPath`, `inkFenceMarkdown` (Task 3); `INK_FILE_EXTENSION`, `emptyFileBlock` (Task 2); `InkFileStores.acquire/release`, `InkFileStore.load/createBlock` (Tasks 4–5).
- Produces:
  - `type InkFileLocation = 'attachments' | 'beside-note' | 'folder'`, `INK_FILE_LOCATIONS`
  - `inkFileName(notePath: string): string`, `joinVaultPath(folder: string, name: string): string`
  - `inkFilePathFor(notePath: string, location: InkFileLocation, folder: string, attachmentFolderFor: (notePath: string, fileName: string) => string): string`
  - `InklingSettings.inkFileLocation: InkFileLocation` (default `'attachments'`), `InklingSettings.inkFileFolder: string` (default `'Ink'`)
  - `interface InkBlockOptions { captionsEnabled: () => boolean; inkFilePathFor: (notePath: string) => string }` and `registerInkBlock(plugin, toolState, options: InkBlockOptions): InkBlockRegistration`
  - Harness: `MountNoteOptions.inkFilePathFor?`, `TestNote.runInsertCommand(): Promise<void>`

- [ ] **Step 1: Write the failing path tests**

Create `tests/markdown/inkFilePath.test.ts`:

```ts
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
```

Run: `npx vitest run tests/markdown/inkFilePath.test.ts` — expected: FAIL, cannot resolve the module.

- [ ] **Step 2: Write the path module**

Create `src/markdown/inkFilePath.ts`:

```ts
import { INK_FILE_EXTENSION } from './inkFile';

// Where a new block's ink file is created. Creation only: changing the
// setting never moves a file that exists, and nothing here is consulted for a
// block already inserted, whose fence names its file outright.

export type InkFileLocation = 'attachments' | 'beside-note' | 'folder';
export const INK_FILE_LOCATIONS: readonly InkFileLocation[] = ['attachments', 'beside-note', 'folder'];

// One file per note, by convention and not by rule: two notes of the same
// name sharing an attachment folder share an ink file, and that works,
// because block ids are unique and nothing in the file says which note it
// belongs to.
export function inkFileName(notePath: string): string {
	const name = notePath.split('/').pop() ?? notePath;
	return `${name.replace(/\.md$/i, '')}.${INK_FILE_EXTENSION}`;
}

export function joinVaultPath(folder: string, name: string): string {
	const trimmed = folder.replace(/^\/+/, '').replace(/\/+$/, '');
	return trimmed ? `${trimmed}/${name}` : name;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * `attachmentFolderFor` is Obsidian's `fileManager.getNewFileParent(notePath,
 * fileName).path`, which answers with the attachment folder when given a
 * file name that is not a note.
 */
export function inkFilePathFor(
	notePath: string,
	location: InkFileLocation,
	folder: string,
	attachmentFolderFor: (notePath: string, fileName: string) => string,
): string {
	const name = inkFileName(notePath);
	switch (location) {
		case 'beside-note':
			return joinVaultPath(parentOf(notePath), name);
		case 'folder':
			return joinVaultPath(folder, name);
		case 'attachments':
			return joinVaultPath(attachmentFolderFor(notePath, name), name);
	}
}
```

Run the path tests — expected: PASS.

- [ ] **Step 3: Write the failing settings tests**

In `tests/settings.test.ts`, add inside `describe('normalizeSettings', ...)`:

```ts
	it('puts new ink files with attachments unless told otherwise', () => {
		expect(defaultSettings().inkFileLocation).toBe('attachments');
		expect(defaultSettings().inkFileFolder).toBe('Ink');
	});

	it('keeps an ink file location and folder it recognises', () => {
		const settings = normalizeSettings({ inkFileLocation: 'folder', inkFileFolder: 'Blocks/Ink' });
		expect(settings.inkFileLocation).toBe('folder');
		expect(settings.inkFileFolder).toBe('Blocks/Ink');
	});

	it('refuses an ink file folder that is not a folder in the vault', () => {
		expect(normalizeSettings({ inkFileFolder: '.inkling' }).inkFileFolder).toBe('Ink');
		expect(normalizeSettings({ inkFileFolder: '../outside' }).inkFileFolder).toBe('Ink');
		expect(normalizeSettings({ inkFileFolder: '' }).inkFileFolder).toBe('Ink');
		expect(normalizeSettings({ inkFileLocation: 'cloud' }).inkFileLocation).toBe('attachments');
	});

	it('takes a folder with slashes around it as the folder', () => {
		expect(normalizeSettings({ inkFileFolder: '/Ink/' }).inkFileFolder).toBe('Ink');
	});
```

In `tests/settingsTab.test.ts`, add inside `describe('the settings tab', ...)`:

```ts
	it('offers the ink file folder only when ink files go in a folder', () => {
		const { tab, plugin } = openTab();
		const folder = flatten(tab.getSettingDefinitions()).find((def) => def.control?.key === 'inkFileFolder');
		const visible = folder?.visible;
		if (typeof visible !== 'function') throw new Error('the ink file folder should decide its own visibility');

		expect(visible()).toBe(false);
		plugin.settings.inkFileLocation = 'folder';
		expect(visible()).toBe(true);
	});
```

Run: `npx vitest run tests/settings.test.ts tests/settingsTab.test.ts` — expected: FAIL.

- [ ] **Step 4: Add the settings**

In `src/settings.ts`, add imports:

```ts
import { isVaultPath } from './markdown/inkFence';
import { INK_FILE_LOCATIONS, type InkFileLocation } from './markdown/inkFilePath';
```

Add to `InklingSettings`, after `blockCaptions`:

```ts
	// Where a newly inserted ink block's file is created. Changing it never
	// moves a file that exists.
	inkFileLocation: InkFileLocation;
	// The folder used when inkFileLocation is 'folder'.
	inkFileFolder: string;
```

Add to `defaultSettings()` after `blockCaptions: false,`:

```ts
		// Wherever the vault's images already go, so ink lands somewhere
		// sensible without anyone configuring anything.
		inkFileLocation: 'attachments',
		inkFileFolder: 'Ink',
```

In `normalizeSettings`, before the `return`:

```ts
	// A folder in the vault, never a hidden one: the Vault API cannot see a
	// dot-folder, and ink that silently stops syncing is the worst failure
	// there is.
	const rawFolder = typeof source.inkFileFolder === 'string' ? source.inkFileFolder.trim().replace(/^\/+/, '').replace(/\/+$/, '') : '';
	const inkFileFolder = rawFolder && isVaultPath(rawFolder) ? rawFolder : defaults.inkFileFolder;
```

and in the returned object after `blockCaptions`:

```ts
		inkFileLocation: pick(source.inkFileLocation, INK_FILE_LOCATIONS, defaults.inkFileLocation),
		inkFileFolder,
```

In `writeSetting`, change the `accepted` line so a folder written with slashes around it is accepted as the folder it normalizes to:

```ts
	const accepted =
		kept === value ||
		(typeof value === 'string' && kept === value.trim()) ||
		(key === 'inkFileFolder' && typeof value === 'string' && kept === value.trim().replace(/^\/+/, '').replace(/\/+$/, ''));
```

In `src/settingsTab.ts`, add a group after the "Reading and editing" group:

```ts
			{
				type: 'group',
				heading: 'Ink blocks',
				items: [
					{
						name: 'Where new ink files go',
						desc:
							'An ink block keeps its drawing in a file of its own, one per note, so the note stays text. ' +
							'This decides where that file is created. Changing it never moves a file that already exists.',
						aliases: ['ink file', 'attachments'],
						control: {
							type: 'dropdown',
							key: 'inkFileLocation',
							defaultValue: defaults.inkFileLocation,
							options: { attachments: 'Same folder as attachments', 'beside-note': 'Same folder as the note', folder: 'A folder of their own' },
						},
					},
					{
						name: 'Ink file folder',
						desc: 'To keep ink files out of search and the graph, add this folder to Files and links, Excluded files.',
						visible: () => this.plugin.settings.inkFileLocation === 'folder',
						control: { type: 'folder', key: 'inkFileFolder', defaultValue: defaults.inkFileFolder, placeholder: defaults.inkFileFolder },
					},
				],
			},
```

and in `setControlValue`, after `await this.plugin.saveSettings();`:

```ts
		// The folder setting shows only for one location.
		if (key === 'inkFileLocation') this.refreshDomState();
```

In `tests/harness/obsidian.ts`, add to `PluginSettingTab`:

```ts
	refreshDomState(): void {
		// Nothing renders in a test.
	}
```

Run: `npx vitest run tests/settings.test.ts tests/settingsTab.test.ts` — expected: PASS.

- [ ] **Step 5: Write the failing insert test**

In `tests/harness/note.ts`:

Add to `MountNoteOptions`:

```ts
	/** Where the insert command puts a new block's ink file. Defaults to Ink/<note>.ink. */
	inkFilePathFor?: (notePath: string) => string;
```

Add to `TestNote`:

```ts
	/** Runs "Insert ink annotation block" in this note's editor, and lets it settle. */
	runInsertCommand(): Promise<void>;
```

Import `inkFileName` from `../../src/markdown/inkFilePath`. Replace `addCommand: () => undefined,` in `plugin` with:

```ts
		addCommand: (command: { id: string; editorCallback?: (editor: unknown, ctx: unknown) => void }) => {
			commands.set(command.id, command);
		},
```

declaring `const commands = new Map<string, { id: string; editorCallback?: (editor: unknown, ctx: unknown) => void }>();` above `plugin`. Replace the `registerInkBlock` call with:

```ts
	const registration = registerInkBlock(plugin as unknown as Plugin, toolState, {
		captionsEnabled: () => options.blockCaptions ?? false,
		inkFilePathFor: options.inkFilePathFor ?? ((notePath) => `Ink/${inkFileName(notePath)}`),
	});
```

and add to the returned object:

```ts
		runInsertCommand: async () => {
			const insert = commands.get('insert-ink-block')?.editorCallback;
			if (!insert) throw new Error('registerInkBlock did not register the insert command');
			insert(editor, { file });
			await settle();
		},
```

In `tests/markdown/inkFileBlockIntegration.test.ts`, add:

```ts
describe('inserting a block', () => {
	beforeEach(() => {
		note = mountNote({ path: 'Physics.md', contents: '# Physics\n\n', openInEditor: true });
	});

	it('puts a three-line fence in the note', async () => {
		await note.runInsertCommand();
		expect(note.contents()).toMatch(/```inkling\nfile: Ink\/Physics\.ink\nid: ink-[^\n]+\n```\n$/);
	});

	it('creates the block in the ink file, so it is never mistaken for a missing one', async () => {
		await note.runInsertCommand();
		const id = /id: (.+)\n/.exec(note.contents())?.[1];
		if (!id) throw new Error('no id in the inserted fence');
		expect(await note.inkStrokeCount('Ink/Physics.ink', id)).toBe(0);
	});

	it('gives a block that renders ready to draw in, and saves', async () => {
		await note.runInsertCommand();
		note.rerender();
		await note.settle();
		expect(banner()).toBeNull();

		const id = /id: (.+)\n/.exec(note.contents())?.[1] ?? '';
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();
		expect(await note.inkStrokeCount('Ink/Physics.ink', id)).toBe(1);
	});

	it('adds to an ink file the note already has', async () => {
		await note.runInsertCommand();
		await note.runInsertCommand();
		const ids = [...note.contents().matchAll(/id: (.+)\n/g)].map((match) => match[1] ?? '');
		expect(ids).toHaveLength(2);
		for (const id of ids) expect(await note.inkStrokeCount('Ink/Physics.ink', id)).toBe(0);
	});

	it('inserts nothing when the ink file cannot be written', async () => {
		note = mountNote({
			path: 'Physics.md',
			contents: '# Physics\n\n',
			openInEditor: true,
			inkFiles: { 'Ink/Physics.ink': '{"version":1,"blocks":{' },
		});
		await note.runInsertCommand();
		expect(note.contents()).toBe('# Physics\n\n');
		expect(note.notices().some((message) => message.includes('no ink block was inserted'))).toBe(true);
	});
});
```

Run: `npx vitest run tests/markdown/inkFileBlockIntegration.test.ts` — expected: FAIL to typecheck, `registerInkBlock` takes a function.

- [ ] **Step 6: Insert new-format blocks**

In `src/markdown/inkBlock.ts`:

Change the `obsidian` import to `import { Editor, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, Plugin, setIcon, setTooltip } from 'obsidian';`, remove `inkBlockMarkdown` from the `./inkBlockFormat` import, and add:

```ts
import { inkFenceMarkdown, isVaultPath } from './inkFence';
import { emptyFileBlock } from './inkFile';
```

Add above `registerInkBlock`:

```ts
export interface InkBlockOptions {
	captionsEnabled: () => boolean;
	/** Where a new block's ink file goes, for a note at this path. */
	inkFilePathFor: (notePath: string) => string;
}

// The block is created in the ink file before its fence goes into the note.
//
// A fence naming a block its file does not hold is a missing block — pasted
// from another vault, or arrived before its file did — and is refused rather
// than saved, because saving it would put a new drawing where an existing one
// may yet arrive. Creating the entry first is what lets that rule be absolute:
// a block this command inserted is never mistaken for one that is missing.
// An empty block costs about forty bytes.
async function insertInkFileBlock(stores: InkFileStores, editor: Editor, path: string): Promise<void> {
	if (!isVaultPath(path)) {
		new Notice(`Inkling: ${path} is not a place in the vault an ink file can go, so no ink block was inserted. Check where new ink files go in settings.`);
		return;
	}
	const id = createId();
	const store = stores.acquire(path);
	try {
		await store.load();
		const outcome = await store.createBlock(id, emptyFileBlock());
		if (outcome.kind !== 'written') {
			new Notice(`Inkling: could not add a drawing to ${path}, so no ink block was inserted.`);
			return;
		}
		// Trailing newline so the cursor ends up on a fresh line after the
		// block rather than inside the fence.
		editor.replaceSelection(`${inkFenceMarkdown({ file: path, id, extra: [] })}\n`);
	} finally {
		stores.release(path);
	}
}
```

Change the signature to `export function registerInkBlock(plugin: Plugin, toolState: ToolState, options: InkBlockOptions): InkBlockRegistration`, pass `options.captionsEnabled` where `captionsEnabled` was passed to `InkBlockView`, and replace the `insert-ink-block` command with:

```ts
	plugin.addCommand({
		id: 'insert-ink-block',
		name: 'Insert ink annotation block',
		// Command palette only, per the plan — no ribbon icon, so it's
		// reachable the same way on desktop and mobile.
		editorCallback: (editor, ctx) => {
			const notePath = ctx.file?.path;
			if (!notePath) {
				new Notice('Inkling: this note has no file yet, so there is nowhere to name its ink file.');
				return;
			}
			void insertInkFileBlock(stores, editor, options.inkFilePathFor(notePath));
		},
	});
```

`emptyInkBlock` stays imported (the view uses it). `inkBlockMarkdown` is no longer used by `inkBlock.ts`; the in-note format still writes it for the harness and compaction.

In `src/main.ts`, import `inkFilePathFor` from `./markdown/inkFilePath` and replace the `registerInkBlock(...)` line with:

```ts
		registerInkBlock(this, this.toolState, {
			captionsEnabled: () => this.settings.blockCaptions,
			inkFilePathFor: (notePath) =>
				inkFilePathFor(
					notePath,
					this.settings.inkFileLocation,
					this.settings.inkFileFolder,
					(source, name) => this.app.fileManager.getNewFileParent(source, name).path,
				),
		});
```

- [ ] **Step 7: Run everything touched**

Run: `npx vitest run tests/markdown tests/settings.test.ts tests/settingsTab.test.ts`
Expected: PASS.

- [ ] **Step 8: Build, lint, full test run, commit**

Run: `npm run build && npm run lint && npm test`

```bash
git add src/markdown/inkFilePath.ts src/settings.ts src/settingsTab.ts src/main.ts src/markdown/inkBlock.ts tests/harness/note.ts tests/harness/obsidian.ts tests/markdown/inkFilePath.test.ts tests/settings.test.ts tests/settingsTab.test.ts tests/markdown/inkFileBlockIntegration.test.ts
git commit -m "Insert ink blocks that keep their drawing in a file" -m "The insert command now creates the block in an ink file named after the note and puts a three-line fence in the note. The block is created in the file first, so a fence naming a block its file does not hold can always be treated as missing rather than as new. Nothing is inserted when the file cannot be written.

Where the file goes is a setting: with attachments by default, beside the note, or in a folder of its own, which can be excluded from search. Changing it never moves a file. Blocks already in notes are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 9: Verify in the running app

Not code. The tests prove the source; only a build, a copy and a reload put it in front of anyone. See the memory note on testing through the `obsidian` CLI: the test vault is `C:\Users\willi\Documents\Workspace\KnowledgeCore`, its plugin folder is a copy rather than a link, and `eval` may return nothing on the current installer, in which case verify on disk and ask the user to reload the plugin.

- [ ] **Step 1: Build and deploy**

Run: `npm run build`, then copy `main.js`, `manifest.json`, `pdf.worker.js`, `styles.css` and `annotation-writer.worker.js` into `KnowledgeCore/.obsidian/plugins/inkling/`, and reload the plugin.

- [ ] **Step 2: Work on a copy, never the real note**

Duplicate "Newton's Laws of Motion Exercises" as "Inkling ink file test" in the same folder. Old-format blocks in the copy must render and save exactly as before.

- [ ] **Step 3: Check what the spec could not**

In the copy, run "Insert ink annotation block" and confirm, on disk:
1. The ink file landed in the attachment folder (decision 4). If it landed in the new-note folder instead, `getNewFileParent` does not do what the plan assumed: stop and report it rather than work around it.
2. The fence is three lines, and the ink file holds the new id.
3. Drawing in the block changes the ink file and leaves the note's bytes unchanged.
4. The block's `codec` key is absent, meaning desktop compressed it.

- [ ] **Step 4: Ask for the tablet**

Ask the user to reload the plugin on the Samsung tablet first (it runs stale code until reloaded), then open the copied note, draw in the new block, and report whether the ink file's block for that id gained a `"codec": "none"` key. Absent means the tablet compresses; present means it fell back, which works but is worth knowing before the conversion script runs.

- [ ] **Step 5: Mark the phase done in the spec**

In `docs/superpowers/specs/2026-09-16-ink-sidecar-files-design.md`, change the status line to:

```
Status: approved; phase 1 implemented (docs/superpowers/plans/2026-09-17-ink-sidecar-files.md). Phases 2–4 not started.
```

and record under it anything Steps 3–4 found that the design did not know.

```bash
git add docs/superpowers/specs/2026-09-16-ink-sidecar-files-design.md
git commit -m "Record what the running app said about ink files" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

## Not in this phase

Each of these is refused safely by what this plan builds, and planned separately against the code it produces:

- **Phase 2:** the "when an ink file goes missing" setting, restore from memory, `.trash` and the rescue store, and "start a new drawing here".
- **Phase 3:** `inkFileSalvage.ts`, quarantine, the confirming re-read, repair with its notice and undo.
- **Phase 4:** `inkFileLinks.ts`, rewriting fences on rename, "rename ink file to match note", "remove unreferenced blocks" including quarantine files.
- The one-off conversion script for the three existing notes, after the whole feature is verified.
