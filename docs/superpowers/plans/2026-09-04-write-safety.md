# Track A — Write Safety and the Regression Net: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for Inkling to write a structurally damaged or truncated PDF into the user's vault, stop it rewriting files it merely opened, cut the binary churn its save cadence causes, and put a test harness under the pure logic modules so later tracks can be built aggressively.

**Architecture:** Three independent guards, plus a net. A *cross-parser gate* on open compares `pdf-lib`'s view of the document against `pdf.js`'s and refuses edit mode when they disagree. A *structural fingerprint* is taken of the in-memory document before every save and compared against a reparse of the produced bytes, inside the existing writer worker, so a bad serialization never leaves it. An *atomic replace helper* routes every binary write through a scratch file so an interrupted write can't truncate the original. Vitest covers the pure modules; GitHub Actions runs it.

**Tech Stack:** TypeScript, `pdf-lib` 1.17.1 (pinned), `pdfjs-dist` 5.4.530 (pinned), Obsidian plugin API, esbuild, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-write-safety-design.md`

## Global Constraints

Copied from the project plan (`ink-annotation-plugin-plan.md`) and the spec. Every task's requirements implicitly include these.

- **`isDesktopOnly: false`.** No Node.js or Electron APIs anywhere, including in dependencies. All vault file I/O goes through Obsidian's Vault API or `vault.adapter` — never raw `fs`. (This constrains shipped code in `src/`. Test files under `tests/` run in Node and may use Node APIs freely.)
- **No network calls at all.** No CDN assets, no telemetry, no update pings.
- **Do not bump `pdf-lib` or `pdfjs-dist`.** Both are pinned to exact versions for reasons recorded at `src/pdfView.ts:10-13` (`pdfjs-dist` 5.4.624+ calls `Uint8Array.prototype.toHex()`, too new for Obsidian's bundled Chromium).
- **No new runtime dependencies.** Vitest is a `devDependency` only. Supply-chain hygiene is a hard requirement; the lockfile is committed.
- Obsidian API conventions: build DOM with `createEl`/`createDiv`, not `document.createElement`; user-facing copy is sentence case; no `innerHTML`.
- Minimum Obsidian version is 1.4.4 (`manifest.json`), so don't reach for newer API.
- **No backups.** The target vault syncs through Self-hosted LiveSync to CouchDB, where any in-vault copy costs database size and bandwidth on every device. See the spec's "Environment constraints".
- `strict: true` and `noUncheckedIndexedAccess: true` are on. Indexed access yields `T | undefined`; handle it rather than asserting.
- Commit after every task. `npm run build` (which runs `tsc -noEmit` first) and `npm run lint` must both pass before any commit.

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `vitest.config.ts` | Test runner config. Node environment, `tests/**/*.test.ts`. |
| `tests/annotate/geometry.test.ts` | Hit-testing, polygon enclosure, transform helpers. |
| `tests/annotate/eraser.test.ts` | Segment-aware erase, including the sparse-segment bug. |
| `tests/annotate/toolState.test.ts` | Per-tool style memory, `suggestTool` semantics, subscriptions. |
| `tests/markdown/inkBlockFormat.test.ts` | Defensive parsing of untrusted block content. |
| `tests/pdf/fingerprint.test.ts` | Fingerprint construction and comparison. |
| `tests/pdf/annotationSync.test.ts` | Annotation write→read round trip. |
| `tests/pdf/saveCadence.test.ts` | File-size→interval mapping. |
| `tests/pdf/compatibility.test.ts` | Structure profiles and their comparison. |
| `tests/vaultWrite.test.ts` | Atomic replace against an in-memory fake adapter. |
| `src/pdf/fingerprint.ts` | Structural fingerprint of a `PDFDocument`, and comparison of two. Pure w.r.t. Obsidian. |
| `src/pdf/compatibility.ts` | Structure profile shared by both parsers, risky-feature detection, profile comparison. Pure. |
| `src/vaultWrite.ts` | Scratch-file-then-swap binary write, and scratch cleanup. Takes a `DataAdapter`. |
| `.github/workflows/ci.yml` | Lint, test, build on push and pull request. |

**Modified files:**

| Path | Change |
|---|---|
| `package.json` | Add `vitest` devDependency and `test` / `test:watch` scripts. |
| `tsconfig.json` | Include `tests/**/*.ts` so `npm run build` type-checks tests too. |
| `eslint.config.mts` | Allow `vitest.config.ts` in the default project. |
| `src/pdf/annotationSync.ts` | Export `isInklingAnnotationDict`; use it at the two existing call sites. |
| `src/pdf/annotationWriterCore.ts` | Verify before returning bytes; drop the prune-on-open save; expose a structure profile. |
| `src/pdf/annotationWriterProtocol.ts` | Replace `prunedBytes` with nothing; add `profile` to the open reply. |
| `src/pdf/annotationWriterClient.ts` | Mirror the protocol change. |
| `src/pdfView.ts` | Remove the prune write; size-scaled cadence; safe writes; open gate and read-only mode. |
| `src/annotate/controller.ts` | `setReadOnly` / `isReadOnly`, gating input. |
| `src/annotate/toolbar.ts` | Disable controls when the controller is read-only. |
| `src/main.ts` | Clean stale scratch files on load. |

---

### Task 1: Vitest harness and tests for the existing pure modules

Nothing else in this plan can be built safely until `npm test` exists. This task adds the runner and covers four modules that already work, so the harness is proven against known-good code before anything depends on it.

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/annotate/geometry.test.ts`
- Create: `tests/annotate/eraser.test.ts`
- Create: `tests/annotate/toolState.test.ts`
- Create: `tests/markdown/inkBlockFormat.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `eslint.config.mts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test`. Every later task adds tests under `tests/` and runs them the same way.

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev vitest@^3.2.4
```

- [ ] **Step 2: Add the test scripts**

In `package.json`, add to `"scripts"` (keep the existing entries):

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

// Node, not jsdom: everything covered here is pure logic over plain data
// structures — geometry, parsing, tool state — with no DOM in it. Anything
// that does touch the DOM gets an environment override in its own file
// rather than slowing every test down with a jsdom global.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
	},
});
```

- [ ] **Step 4: Let `tsc` and ESLint see the tests**

In `tsconfig.json`, change the `include` line to:

```json
	"include": ["src/**/*.ts", "tests/**/*.ts"]
```

In `eslint.config.mts`, add `'vitest.config.ts'` to the `allowDefaultProject` array so it reads:

```ts
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts'],
				},
```

- [ ] **Step 5: Write the geometry tests**

Create `tests/annotate/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	boundingBox,
	distanceToSegment,
	hitTestAnnotation,
	normalizeRect,
	pointInPolygon,
	polygonEnclosesAnnotation,
	scaleAnnotation,
	translateAnnotation,
} from '../../src/annotate/geometry';
import type { Annotation, StrokeAnnotation } from '../../src/annotate/types';

function stroke(points: { x: number; y: number }[], width = 3): StrokeAnnotation {
	return { id: 'ink-test', kind: 'stroke', tool: 'pen', color: '#000000', width, points };
}

describe('distanceToSegment', () => {
	it('measures perpendicular distance to the segment body', () => {
		expect(distanceToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
	});

	it('clamps past an endpoint rather than extending the line', () => {
		expect(distanceToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
	});

	it('degrades to point distance for a zero-length segment', () => {
		expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
	});
});

describe('hitTestAnnotation', () => {
	// The tolerance floor is generous on purpose (MIN_HIT_TOLERANCE = 10),
	// because a fingertip or an imprecise pen tap has to be able to hit a
	// one-pixel line.
	it('hits a thin stroke from within the tolerance floor', () => {
		expect(hitTestAnnotation(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 9 })).toBe(true);
	});

	it('misses beyond the tolerance floor', () => {
		expect(hitTestAnnotation(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 40 })).toBe(false);
	});

	it('treats a rectangle as a filled region, not just its outline', () => {
		const rect: Annotation = {
			id: 'ink-r', kind: 'shape', tool: 'rectangle', color: '#000000', width: 2,
			start: { x: 0, y: 0 }, end: { x: 100, y: 100 },
		};
		expect(hitTestAnnotation(rect, { x: 50, y: 50 })).toBe(true);
	});
});

describe('polygonEnclosesAnnotation', () => {
	const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

	it('selects a stroke fully inside the lasso', () => {
		expect(polygonEnclosesAnnotation(stroke([{ x: 10, y: 10 }, { x: 90, y: 90 }]), square)).toBe(true);
	});

	it('rejects a stroke the lasso only crosses', () => {
		expect(polygonEnclosesAnnotation(stroke([{ x: 10, y: 10 }, { x: 900, y: 90 }]), square)).toBe(false);
	});

	it('rejects an oval whose corners escape even though its endpoints do not', () => {
		// A concave lasso can surround the start/end diagonal while cutting
		// through another corner — extentPoints uses all four corners for
		// exactly this case.
		const oval: Annotation = {
			id: 'ink-o', kind: 'shape', tool: 'oval', color: '#000000', width: 2,
			start: { x: 10, y: 10 }, end: { x: 150, y: 90 },
		};
		expect(polygonEnclosesAnnotation(oval, square)).toBe(false);
	});
});

describe('pointInPolygon', () => {
	it('returns false for a degenerate polygon', () => {
		expect(pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 2, y: 2 }])).toBe(false);
	});
});

describe('transforms', () => {
	it('translates every point of a stroke', () => {
		const moved = translateAnnotation(stroke([{ x: 0, y: 0 }, { x: 10, y: 10 }]), 5, -5);
		expect(moved).toMatchObject({ points: [{ x: 5, y: -5 }, { x: 15, y: 5 }] });
	});

	it('keeps a degenerate axis unscaled instead of dividing by zero', () => {
		const flat = stroke([{ x: 0, y: 50 }, { x: 10, y: 50 }]);
		const scaled = scaleAnnotation(
			flat,
			{ minX: 0, minY: 50, maxX: 10, maxY: 50 },
			{ minX: 0, minY: 50, maxX: 20, maxY: 50 },
		);
		expect(scaled).toMatchObject({ points: [{ x: 0, y: 50 }, { x: 20, y: 50 }] });
	});

	it('normalizes a rect drawn right-to-left', () => {
		expect(normalizeRect({ x: 10, y: 10 }, { x: 0, y: 0 })).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
	});

	it('bounds a stroke by its extremes', () => {
		expect(boundingBox(stroke([{ x: 5, y: 9 }, { x: 1, y: 2 }]))).toEqual({ minX: 1, minY: 2, maxX: 5, maxY: 9 });
	});
});
```

- [ ] **Step 6: Write the eraser tests**

Create `tests/annotate/eraser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eraseAt } from '../../src/annotate/eraser';
import type { Annotation, StrokeAnnotation } from '../../src/annotate/types';

function stroke(points: { x: number; y: number }[]): StrokeAnnotation {
	return { id: 'ink-test', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points };
}

describe('eraseAt', () => {
	it('leaves a stroke the eraser never reached', () => {
		const result = eraseAt([stroke([{ x: 0, y: 0 }, { x: 10, y: 0 }])], { x: 500, y: 500 }, 10);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
	});

	it('erases at a sparse segment midpoint, far from any stored point', () => {
		// The bug this pins down: a fast stroke can have sample points spaced
		// much wider than the eraser radius. Checking only the stored points
		// meant erasing exactly between two of them silently did nothing,
		// which was reported as "erase only works on this session's strokes"
		// — a freshly drawn stroke is densely sampled right where you erase,
		// a reloaded one is not.
		const sparse = stroke([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
		const result = eraseAt([sparse], { x: 200, y: 0 }, 10);
		expect(result).toHaveLength(0);
	});

	it('splits a stroke erased in its middle into two strokes', () => {
		const long = stroke([
			{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 100, y: 0 },
			{ x: 180, y: 0 }, { x: 190, y: 0 }, { x: 200, y: 0 },
		]);
		const result = eraseAt([long], { x: 100, y: 0 }, 5);
		expect(result).toHaveLength(2);
		expect(result[0]?.id).not.toBe(result[1]?.id);
	});

	it('drops fragments too short to be a line', () => {
		// A one-point remnant is not a drawable stroke, so it is discarded
		// rather than kept as an invisible annotation.
		const result = eraseAt([stroke([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 }])], { x: 10, y: 0 }, 15);
		for (const annotation of result) {
			if (annotation.kind === 'stroke') expect(annotation.points.length).toBeGreaterThanOrEqual(2);
		}
	});

	it('deletes a whole shape on contact, having no interior points to trim', () => {
		const shape: Annotation = {
			id: 'ink-s', kind: 'shape', tool: 'rectangle', color: '#000000', width: 2,
			start: { x: 0, y: 0 }, end: { x: 50, y: 50 },
		};
		expect(eraseAt([shape], { x: 25, y: 25 }, 5)).toHaveLength(0);
	});
});
```

- [ ] **Step 7: Write the tool-state tests**

Create `tests/annotate/toolState.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ToolState } from '../../src/annotate/toolState';
import { DEFAULT_COLOR, DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH } from '../../src/annotate/types';

describe('ToolState', () => {
	it('starts on select at the defaults', () => {
		const state = new ToolState();
		expect(state.getTool()).toBe('select');
		expect(state.getColor()).toBe(DEFAULT_COLOR);
		expect(state.getWidth()).toBe(DEFAULT_WIDTH);
	});

	it('remembers color and width per tool', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setColor('#e03131');
		state.setWidth(8);

		state.setTool('highlighter');
		state.setWidth(20);
		expect(state.getWidth()).toBe(20);

		state.setTool('pen');
		expect(state.getColor()).toBe('#e03131');
		expect(state.getWidth()).toBe(8);
	});

	it('clamps width to the allowed range', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setWidth(9999);
		expect(state.getWidth()).toBe(MAX_WIDTH);
		state.setWidth(-4);
		expect(state.getWidth()).toBe(MIN_WIDTH);
	});

	it('honours a suggestion only until the user picks a tool', () => {
		const state = new ToolState();
		state.suggestTool('pen');
		expect(state.getTool()).toBe('pen');

		state.setTool('select');
		state.suggestTool('pen');
		// The block re-renders on every save and suggests again; that must
		// not drag the user back out of the lasso they chose.
		expect(state.getTool()).toBe('select');
	});

	it('notifies listeners with the kind of change', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener);

		state.setTool('pen');
		expect(listener).toHaveBeenLastCalledWith('tool');

		state.setColor('#1971c2');
		expect(listener).toHaveBeenLastCalledWith('style');
	});

	it('stops notifying after unsubscribe', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener)();
		state.setTool('pen');
		expect(listener).not.toHaveBeenCalled();
	});

	it('does not notify when a setter is handed the value already held', () => {
		const state = new ToolState();
		state.setTool('pen');
		const listener = vi.fn();
		state.subscribe(listener);
		state.setTool('pen');
		state.setColor(state.getColor());
		state.setWidth(state.getWidth());
		expect(listener).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 8: Write the ink-block format tests**

Create `tests/markdown/inkBlockFormat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BLOCK_HEIGHT,
	DEFAULT_BLOCK_WIDTH,
	INK_BLOCK_VERSION,
	emptyInkBlock,
	parseInkBlock,
	serializeInkBlock,
} from '../../src/markdown/inkBlockFormat';

// Block content is untrusted: notes sync between devices, get shared, and
// can be hand-edited. Nothing here may throw — a throw would take the whole
// note's render down with it.
describe('parseInkBlock', () => {
	it('treats empty source as an empty block, not as damage', () => {
		expect(parseInkBlock('   \n ')).toEqual({ data: emptyInkBlock(), malformed: false });
	});

	it('flags unparseable JSON as malformed', () => {
		expect(parseInkBlock('{not json')).toEqual({ data: emptyInkBlock(), malformed: true });
	});

	it('flags a non-object payload as malformed', () => {
		expect(parseInkBlock('[1, 2, 3]').malformed).toBe(true);
		expect(parseInkBlock('"hello"').malformed).toBe(true);
		expect(parseInkBlock('null').malformed).toBe(true);
	});

	it('round-trips a valid block', () => {
		const source = serializeInkBlock({
			version: INK_BLOCK_VERSION,
			width: 400,
			height: 200,
			annotations: [{ id: 'ink-1', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
		});
		const { data, malformed } = parseInkBlock(source);
		expect(malformed).toBe(false);
		expect(data.width).toBe(400);
		expect(data.annotations).toHaveLength(1);
	});

	it('drops a bad annotation, keeps the good ones, and says so', () => {
		const source = JSON.stringify({
			version: 1, width: 400, height: 200,
			annotations: [
				{ id: 'ink-1', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
				{ id: 'ink-2', kind: 'stroke', tool: 'notatool', color: '#000000', width: 3, points: [{ x: 1, y: 2 }] },
			],
		});
		const { data, malformed } = parseInkBlock(source);
		expect(data.annotations).toHaveLength(1);
		expect(malformed).toBe(true);
	});

	it('rejects a stroke with one unusable point rather than bending it', () => {
		const source = JSON.stringify({
			annotations: [{ id: 'ink-1', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 1, y: 2 }, { x: 'NaN', y: 4 }] }],
		});
		expect(parseInkBlock(source).data.annotations).toHaveLength(0);
	});

	it('falls back to default dimensions for nonsense ones', () => {
		const { data } = parseInkBlock(JSON.stringify({ width: -5, height: 'tall', annotations: [] }));
		expect(data.width).toBe(DEFAULT_BLOCK_WIDTH);
		expect(data.height).toBe(DEFAULT_BLOCK_HEIGHT);
	});

	it('flags a block written by a future version so it is not overwritten', () => {
		const { malformed } = parseInkBlock(JSON.stringify({ version: INK_BLOCK_VERSION + 1, annotations: [] }));
		expect(malformed).toBe(true);
	});

	it('survives hostile input without throwing', () => {
		for (const source of ['{"annotations": {"0": {}}}', '{"annotations": [null, 1, "x", []]}', '{"__proto__": {"x": 1}}']) {
			expect(() => parseInkBlock(source)).not.toThrow();
		}
	});
});
```

- [ ] **Step 9: Run the tests**

Run: `npm test`
Expected: all suites PASS. If a test fails, the test is describing behavior the code does not have — read the source before changing either. These modules are known-good; a failure here most likely means the test's expectation is wrong.

- [ ] **Step 10: Verify the build and lint still pass**

Run: `npm run build && npm run lint`
Expected: both exit 0. `tsc` now type-checks `tests/` too.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.mts vitest.config.ts tests/
git commit -m "Put tests under the modules the write path depends on

Every regression guard this project earned was thrown away. The plan
records six real-device bugs each ending 'verified with a simulated-input
test', and there is no test directory. Vitest, plus coverage of the four
pure modules the rest of Track A builds on."
```

---

### Task 2: Run the tests in CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `test` script from Task 1.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      # Runs tsc -noEmit before esbuild, so this is the type check too.
      - run: npm run build
```

- [ ] **Step 2: Verify the same commands pass locally**

Run: `npm ci && npm run lint && npm test && npm run build`
Expected: all four exit 0. `npm ci` deletes and reinstalls `node_modules` from the lockfile, which is what CI will do — if it fails while `npm install` succeeded, the lockfile is out of step and needs committing.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Run lint, tests, and the build on every push"
```

---

### Task 3: Stop rewriting a PDF just because it was opened

`onLoadFile` currently writes the whole file back to disk, fire-and-forget, whenever opening finds orphaned annotation objects to prune. A file the user only *read* gets rewritten — a full `pdf-lib` round trip, and under LiveSync a full re-replication, with no user action and no way to decline.

The prune itself is still worth doing; it just doesn't need its own write. `openDocument` already mutates the in-memory document, so the next save that happens anyway serializes the pruned version. Removing the standalone write also removes a whole `doc.save()` from every file open, which is a startup win on large books.

**Files:**
- Modify: `src/pdf/annotationWriterCore.ts` (the `prunedBytes` block in `openDocument`, and the `OpenedDocument` interface)
- Modify: `src/pdf/annotationWriterProtocol.ts` (`OpenedOk.prunedBytes`)
- Modify: `src/pdf/annotationWriterClient.ts` (wherever `prunedBytes` is threaded through)
- Modify: `src/pdfView.ts` (the `if (prunedBytes)` block near line 465, and the surrounding declarations)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `OpenedDocument` no longer has a `prunedBytes` field; the worker's `opened` reply no longer carries one. Task 6 edits the same `openDocument` function and Task 8 adds a field to the same reply — read this task's result before starting either.

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/annotationSync.test.ts`:

```ts
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { Annotation } from '../../src/annotate/types';

// Fixtures are generated here rather than committed as binaries, so the
// repo holds no opaque test data.
async function blankDoc(pages = 1): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

describe('annotation round trip', () => {
	it('recovers a pen stroke through a save and reload', async () => {
		const doc = await blankDoc();
		const stroke: Annotation = {
			id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#e03131', width: 4,
			points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }],
		};
		writeInklingAnnotations(doc, 0, [stroke]);

		const read = readInklingAnnotations(await reload(doc), 0);
		expect(read).toHaveLength(1);
		expect(read[0]).toMatchObject({ id: 'ink-a', kind: 'stroke', color: '#e03131', width: 4 });
	});

	it('recovers a rectangle at its exact bounds, with no drift per save', async () => {
		// `/Rect` is padded by half the stroke width on write and unpadded on
		// read. If those two disagree the shape creeps outward a little on
		// every single autosave.
		const doc = await blankDoc();
		const rect: Annotation = {
			id: 'ink-r', kind: 'shape', tool: 'rectangle', color: '#1971c2', width: 6,
			start: { x: 100, y: 100 }, end: { x: 300, y: 250 },
		};
		writeInklingAnnotations(doc, 0, [rect]);

		let current = await reload(doc);
		for (let pass = 0; pass < 3; pass++) {
			const [read] = readInklingAnnotations(current, 0);
			expect(read).toMatchObject({ start: { x: 100, y: 100 }, end: { x: 300, y: 250 } });
			writeInklingAnnotations(current, 0, read ? [read] : []);
			current = await reload(current);
		}
	});

	it('replaces its own annotations rather than stacking duplicates', async () => {
		const doc = await blankDoc();
		const stroke: Annotation = {
			id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#000000', width: 3,
			points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
		};
		writeInklingAnnotations(doc, 0, [stroke]);
		writeInklingAnnotations(doc, 0, [stroke]);
		writeInklingAnnotations(doc, 0, [stroke]);
		expect(readInklingAnnotations(await reload(doc), 0)).toHaveLength(1);
	});

	it('never touches annotations authored by other software', async () => {
		const doc = await blankDoc();
		const page = doc.getPage(0);
		// A foreign annotation: no `/NM` starting with `ink-`.
		const foreign = doc.context.register(doc.context.obj({
			Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 60], F: 4,
		}));
		page.node.addAnnot(foreign);

		writeInklingAnnotations(doc, 0, [{
			id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#000000', width: 3,
			points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
		}]);

		const reloaded = await reload(doc);
		expect(readInklingAnnotations(reloaded, 0)).toHaveLength(1);
		// One of ours plus the untouched foreign one.
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);
	});
});
```

- [ ] **Step 2: Run it to establish the baseline**

Run: `npm test -- tests/pdf/annotationSync.test.ts`
Expected: PASS. This suite covers existing behavior; it is here so the next steps' edits to `openDocument` can't silently break the round trip. If anything fails now, stop and investigate before touching `openDocument` — that is a pre-existing bug and worth its own conversation.

- [ ] **Step 3: Drop the prune save from `openDocument`**

In `src/pdf/annotationWriterCore.ts`, delete the `prunedBytes` field from `OpenedDocument`:

```ts
export interface OpenedDocument {
	// Kept by the caller and passed back to writeDocument below, so repeated
	// saves reuse this parse instead of re-reading the whole file each time.
	doc: PDFDocument;
	savedAnnotations: Map<number, Annotation[]>;
	// What pdf.js should render: the file with only Inkling's own annotations
	// stripped out, so its annotation-baking render still shows annotations
	// from other PDF software without doubling up with our live overlay.
	displayBytes: ArrayBuffer;
}
```

and replace the prune block in `openDocument` with:

```ts
	// Orphans left by past sessions are pruned in memory and carried by
	// whatever save happens next, rather than triggering a write of their
	// own. Opening a file the user only means to read must not modify it —
	// a standalone write here is a full pdf-lib round trip, and under a
	// live-replicating sync it is a full re-upload, neither of which the
	// user asked for by opening a book. The return value is ignored: there
	// is nothing to do differently either way now that the document in
	// memory is already correct.
	pruneOrphanedInklingAnnotations(doc);
```

- [ ] **Step 4: Drop it from the worker protocol**

In `src/pdf/annotationWriterProtocol.ts`, delete the `prunedBytes` field and its comment block from `OpenedOk`.

In `src/pdf/annotationWriter.worker.ts`, simplify the `open` reply — the transfer list no longer needs a conditional:

```ts
			reply(
				{
					type: 'opened',
					requestId: message.requestId,
					ok: true,
					savedAnnotations: opened.savedAnnotations,
					displayBytes: opened.displayBytes,
				},
				[opened.displayBytes],
			);
```

- [ ] **Step 5: Drop it from the client and the view**

In `src/pdf/annotationWriterClient.ts`, remove `prunedBytes` from the exported
`OpenResult` interface and from the object literal in the
`message.type === 'opened'` branch of `handleMessage`. Those are the only two
sites; `tsc` will confirm.

In `src/pdfView.ts`, delete the `prunedBytes` local declaration, its assignment in the `try` block, and the whole `if (prunedBytes) { ... }` block with its comment (around line 462-470).

- [ ] **Step 6: Verify**

Run: `npm run build && npm run lint && npm test`
Expected: all pass, no remaining reference to `prunedBytes`.

Run: `grep -rn "prunedBytes" src/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "Never write to a PDF just because it was opened

Opening a file that had orphaned annotation objects rewrote it on the
spot, fire-and-forget. A book the user only read got a full pdf-lib round
trip and, under LiveSync, a full re-replication, with no user action
behind it. The prune still happens in memory; the next save that was
going to happen anyway carries it. Opening also stops paying for a whole
extra save()."
```

---

### Task 4: Scale the save interval to the file's size

`MAX_WRITE_INTERVAL_MS` is a flat 5000. Continuous handwriting therefore rewrites and re-replicates the entire PDF every five seconds — for a 40 MB textbook, hundreds of megabytes of churn per study session.

The trade is explicit: a crash now loses up to one interval of ink instead of five seconds. Task 7 makes a crash lose only recent strokes rather than damaging the file, which is what makes the longer interval acceptable.

**Files:**
- Create: `tests/pdf/saveCadence.test.ts`
- Create: `src/pdf/saveCadence.ts`
- Modify: `src/pdfView.ts` (the `MAX_WRITE_INTERVAL_MS` constant and its two uses in `markPageDirty`, plus `onLoadFile`)

**Interfaces:**
- Consumes: nothing.
- Produces: `maxWriteIntervalMs(fileSizeBytes: number): number` exported from `src/pdf/saveCadence.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/saveCadence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { maxWriteIntervalMs } from '../../src/pdf/saveCadence';

const MB = 1024 * 1024;

describe('maxWriteIntervalMs', () => {
	it('saves a small note often', () => {
		expect(maxWriteIntervalMs(0)).toBe(10_000);
		expect(maxWriteIntervalMs(4 * MB)).toBe(10_000);
	});

	it('backs off for a mid-sized document', () => {
		expect(maxWriteIntervalMs(5 * MB)).toBe(30_000);
		expect(maxWriteIntervalMs(25 * MB)).toBe(30_000);
	});

	it('backs off further for a large textbook', () => {
		expect(maxWriteIntervalMs(26 * MB)).toBe(60_000);
		expect(maxWriteIntervalMs(400 * MB)).toBe(60_000);
	});

	it('treats an unknown size as small rather than stalling saves', () => {
		// file.stat.size should always be there, but a missing or nonsense
		// value must not silently push a note to minute-long saves.
		expect(maxWriteIntervalMs(Number.NaN)).toBe(10_000);
		expect(maxWriteIntervalMs(-1)).toBe(10_000);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/pdf/saveCadence.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/saveCadence`.

- [ ] **Step 3: Write the implementation**

Create `src/pdf/saveCadence.ts`:

```ts
// A ceiling on how long continuous handwriting can go without a save.
//
// pdf-lib has no incremental save: every write re-serializes the entire
// document, and in a live-replicating vault that means re-uploading the
// whole binary too. A flat five-second ceiling meant a 40 MB textbook was
// rewritten and re-replicated twelve times a minute for as long as the user
// kept writing.
//
// Scaling by size puts the cost where it belongs. The trade is that a crash
// loses up to one interval of ink rather than five seconds of it — bounded
// by the fact that a crash mid-write can no longer damage the file itself
// (see src/vaultWrite.ts), only lose strokes not yet committed.
//
// The trailing debounce (WRITE_DEBOUNCE_MS in src/pdfView.ts) is unchanged:
// a natural pause still saves promptly at any file size. This only governs
// the case where the user never pauses.
export function maxWriteIntervalMs(fileSizeBytes: number): number {
	const MB = 1024 * 1024;
	// A size we can't read is treated as small: erring toward saving more
	// often risks bandwidth, erring the other way risks the user's ink.
	if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 5 * MB) return 10_000;
	if (fileSizeBytes <= 25 * MB) return 30_000;
	return 60_000;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/pdf/saveCadence.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the view**

In `src/pdfView.ts`:

Delete the `MAX_WRITE_INTERVAL_MS` constant and its comment block (around lines 44-52), and add the import:

```ts
import { maxWriteIntervalMs } from './pdf/saveCadence';
```

Add a field beside the other write-scheduling state:

```ts
	// The ceiling for this file specifically — see pdf/saveCadence.ts. Set
	// on load from the file's size; the default covers the window before a
	// file is open.
	private maxWriteInterval = maxWriteIntervalMs(0);
```

In `onLoadFile`, set it as soon as the file is known — put this immediately before the `const bytes = await this.app.vault.readBinary(file);` line:

```ts
		this.maxWriteInterval = maxWriteIntervalMs(file.stat.size);
```

In `markPageDirty`, replace the constant with the field:

```ts
		if (this.maxWaitHandle === null) {
			this.maxWaitHandle = window.setTimeout(() => this.flushCurrentFileIfAny(), this.maxWriteInterval);
		}
```

- [ ] **Step 6: Verify**

Run: `npm run build && npm run lint && npm test`
Expected: all pass.

Run: `grep -n "MAX_WRITE_INTERVAL_MS" src/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "Scale the save ceiling to the file's size

Continuous handwriting rewrote the whole PDF every five seconds. pdf-lib
has no incremental save, so on a 40 MB textbook that is the entire binary
re-serialized and, under LiveSync, re-replicated, twelve times a minute.
Ten seconds under 5 MB, thirty up to 25 MB, sixty above. The trailing
debounce is untouched, so a natural pause still saves promptly."
```

---

### Task 5: A structural fingerprint of a PDF document

The verification primitive. Captures everything about a document that Inkling must *not* change, so that a save which changes any of it can be caught and refused. Deliberately excludes Inkling's own annotations, which are exactly what a save is supposed to change.

**Files:**
- Create: `tests/pdf/fingerprint.test.ts`
- Create: `src/pdf/fingerprint.ts`
- Modify: `src/pdf/annotationSync.ts` (export `isInklingAnnotationDict`, use it at its two existing call sites)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isInklingAnnotationDict(dict: PDFDict): boolean` from `src/pdf/annotationSync.ts`
  - `interface PageFingerprint { mediaBox: string; contentLength: number; fontCount: number; xObjectCount: number; foreignAnnotations: string[] }`
  - `interface DocumentFingerprint { pageCount: number; keywords: string; pages: PageFingerprint[] }`
  - `fingerprintDocument(doc: PDFDocument): DocumentFingerprint`
  - `compareFingerprints(before: DocumentFingerprint, after: DocumentFingerprint): string | null` — returns a human-readable description of the first difference, or `null` when identical.

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/fingerprint.test.ts`:

```ts
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { compareFingerprints, fingerprintDocument } from '../../src/pdf/fingerprint';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { Annotation } from '../../src/annotate/types';

async function sampleDoc(): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	page.drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	doc.addPage([612, 792]);
	doc.setKeywords(['inkling:template=lined']);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

const stroke: Annotation = {
	id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#000000', width: 3,
	points: [{ x: 10, y: 10 }, { x: 100, y: 100 }],
};

describe('fingerprintDocument', () => {
	it('is stable across a save and reload with no edits', async () => {
		// The load-bearing property. If this fails, verification would refuse
		// every save, so the fingerprint is measuring something pdf-lib
		// legitimately re-encodes and that field must be dropped.
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		const after = fingerprintDocument(await reload(doc));
		expect(compareFingerprints(before, after)).toBeNull();
	});

	it('is stable across several consecutive round trips', async () => {
		let current = await sampleDoc();
		const first = fingerprintDocument(current);
		for (let pass = 0; pass < 3; pass++) {
			current = await reload(current);
			expect(compareFingerprints(first, fingerprintDocument(current))).toBeNull();
		}
	});

	it('ignores Inkling's own annotations being added', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		writeInklingAnnotations(doc, 0, [stroke]);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toBeNull();
	});

	it('notices a foreign annotation disappearing', async () => {
		const doc = await sampleDoc();
		const page = doc.getPage(0);
		page.node.addAnnot(doc.context.register(doc.context.obj({
			Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 60], F: 4,
		})));
		const before = fingerprintDocument(doc);

		const stripped = await sampleDoc();
		expect(compareFingerprints(before, fingerprintDocument(stripped))).toMatch(/foreign annotations/);
	});

	it('notices a page disappearing', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		doc.removePage(1);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/page count/);
	});

	it('notices page content being replaced', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		const font = await doc.embedFont(StandardFonts.Helvetica);
		doc.getPage(0).drawText('vandalism', { x: 72, y: 100, size: 12, font });
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/content stream/);
	});

	it('notices the template keyword being lost', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		doc.setKeywords([]);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/keywords/);
	});

	it('notices a page being resized', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		doc.getPage(0).setSize(400, 400);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/media box/);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/pdf/fingerprint.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/fingerprint`.

- [ ] **Step 3: Export the Inkling-annotation check**

In `src/pdf/annotationSync.ts`, add this just below the `ID_PREFIX` constant:

```ts
// Whether an annotation dict is one of ours, by the `/NM` tag every write
// applies. Exported because verification needs the same answer (see
// src/pdf/fingerprint.ts): a fingerprint has to exclude exactly the
// annotations a save is allowed to change, and "exactly" means one
// definition, not two that can drift apart.
export function isInklingAnnotationDict(dict: PDFDict): boolean {
	try {
		return dict.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText()?.startsWith(ID_PREFIX) ?? false;
	} catch {
		// Malformed annotation dict — not ours, and not something to crash on.
		return false;
	}
}
```

Then use it at the two places that currently inline the same check. In `removeInklingAnnotations`:

```ts
		try {
			const dict = pdfDoc.context.lookupMaybe(entry, PDFDict);
			if (dict && isInklingAnnotationDict(dict)) toRemove.push(entry);
		} catch {
			// Malformed annotation dict — leave it alone rather than crash.
		}
```

and in `pruneOrphanedInklingAnnotations`, replace the `nm` lookup and its `try`/`catch` with:

```ts
		if (linked.has(ref) || !(object instanceof PDFDict)) continue;
		if (!isInklingAnnotationDict(object)) continue;
		deleteAnnotationObjects(pdfDoc, ref);
		prunedAny = true;
```

- [ ] **Step 4: Write the fingerprint module**

Create `src/pdf/fingerprint.ts`:

```ts
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { isInklingAnnotationDict } from './annotationSync';

// A structural summary of everything a save must leave alone.
//
// pdf-lib is pinned at 1.17.1, its last release, and upstream is dormant.
// Its save() is a full re-serialize from its own object model, so anything
// that model doesn't represent faithfully is re-encoded from an incomplete
// picture. The failure that matters isn't a crash — it's a file that still
// opens, with something quietly missing, discovered months later. This is
// what makes that failure loud at the moment it happens.
//
// Deliberately excluded: Inkling's own annotations, which every save is
// supposed to change. Everything else — page geometry, page content, the
// resources content refers to, other software's annotations, and the
// Keywords field carrying a handwritten note's template style — must come
// back identical.
//
// Every field here has to survive a pdf-lib round trip unchanged, or
// verification would refuse legitimate saves. That property is what
// tests/pdf/fingerprint.test.ts pins down first.

export interface PageFingerprint {
	mediaBox: string;
	contentLength: number;
	fontCount: number;
	xObjectCount: number;
	foreignAnnotations: string[];
}

export interface DocumentFingerprint {
	pageCount: number;
	keywords: string;
	pages: PageFingerprint[];
}

function streamLength(value: unknown): number {
	// A stream pdf-lib parsed but never decoded keeps its original bytes,
	// which is the strongest thing to compare; one it built itself reports
	// its own size.
	if (value instanceof PDFRawStream) return value.contents.length;
	if (value instanceof PDFStream) return value.getContentsSize();
	return 0;
}

function contentLength(page: PDFPage): number {
	// Typed as unknown so the instanceof checks below do the narrowing —
	// /Contents is legally either one stream or an array of them.
	const contents: unknown = page.node.Contents();
	if (contents instanceof PDFArray) {
		let total = 0;
		for (let index = 0; index < contents.size(); index++) total += streamLength(contents.lookup(index));
		return total;
	}
	return streamLength(contents);
}

function resourceCount(page: PDFPage, key: string): number {
	const resources = page.node.Resources();
	if (!resources) return 0;
	return resources.lookupMaybe(PDFName.of(key), PDFDict)?.keys().length ?? 0;
}

function rectangle(dict: PDFDict): string {
	const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
	if (!rect) return '';
	const parts: string[] = [];
	for (let index = 0; index < rect.size(); index++) {
		const value = rect.lookupMaybe(index, PDFNumber);
		parts.push(value ? value.asNumber().toFixed(2) : '?');
	}
	return parts.join(',');
}

// Sorted, because /Annots order is not something we promise to preserve —
// removing and re-adding our own annotations legitimately reshuffles the
// array around the foreign ones left in place.
function foreignAnnotations(doc: PDFDocument, page: PDFPage): string[] {
	const annots = page.node.Annots();
	if (!annots) return [];

	const found: string[] = [];
	for (const entry of annots.asArray()) {
		let dict: PDFDict | undefined;
		try {
			if (entry instanceof PDFRef) dict = doc.context.lookupMaybe(entry, PDFDict);
			else if (entry instanceof PDFDict) dict = entry;
		} catch {
			// Unresolvable entry. Recorded as such rather than skipped, so
			// one appearing or vanishing still counts as a change.
			found.push('unresolvable');
			continue;
		}
		if (!dict || isInklingAnnotationDict(dict)) continue;
		const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? 'unknown';
		found.push(`${subtype}[${rectangle(dict)}]`);
	}
	return found.sort();
}

export function fingerprintDocument(doc: PDFDocument): DocumentFingerprint {
	const pages = doc.getPages().map((page): PageFingerprint => {
		const box = page.getMediaBox();
		return {
			mediaBox: `${box.x.toFixed(2)},${box.y.toFixed(2)},${box.width.toFixed(2)},${box.height.toFixed(2)}`,
			contentLength: contentLength(page),
			fontCount: resourceCount(page, 'Font'),
			xObjectCount: resourceCount(page, 'XObject'),
			foreignAnnotations: foreignAnnotations(doc, page),
		};
	});

	return {
		pageCount: pages.length,
		// Carries a handwritten note's template style (inkling:template=...),
		// which "Add page" reads back — losing it silently breaks that.
		keywords: doc.getKeywords() ?? '',
		pages,
	};
}

// The first difference found, phrased for a log line and a notice, or null
// when the two are identical. First rather than all: the caller's only
// decision is whether to write, and one confirmed change already answers it.
export function compareFingerprints(before: DocumentFingerprint, after: DocumentFingerprint): string | null {
	if (before.pageCount !== after.pageCount) {
		return `page count changed from ${before.pageCount} to ${after.pageCount}`;
	}
	if (before.keywords !== after.keywords) {
		return `document keywords changed from "${before.keywords}" to "${after.keywords}"`;
	}

	for (let index = 0; index < before.pages.length; index++) {
		const wasPage = before.pages[index];
		const nowPage = after.pages[index];
		const number = index + 1;
		if (!wasPage || !nowPage) return `page ${number} is missing`;
		if (wasPage.mediaBox !== nowPage.mediaBox) {
			return `page ${number} media box changed from ${wasPage.mediaBox} to ${nowPage.mediaBox}`;
		}
		if (wasPage.contentLength !== nowPage.contentLength) {
			return `page ${number} content stream length changed from ${wasPage.contentLength} to ${nowPage.contentLength}`;
		}
		if (wasPage.fontCount !== nowPage.fontCount) {
			return `page ${number} font count changed from ${wasPage.fontCount} to ${nowPage.fontCount}`;
		}
		if (wasPage.xObjectCount !== nowPage.xObjectCount) {
			return `page ${number} XObject count changed from ${wasPage.xObjectCount} to ${nowPage.xObjectCount}`;
		}
		if (wasPage.foreignAnnotations.join('|') !== nowPage.foreignAnnotations.join('|')) {
			return `page ${number} annotations from other software changed`;
		}
	}

	return null;
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/pdf/fingerprint.test.ts`
Expected: PASS.

**If the first two tests fail** ("stable across a save and reload"), a field is measuring something `pdf-lib` legitimately re-encodes. `contentLength` is the likeliest culprit, since a stream pdf-lib decompresses and re-emits changes size. Do not loosen the comparison to make the test pass — instead drop the offending field from `PageFingerprint`, `fingerprintDocument`, and `compareFingerprints`, delete the test that asserts on it, and note the removal in the commit message. A fingerprint with four honest fields is worth more than five that force it to be ignored.

- [ ] **Step 6: Verify everything**

Run: `npm run build && npm run lint && npm test`
Expected: all pass, including the Task 3 round-trip suite, which exercises the refactored `isInklingAnnotationDict` call sites.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "Add a structural fingerprint of a PDF document

Captures what a save must leave alone — page geometry, content stream
sizes, the resources content refers to, other software's annotations, and
the Keywords field carrying a handwritten note's template — while
excluding Inkling's own annotations, which are what a save changes.

Round-trip stability is the load-bearing property and the first thing the
tests pin down: a fingerprint that drifts on its own would refuse every
legitimate save."
```

---

### Task 6: Verify every save before it leaves the worker

**Files:**
- Modify: `src/pdf/annotationWriterCore.ts` (`writeDocument`)
- Modify: `tests/pdf/fingerprint.test.ts` (add a `writeDocument` suite, or create `tests/pdf/writeDocument.test.ts`)

**Interfaces:**
- Consumes: `fingerprintDocument`, `compareFingerprints` from Task 5. `writeDocument(doc: PDFDocument, pages: { pageNumber: number; annotations: Annotation[] }[]): Promise<ArrayBuffer>` keeps its existing signature.
- Produces: `writeDocument` now rejects rather than resolving when verification fails. `pdfView.flushAnnotations` already catches, notices, and re-marks pages dirty — no change needed there.

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/writeDocument.test.ts`:

```ts
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { openDocument, writeDocument } from '../../src/pdf/annotationWriterCore';
import { toArrayBuffer } from '../../src/binary';
import type { Annotation } from '../../src/annotate/types';

const stroke: Annotation = {
	id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#e03131', width: 4,
	points: [{ x: 10, y: 10 }, { x: 100, y: 100 }],
};

async function sampleBytes(): Promise<ArrayBuffer> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	doc.setKeywords(['inkling:template=lined']);
	return toArrayBuffer(await doc.save());
}

describe('writeDocument', () => {
	it('writes annotations and returns bytes that reload', async () => {
		const opened = await openDocument(await sampleBytes());
		const bytes = await writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }]);

		const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
		expect(reloaded.getPageCount()).toBe(1);
		expect(reloaded.getKeywords()).toBe('inkling:template=lined');
	});

	it('allows a structural change the caller made on purpose', async () => {
		const opened = await openDocument(await sampleBytes());

		// The boundary the guard has to get right. Verification compares the
		// produced bytes against the document as it stood *after* the
		// caller's edits, not against the file as it was opened — so adding
		// a page (which "Add page" genuinely does) has to pass. Fingerprint
		// the original instead and every legitimate page insert is refused.
		opened.doc.addPage([612, 792]);
		const bytes = await writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }]);
		const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
		expect(reloaded.getPageCount()).toBe(2);
	});

	it('rejects instead of returning bytes when the reparse disagrees', async () => {
		const opened = await openDocument(await sampleBytes());

		// The fault this guard exists for is one we cannot trigger on
		// demand: pdf-lib emitting bytes that reparse into a structurally
		// different document. Intercepting the verification reparse and
		// handing it a document with a page missing is the only honest way
		// to exercise the guard itself rather than something adjacent to it.
		const realLoad = PDFDocument.load.bind(PDFDocument);
		const spy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (source: never, options: never) => {
			const parsed = await realLoad(source, options);
			parsed.removePage(0);
			return parsed;
		});
		try {
			await expect(writeDocument(opened.doc, [{ pageNumber: 1, annotations: [stroke] }]))
				.rejects.toThrow(/page count/);
		} finally {
			spy.mockRestore();
		}
	});
});
```

- [ ] **Step 2: Run it to verify the third case fails**

Run: `npm test -- tests/pdf/writeDocument.test.ts`
Expected: the first two tests PASS and the third FAILS — today `writeDocument` never reparses, so the mocked `load` is never called and it resolves happily. That specific failure is the point: it proves the test is reaching the guard rather than tripping over something else.

- [ ] **Step 3: Add verification to `writeDocument`**

In `src/pdf/annotationWriterCore.ts`, add the import:

```ts
import { compareFingerprints, fingerprintDocument } from './fingerprint';
```

and replace `writeDocument` with:

```ts
export async function writeDocument(
	doc: PDFDocument,
	pages: { pageNumber: number; annotations: Annotation[] }[],
): Promise<ArrayBuffer> {
	for (const { pageNumber, annotations } of pages) {
		writeInklingAnnotations(doc, pageNumber - 1, annotations);
	}

	// Fingerprinted *after* the mutation, because the mutated document is
	// the intended result — the thing the produced bytes are supposed to
	// equal. Our own annotations are excluded from the fingerprint, so
	// having just rewritten them doesn't register as a change.
	const intended = fingerprintDocument(doc);
	const bytes = await doc.save();

	// The check that makes a silent pdf-lib fault loud. Reparsing the bytes
	// we are about to hand back costs a full parse per save, which is real
	// work — it is why this lives in the writer worker and why the save
	// cadence is scaled to file size (see pdf/saveCadence.ts). The
	// alternative is a book quietly losing structure with nobody noticing
	// for months.
	//
	// updateMetadata: false because this parse is read-only; letting it
	// stamp a new ModDate would make the verification copy differ from the
	// bytes actually being written.
	const written = await PDFDocument.load(bytes, { updateMetadata: false });
	const difference = compareFingerprints(intended, fingerprintDocument(written));
	if (difference) {
		throw new Error(`Inkling: refusing to save, the PDF changed unexpectedly (${difference}).`);
	}

	return toArrayBuffer(bytes);
}
```

Add `PDFDocument` to the existing `pdf-lib` import if it is only imported as a type there.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 5: Confirm the failure path in the view needs no change**

Read `flushAnnotations` in `src/pdfView.ts` (around line 936). Confirm its `catch` already: logs, shows the "could not save annotations to this file" notice, and re-adds every page number to `dirtyPages`. It does — a rejection from `writeDocument` propagates through `writer.write()` into that catch, the file is never touched because `modifyBinary` is never reached, and the work stays pending for the next save. **No edit needed.** Do not add a second layer of handling.

- [ ] **Step 6: Verify**

Run: `npm run build && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "Verify every save before its bytes leave the writer

Reparse what pdf-lib produced and compare its structure against the
document we meant to write. Any change outside our own annotations —
a page, page geometry, content stream size, resource counts, another
tool's annotations, the template keyword — and the save is refused, the
file on disk is left alone, and the pages stay dirty for the next
attempt. A silent structural loss becomes a loud refusal at the moment
it happens."
```

---

### Task 7: Write binaries through a scratch file

**Files:**
- Create: `tests/vaultWrite.test.ts`
- Create: `src/vaultWrite.ts`
- Modify: `src/pdfView.ts` (the two `vault.modifyBinary` calls, in `flushAnnotations` and `addPage`)
- Modify: `src/main.ts` (scratch cleanup on load)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SCRATCH_DIR: string` (value `'.inkling-scratch'`)
  - `writeBinarySafely(adapter: DataAdapter, path: string, bytes: ArrayBuffer): Promise<void>`
  - `cleanScratch(adapter: DataAdapter): Promise<void>`

- [ ] **Step 1: Run the spike before writing anything**

This is the plan's one genuine unknown, and it decides the shape of the rest of the task. Build the plugin with a temporary command that runs, in order: `adapter.mkdir('.inkling-scratch')`, `adapter.writeBinary('.inkling-scratch/probe.bin', someBytes)`, `adapter.exists`, `adapter.readBinary`, `adapter.rename` into the vault tree, then `adapter.remove`.

Confirm on **desktop and a real Android device**:

1. Each call succeeds inside a dot-folder.
2. `rename` from the dot-folder to a normal vault path works and the renamed file appears in Obsidian's file explorer.
3. LiveSync does not replicate `.inkling-scratch/` under its default configuration.

**If rename does not work, or LiveSync walks the folder:** stop and implement the fallback the spec names — keep the verification (Task 6 already provides it) and call `vault.modifyBinary` directly, dropping only the interrupted-write protection. Record which of the three checks failed in the commit message, and skip to Task 8. Do not invent a third approach without checking in.

Delete the probe command before continuing.

- [ ] **Step 2: Write the failing test**

Create `tests/vaultWrite.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SCRATCH_DIR, cleanScratch, writeBinarySafely } from '../src/vaultWrite';

// A stand-in for Obsidian's DataAdapter with just the surface vaultWrite
// touches. Only the methods used are declared, so the fake can't silently
// drift from a wider interface it never exercises.
interface FakeAdapter {
	files: Map<string, ArrayBuffer>;
	dirs: Set<string>;
	mkdir(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

function fakeAdapter(): FakeAdapter {
	const files = new Map<string, ArrayBuffer>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		mkdir: async (path) => { dirs.add(path); },
		exists: async (path) => files.has(path) || dirs.has(path),
		writeBinary: async (path, data) => { files.set(path, data); },
		readBinary: async (path) => {
			const found = files.get(path);
			if (!found) throw new Error(`no such file: ${path}`);
			return found;
		},
		remove: async (path) => { files.delete(path); },
		rename: async (from, to) => {
			const found = files.get(from);
			if (!found) throw new Error(`no such file: ${from}`);
			files.set(to, found);
			files.delete(from);
		},
		list: async () => ({ files: [...files.keys()].filter((p) => p.startsWith(`${SCRATCH_DIR}/`)), folders: [] }),
	};
}

function bytes(...values: number[]): ArrayBuffer {
	return new Uint8Array(values).buffer;
}

describe('writeBinarySafely', () => {
	it('replaces the target with the new content', async () => {
		const adapter = fakeAdapter();
		adapter.files.set('book.pdf', bytes(1, 2, 3));

		await writeBinarySafely(adapter as never, 'book.pdf', bytes(9, 9, 9, 9));

		expect(new Uint8Array(adapter.files.get('book.pdf') ?? new ArrayBuffer(0))).toEqual(new Uint8Array([9, 9, 9, 9]));
	});

	it('leaves no scratch file behind on success', async () => {
		const adapter = fakeAdapter();
		adapter.files.set('book.pdf', bytes(1));
		await writeBinarySafely(adapter as never, 'book.pdf', bytes(2));
		expect([...adapter.files.keys()].filter((p) => p.startsWith(SCRATCH_DIR))).toEqual([]);
	});

	it('leaves the original intact and cleans up when the scratch write fails', async () => {
		const adapter = fakeAdapter();
		adapter.files.set('book.pdf', bytes(1, 2, 3));
		adapter.writeBinary = vi.fn(async () => { throw new Error('disk full'); });

		await expect(writeBinarySafely(adapter as never, 'book.pdf', bytes(9))).rejects.toThrow('disk full');
		expect(new Uint8Array(adapter.files.get('book.pdf') ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('leaves the original intact when the scratch file reads back short', async () => {
		// The truncation case this whole helper exists for: bytes that went
		// out are not the bytes that landed.
		const adapter = fakeAdapter();
		adapter.files.set('book.pdf', bytes(1, 2, 3));
		const realWrite = adapter.writeBinary;
		adapter.writeBinary = async (path, data) => {
			await realWrite(path, path.startsWith(SCRATCH_DIR) ? bytes(9) : data);
		};

		await expect(writeBinarySafely(adapter as never, 'book.pdf', bytes(9, 9, 9, 9))).rejects.toThrow(/incomplete/i);
		expect(new Uint8Array(adapter.files.get('book.pdf') ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3]));
		expect([...adapter.files.keys()].filter((p) => p.startsWith(SCRATCH_DIR))).toEqual([]);
	});

	it('gives concurrent writes distinct scratch paths', async () => {
		const adapter = fakeAdapter();
		const seen: string[] = [];
		const realWrite = adapter.writeBinary;
		adapter.writeBinary = async (path, data) => {
			if (path.startsWith(SCRATCH_DIR)) seen.push(path);
			await realWrite(path, data);
		};

		await Promise.all([
			writeBinarySafely(adapter as never, 'a.pdf', bytes(1)),
			writeBinarySafely(adapter as never, 'b.pdf', bytes(2)),
		]);
		expect(new Set(seen).size).toBe(2);
	});
});

describe('cleanScratch', () => {
	it('removes leftovers from a killed session', async () => {
		const adapter = fakeAdapter();
		adapter.files.set(`${SCRATCH_DIR}/stale-1.tmp`, bytes(1));
		adapter.files.set(`${SCRATCH_DIR}/stale-2.tmp`, bytes(2));
		adapter.files.set('book.pdf', bytes(3));

		await cleanScratch(adapter as never);

		expect(adapter.files.has(`${SCRATCH_DIR}/stale-1.tmp`)).toBe(false);
		expect(adapter.files.has('book.pdf')).toBe(true);
	});

	it('is quiet when the folder was never created', async () => {
		const adapter = fakeAdapter();
		adapter.list = vi.fn(async () => { throw new Error('ENOENT'); });
		await expect(cleanScratch(adapter as never)).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- tests/vaultWrite.test.ts`
Expected: FAIL — cannot resolve `../src/vaultWrite`.

- [ ] **Step 4: Write the implementation**

Create `src/vaultWrite.ts`:

```ts
import type { DataAdapter } from 'obsidian';

// Where in-progress writes are staged. A dot-folder on purpose: the vault
// syncs through Self-hosted LiveSync, which walks the vault tree and would
// otherwise replicate a full copy of every in-progress save and then
// replicate its deletion a moment later. Dot-prefixed paths are outside
// that walk under a default configuration.
//
// Written through vault.adapter rather than the Vault API because dot-
// folders are not indexed as TFiles, so vault.createBinary cannot address
// them at all.
export const SCRATCH_DIR = '.inkling-scratch';

let counter = 0;

function scratchPathFor(path: string): string {
	// Unique per call, not derived from the target: two saves of different
	// files can overlap, and a shared scratch path would have one write
	// clobbering the other's staged bytes mid-flight.
	counter += 1;
	const stamp = `${Date.now().toString(36)}-${counter.toString(36)}`;
	return `${SCRATCH_DIR}/${stamp}.tmp`;
}

// Replaces `path` with `bytes` without ever leaving it partially written.
//
// vault.modifyBinary writes the target in place, and neither platform
// guarantees that is atomic — an app killed mid-write (which mobile OSes do
// aggressively, and Inkling saves on a timer while the user is writing)
// leaves a truncated PDF where a textbook used to be. Staging the bytes
// somewhere disposable, confirming they landed whole, and only then moving
// them into place means an interruption costs the scratch file and nothing
// else.
export async function writeBinarySafely(adapter: DataAdapter, path: string, bytes: ArrayBuffer): Promise<void> {
	const scratch = scratchPathFor(path);

	if (!(await adapter.exists(SCRATCH_DIR))) await adapter.mkdir(SCRATCH_DIR);

	try {
		await adapter.writeBinary(scratch, bytes);

		// Read back before committing. A short write is exactly the failure
		// this guards, and it does not necessarily raise on the way out.
		const written = await adapter.readBinary(scratch);
		if (written.byteLength !== bytes.byteLength) {
			throw new Error(
				`Inkling: staged write was incomplete (${written.byteLength} of ${bytes.byteLength} bytes) — the file was left unchanged.`,
			);
		}

		// remove-then-rename rather than rename-over: adapter.rename onto an
		// existing path is not documented to replace it, and the window
		// between the two is short and recoverable — the bytes still exist
		// in the scratch file, and a failure here leaves them there for the
		// cleanup on next load.
		if (await adapter.exists(path)) await adapter.remove(path);
		await adapter.rename(scratch, path);
	} catch (error) {
		// Best-effort: the scratch file is disposable, and failing to tidy it
		// must not mask the real error above.
		try {
			if (await adapter.exists(scratch)) await adapter.remove(scratch);
		} catch {
			// Cleaned up on next load instead — see cleanScratch.
		}
		throw error;
	}
}

// Clears staged writes left by a session that was killed between staging
// and committing. Called once on plugin load; quiet when there is nothing
// there, which is the normal case.
export async function cleanScratch(adapter: DataAdapter): Promise<void> {
	try {
		const listing = await adapter.list(SCRATCH_DIR);
		for (const file of listing.files) await adapter.remove(file);
	} catch {
		// The folder has never been created, or cannot be listed. Nothing to
		// do either way, and nothing worth telling the user about.
	}
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/vaultWrite.test.ts`
Expected: PASS.

- [ ] **Step 6: Route the view's writes through it**

In `src/pdfView.ts`, add the import:

```ts
import { writeBinarySafely } from './vaultWrite';
```

In `flushAnnotations`, replace:

```ts
			await this.app.vault.modifyBinary(file, updatedBytes);
```

with:

```ts
			await writeBinarySafely(this.app.vault.adapter, file.path, updatedBytes);
```

In `addPage`, replace:

```ts
			await this.app.vault.modifyBinary(file, toArrayBuffer(updatedBytes));
```

with:

```ts
			await writeBinarySafely(this.app.vault.adapter, file.path, toArrayBuffer(updatedBytes));
```

- [ ] **Step 7: Clean scratch on plugin load**

In `src/main.ts`, add the import:

```ts
import { cleanScratch } from './vaultWrite';
```

and at the end of `onload()`:

```ts
		// Staged writes from a session that was killed between staging and
		// committing. Not awaited: nothing else depends on it, and a slow
		// vault must not hold up the plugin loading.
		void cleanScratch(this.app.vault.adapter);
```

- [ ] **Step 8: Verify**

Run: `npm run build && npm run lint && npm test`
Expected: all pass.

Run: `grep -n "modifyBinary" src/`
Expected: no output.

- [ ] **Step 9: Real-device check**

Build into the test vault. Annotate a PDF, confirm the ink saves and survives a close and reopen. Add a page to a handwritten note and confirm the same. Confirm `.inkling-scratch/` is empty between saves and that LiveSync has not replicated it.

- [ ] **Step 10: Commit**

```bash
git add src/ tests/
git commit -m "Stage binary writes before committing them

vault.modifyBinary writes the target in place and neither platform
guarantees that is atomic. Inkling saves on a timer while the user is
writing, and mobile kills backgrounded apps freely, so an interrupted
save could leave a truncated PDF where a textbook used to be. Bytes are
now staged in a dot-folder, read back to confirm they landed whole, and
only then moved into place; an interruption costs the scratch file and
nothing else.

The folder is dot-prefixed so LiveSync's walk skips it — a staged copy of
every save replicating to CouchDB and then replicating its own deletion
would be worse than the problem."
```

---

### Task 8: A structure profile both parsers can produce

The open gate needs one shape that `pdf-lib` and `pdf.js` can each fill in independently, plus detection of the document features `pdf-lib` is known to round-trip badly.

**Files:**
- Create: `tests/pdf/compatibility.test.ts`
- Create: `src/pdf/compatibility.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface PageProfile { mediaBox: string; rotation: number; annotationCount: number }`
  - `interface StructureProfile { pageCount: number; sampledPages: { index: number; page: PageProfile }[] }`
  - `samplePageIndices(pageCount: number, limit?: number): number[]` — default `limit` 10
  - `profileFromPdfLib(doc: PDFDocument): StructureProfile`
  - `riskyFeatures(doc: PDFDocument): string[]` — human-readable names, empty when none
  - `compareProfiles(fromPdfLib: StructureProfile, fromPdfJs: StructureProfile): string | null`
  - `formatMediaBox(x: number, y: number, width: number, height: number): string` — used by both sides so they format identically

- [ ] **Step 1: Write the failing test**

Create `tests/pdf/compatibility.test.ts`:

```ts
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
	compareProfiles,
	formatMediaBox,
	profileFromPdfLib,
	riskyFeatures,
	samplePageIndices,
	type StructureProfile,
} from '../../src/pdf/compatibility';

describe('samplePageIndices', () => {
	it('takes every page when the document is small', () => {
		expect(samplePageIndices(4)).toEqual([0, 1, 2, 3]);
	});

	it('caps the sample and always includes the first and last page', () => {
		const indices = samplePageIndices(900);
		expect(indices).toHaveLength(10);
		expect(indices[0]).toBe(0);
		expect(indices[indices.length - 1]).toBe(899);
	});

	it('returns strictly increasing, unique indices', () => {
		const indices = samplePageIndices(37);
		expect([...new Set(indices)]).toEqual(indices);
		expect([...indices].sort((a, b) => a - b)).toEqual(indices);
	});

	it('handles an empty document', () => {
		expect(samplePageIndices(0)).toEqual([]);
	});
});

describe('profileFromPdfLib', () => {
	it('reports page count, geometry, rotation, and annotation count', async () => {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		page.setRotation({ type: 'degrees', angle: 90 } as never);
		page.node.addAnnot(doc.context.register(doc.context.obj({
			Type: 'Annot', Subtype: 'Square', Rect: [1, 2, 3, 4], F: 4,
		})));

		const profile = profileFromPdfLib(doc);
		expect(profile.pageCount).toBe(1);
		expect(profile.sampledPages[0]?.page).toMatchObject({
			mediaBox: formatMediaBox(0, 0, 612, 792),
			rotation: 90,
			annotationCount: 1,
		});
	});
});

describe('compareProfiles', () => {
	function profile(pageCount: number, rotation = 0, annotationCount = 0): StructureProfile {
		return {
			pageCount,
			sampledPages: [{ index: 0, page: { mediaBox: formatMediaBox(0, 0, 612, 792), rotation, annotationCount } }],
		};
	}

	it('accepts two parsers that agree', () => {
		expect(compareProfiles(profile(10), profile(10))).toBeNull();
	});

	it('reports a page-count disagreement', () => {
		expect(compareProfiles(profile(10), profile(9))).toMatch(/page count/);
	});

	it('reports a rotation disagreement', () => {
		expect(compareProfiles(profile(1, 0), profile(1, 90))).toMatch(/rotation/);
	});

	it('reports an annotation-count disagreement', () => {
		expect(compareProfiles(profile(1, 0, 2), profile(1, 0, 5))).toMatch(/annotation/);
	});

	it('reports a page missing from one side's sample', () => {
		const short: StructureProfile = { pageCount: 1, sampledPages: [] };
		expect(compareProfiles(profile(1), short)).toMatch(/could not be read/);
	});
});

describe('riskyFeatures', () => {
	it('finds nothing in a plain document', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		expect(riskyFeatures(doc)).toEqual([]);
	});

	it('flags an interactive form', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		// getForm() creates the AcroForm dictionary on demand.
		doc.getForm().createTextField('a.field');
		expect(riskyFeatures(doc).join(' ')).toMatch(/form/i);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/pdf/compatibility.test.ts`
Expected: FAIL — cannot resolve `../../src/pdf/compatibility`.

- [ ] **Step 3: Write the implementation**

Create `src/pdf/compatibility.ts`:

```ts
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

// Whether pdf-lib understands a document well enough to be trusted to
// rewrite it.
//
// Save-time verification (see fingerprint.ts) compares a save against the
// in-memory document it came from — which cannot catch pdf-lib's *first*
// parse having already lost something, because by then the loss is inside
// the baseline being compared to. This closes that gap the only way
// available: a second, independent opinion. Inkling already parses every
// file twice on open, once with pdf.js to render and once with pdf-lib to
// read annotations, so the second opinion is already paid for.
//
// Both parsers fill in the same shape, and this compares them. Nothing here
// imports pdf.js — the view collects that side and passes it in — so this
// module stays testable without a renderer.

export interface PageProfile {
	mediaBox: string;
	rotation: number;
	annotationCount: number;
}

export interface StructureProfile {
	pageCount: number;
	sampledPages: { index: number; page: PageProfile }[];
}

const DEFAULT_SAMPLE_LIMIT = 10;

// Formatting lives here so both sides render the same numbers the same way.
// A textbook is not going to disagree between parsers by a hundredth of a
// point, and comparing raw floats would fail on representation alone.
export function formatMediaBox(x: number, y: number, width: number, height: number): string {
	return `${x.toFixed(2)},${y.toFixed(2)},${width.toFixed(2)},${height.toFixed(2)}`;
}

// Which pages to actually check. Page count is free on both sides, but
// everything else costs a pdf.js getPage call, and a 900-page textbook
// would spend a visible stretch of the file's open doing it. Evenly spread
// and always including the first and last page, since a document whose
// parsers disagree usually disagrees structurally rather than on one page
// in the middle.
export function samplePageIndices(pageCount: number, limit: number = DEFAULT_SAMPLE_LIMIT): number[] {
	if (pageCount <= 0) return [];
	if (pageCount <= limit) return Array.from({ length: pageCount }, (_, index) => index);

	const indices = new Set<number>();
	for (let step = 0; step < limit; step++) {
		indices.add(Math.round((step * (pageCount - 1)) / (limit - 1)));
	}
	return [...indices].sort((a, b) => a - b);
}

export function profileFromPdfLib(doc: PDFDocument): StructureProfile {
	const pageCount = doc.getPageCount();
	const sampledPages = samplePageIndices(pageCount).map((index) => {
		const page = doc.getPage(index);
		const box = page.getMediaBox();
		return {
			index,
			page: {
				mediaBox: formatMediaBox(box.x, box.y, box.width, box.height),
				// Normalized: pdf.js reports rotation in [0, 360), and a PDF
				// may legally carry a negative or over-full-turn /Rotate.
				rotation: ((page.getRotation().angle % 360) + 360) % 360,
				annotationCount: page.node.Annots()?.size() ?? 0,
			},
		};
	});

	return { pageCount, sampledPages };
}

// Structure pdf-lib is known to round-trip badly. Unlike a parser
// disagreement these are detectable directly, and they are the cases where
// a clean-looking save can still destroy something that matters: a form's
// field values, or a signature that a rewrite invalidates by definition.
//
// Encryption is absent from this list because PDFDocument.load throws on an
// encrypted file, so it never reaches here — it fails safe already.
export function riskyFeatures(doc: PDFDocument): string[] {
	const found: string[] = [];
	const catalog = doc.catalog;

	const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
	if (acroForm) {
		const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
		if (fields && fields.size() > 0) found.push('an interactive form');
		const sigFlags = acroForm.lookupMaybe(PDFName.of('SigFlags'), PDFNumber);
		if (sigFlags && sigFlags.asNumber() > 0) found.push('a digital signature');
	}

	return found;
}

// A disagreement between the two parsers, phrased for a notice, or null
// when they agree.
export function compareProfiles(fromPdfLib: StructureProfile, fromPdfJs: StructureProfile): string | null {
	if (fromPdfLib.pageCount !== fromPdfJs.pageCount) {
		return `the two PDF parsers disagree on page count (${fromPdfLib.pageCount} vs ${fromPdfJs.pageCount})`;
	}

	const byIndex = new Map(fromPdfJs.sampledPages.map((entry) => [entry.index, entry.page]));
	for (const { index, page } of fromPdfLib.sampledPages) {
		const other = byIndex.get(index);
		const number = index + 1;
		if (!other) return `page ${number} could not be read by both PDF parsers`;
		if (page.mediaBox !== other.mediaBox) {
			return `the two PDF parsers disagree on page ${number}'s size (${page.mediaBox} vs ${other.mediaBox})`;
		}
		if (page.rotation !== other.rotation) {
			return `the two PDF parsers disagree on page ${number}'s rotation (${page.rotation} vs ${other.rotation})`;
		}
		if (page.annotationCount !== other.annotationCount) {
			return `the two PDF parsers disagree on page ${number}'s annotation count (${page.annotationCount} vs ${other.annotationCount})`;
		}
	}

	return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/pdf/compatibility.test.ts`
Expected: PASS.

Note on the rotation test: `page.setRotation` takes a `Rotation` object and pdf-lib exports a `degrees()` helper. If the `as never` cast in the test trips the type checker, import `degrees` from `pdf-lib` and use `page.setRotation(degrees(90))` instead — that is the intended API and the cast is only there to avoid asserting an import that may differ by version.

- [ ] **Step 5: Verify**

Run: `npm run build && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/ tests/
git commit -m "Add a structure profile both PDF parsers can fill in

Save-time verification compares a save against the document it came from,
which cannot catch pdf-lib's first parse having already lost something.
This is the second opinion: one shape that pdf-lib and pdf.js each fill in
independently — page count, and sampled page geometry, rotation, and
annotation counts — plus detection of forms and signatures, which pdf-lib
is known to round-trip badly. Sampled to ten pages so a 900-page textbook
does not pay for a getPage call per page on open."
```

---

### Task 9: Open read-only when the document can't be safely edited

The last piece: run Task 8's gate on open and, when it fails, render the document without letting anyone draw on it.

**Files:**
- Modify: `src/annotate/controller.ts` (read-only state and input gating)
- Modify: `src/annotate/toolbar.ts` (disable controls when read-only)
- Modify: `src/pdf/annotationWriterCore.ts` (`OpenedDocument` gains `profile` and `risky`)
- Modify: `src/pdf/annotationWriterProtocol.ts` (`OpenedOk` gains the same)
- Modify: `src/pdf/annotationWriterClient.ts` (thread them through)
- Modify: `src/pdfView.ts` (collect the pdf.js side, compare, enter read-only, show a banner)
- Modify: `tests/annotate/toolState.test.ts` — no change; listed only to note it is unaffected
- Create: `tests/annotate/controllerReadOnly.test.ts`

**Interfaces:**
- Consumes: `compareProfiles`, `profileFromPdfLib`, `riskyFeatures`, `samplePageIndices`, `formatMediaBox`, `StructureProfile` from Task 8.
- Produces: `AnnotationController.setReadOnly(readOnly: boolean): void` and `AnnotationController.isReadOnly(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/annotate/controllerReadOnly.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AnnotationController } from '../../src/annotate/controller';

// The controller's page mounting needs canvases, but read-only state is
// plain bookkeeping that can be checked without one. Input gating itself is
// verified on a real device, since it depends on pointer plumbing this
// suite deliberately does not stand up.
describe('AnnotationController read-only state', () => {
	it('starts editable', () => {
		expect(new AnnotationController().isReadOnly()).toBe(false);
	});

	it('reports what it was set to', () => {
		const controller = new AnnotationController();
		controller.setReadOnly(true);
		expect(controller.isReadOnly()).toBe(true);
		controller.setReadOnly(false);
		expect(controller.isReadOnly()).toBe(false);
	});

	it('notifies subscribers so the toolbar can repaint', () => {
		const controller = new AnnotationController();
		let notifications = 0;
		controller.subscribe(() => { notifications += 1; });
		controller.setReadOnly(true);
		expect(notifications).toBeGreaterThan(0);
	});

	it('drops any selection when it becomes read-only', () => {
		const controller = new AnnotationController();
		controller.setReadOnly(true);
		expect(controller.hasSelection()).toBe(false);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/annotate/controllerReadOnly.test.ts`
Expected: FAIL — `setReadOnly` is not a function.

- [ ] **Step 3: Add read-only state to the controller**

In `src/annotate/controller.ts`, add a field beside `selection` and `drag`:

```ts
	// Set when the document cannot be safely written to (see
	// src/pdf/compatibility.ts). Every input path checks it, rather than the
	// view simply not attaching gestures, so the guard holds for pages
	// mounted later too — a book is rendered lazily, page by page, as it is
	// scrolled.
	private readOnly = false;
```

and these methods next to the other tool/style accessors:

```ts
	isReadOnly(): boolean {
		return this.readOnly;
	}

	setReadOnly(readOnly: boolean): void {
		if (readOnly === this.readOnly) return;
		this.readOnly = readOnly;
		if (readOnly) {
			// Nothing selected can be acted on any more, and a half-finished
			// gesture would commit on pointerup into a file we have decided
			// not to write.
			this.drag = null;
			this.selection = { pageNumber: -1, ids: new Set() };
			this.eraserCursor = null;
		}
		this.notify();
		this.redrawAllOverlay();
	}
```

Add the guard as the first line of all five gesture handlers — `handleHover`,
`handleStart`, `handleMove`, `handleEnd`, and `handleCancel`. They are the
complete set wired up in `getHandlersFor`, and `tsc` cannot catch a missed one,
so check each against that object:

```ts
		if (this.readOnly) return;
```

`handleCancel` is included deliberately: it is the path a palm rejection or a
lost pointer takes, and it commits or discards an in-flight stroke. Leaving it
ungated would let a gesture that began before read-only engaged still finish.

- [ ] **Step 4: Disable the toolbar's controls when read-only**

In `src/annotate/toolbar.ts`, inside `refresh()`, add before the final `addPageButton.hidden` line:

```ts
		// Left visible rather than hidden: the strip vanishing would read as
		// a bug, where a row of greyed-out tools reads as "not here", which
		// is what the banner above then explains.
		const readOnly = controller.isReadOnly();
		for (const button of toolButtons.values()) button.disabled = readOnly;
		for (const button of colorButtons.values()) button.disabled = readOnly;
		customColor.disabled = readOnly;
		widthSlider.disabled = readOnly;
		widthNumber.disabled = readOnly;
		clearPageButton.disabled = readOnly;
```

and change the four existing `disabled` assignments below it so read-only wins:

```ts
		undoButton.disabled = readOnly || !controller.canUndo;
		redoButton.disabled = readOnly || !controller.canRedo;
		deleteButton.disabled = readOnly || !controller.hasSelection();
		addPageButton.hidden = !controller.getCanManagePages();
		addPageButton.disabled = readOnly;
```

- [ ] **Step 5: Return the profile and risky features from the worker**

In `src/pdf/annotationWriterCore.ts`, add to `OpenedDocument`:

```ts
	// pdf-lib's own reading of the document's structure, for the view to
	// check against pdf.js's — see src/pdf/compatibility.ts.
	profile: StructureProfile;
	// Document features pdf-lib is known to round-trip badly, named for a
	// notice. Empty for almost every real book.
	risky: string[];
```

with the import:

```ts
import { profileFromPdfLib, riskyFeatures, type StructureProfile } from './compatibility';
```

and populate them in `openDocument`'s return:

```ts
	return { doc, savedAnnotations, displayBytes, profile: profileFromPdfLib(doc), risky: riskyFeatures(doc) };
```

Mirror both fields onto `OpenedOk` in `src/pdf/annotationWriterProtocol.ts`, into
the worker's `opened` reply in `src/pdf/annotationWriter.worker.ts`, and in
`src/pdf/annotationWriterClient.ts` onto the exported `OpenResult` interface plus
the object literal in the `message.type === 'opened'` branch of `handleMessage`
— the same two sites Task 3 edited.

The main-thread fallback path in the client must supply them too, since it calls
`openDocument` directly and gets both fields for free.

- [ ] **Step 6: Run the gate in the view**

In `src/pdfView.ts`, add the import:

```ts
import { compareProfiles, formatMediaBox, samplePageIndices, type StructureProfile } from './pdf/compatibility';
```

Add this module-level helper next to the other page helpers:

```ts
// pdf.js's half of the structure profile (see src/pdf/compatibility.ts).
// `page.view` is the raw MediaBox array, unrotated — the same space
// pdf-lib's getMediaBox reports in. A viewport would fold rotation into the
// dimensions and disagree with pdf-lib on every rotated page.
async function profileFromPdfJs(pdf: PDFDocumentProxy): Promise<StructureProfile> {
	const sampledPages: StructureProfile['sampledPages'] = [];
	for (const index of samplePageIndices(pdf.numPages)) {
		const page = await pdf.getPage(index + 1);
		const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
		sampledPages.push({
			index,
			page: {
				mediaBox: formatMediaBox(x1, y1, x2 - x1, y2 - y1),
				rotation: ((page.rotate % 360) + 360) % 360,
				annotationCount: (await page.getAnnotations()).length,
			},
		});
	}
	return { pageCount: pdf.numPages, sampledPages };
}
```

Carry the two new fields out of the writer's `open` the same way
`savedAnnotations` and `displayBytes` already are. Beside those declarations:

```ts
		let profile: StructureProfile | null = null;
		let risky: string[] = [];
```

in the `try`, next to the other two assignments:

```ts
			profile = opened.profile;
			risky = opened.risky;
```

and leave the `catch` alone — the initialisers above are already the right
fallback. A failed `open` means `writer` is null, so nothing will be written to
this file at all this session; there is nothing for the gate to protect and no
profile to check against.

Then, after `this.pdf = pdf;`, add the gate:

```ts
		// Whether pdf-lib can be trusted to rewrite this file at all. A
		// disagreement between the two parsers means pdf-lib's model of the
		// document is incomplete, and every save would serialize from that
		// incomplete model. Better to render the book and refuse to draw on
		// it than to quietly damage it.
		let refusal: string | null = risky.length > 0 ? `it contains ${risky.join(' and ')}` : null;
		if (!refusal && profile) {
			try {
				refusal = compareProfiles(profile, await profileFromPdfJs(pdf));
			} catch (error) {
				console.error('Inkling: could not check this PDF for editing safety.', error);
				refusal = 'its structure could not be checked';
			}
		}
		if (token !== this.renderToken) return;

		this.controller.setReadOnly(refusal !== null);
		if (refusal) this.showReadOnlyBanner(refusal);
```

Add the banner method next to `showLoadError`:

```ts
	// Sits above the pages rather than replacing them: the document is
	// perfectly readable, and its existing annotations still display. Only
	// writing to it is off the table, and this says why.
	private showReadOnlyBanner(reason: string): void {
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message inkling-pdf-readonly' });
		setIcon(box.createDiv({ cls: 'inkling-pdf-message-icon' }), 'file-warning');
		box.createDiv({
			cls: 'inkling-pdf-message-text',
			text: `Inkling can't safely annotate this PDF, because ${reason}. You can read it and see annotations already on it, but editing is turned off so the file isn't damaged.`,
		});
	}
```

Add a style for the banner in `styles.css`, beside the existing `.inkling-pdf-message` rules — it should read as a warning strip rather than a full-page error, so it does not look like the load failed:

```css
/* The read-only notice sits above the pages, which render normally
   underneath it — unlike .inkling-pdf-message on its own, which stands in
   for pages that never arrived. */
.inkling-pdf-readonly {
	margin: var(--size-4-2) auto;
	max-width: 60ch;
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-m);
	background-color: var(--background-secondary);
}
```

- [ ] **Step 7: Stop retrying a save that keeps failing**

The spec's last error-handling row, and the only one with nowhere else to live:
a save that fails verification leaves the pages dirty, so the next interval
tries the identical write and fails identically. A systematic problem — a
document `pdf-lib` cannot round-trip that the open gate did not catch — would
otherwise produce a notice every interval for as long as the file stays open.
This step is here rather than in Task 6 because it needs `setReadOnly`.

In `src/pdfView.ts`, add a field beside the other write-scheduling state:

```ts
	// Consecutive save failures on the current file. One is worth retrying:
	// a transient adapter error, a file briefly locked by sync. Two in a row
	// is a property of the document, and retrying it forever just means a
	// notice every interval for as long as the book is open.
	private consecutiveWriteFailures = 0;
```

Reset it to `0` in `onLoadFile` alongside the other per-file state, and on every
successful write in `flushAnnotations` (immediately after the `modifyBinary` /
`writeBinarySafely` call returns).

In `flushAnnotations`'s `catch`, after the existing logging and re-marking of
dirty pages, add:

```ts
			this.consecutiveWriteFailures += 1;
			if (this.consecutiveWriteFailures >= 2) {
				// Deliberately after the pages have been re-marked dirty: the
				// work stays pending, so if the user closes and reopens the
				// file and it then saves, nothing has been thrown away.
				this.controller.setReadOnly(true);
				this.showReadOnlyBanner('saving to it keeps failing');
				new Notice("Inkling: this PDF isn't saving, so editing has been turned off to avoid losing more work. Your ink from this session is still on screen.");
			}
```

Because `showReadOnlyBanner` appends to `contentEl`, guard it against stacking a
second banner when the gate in Step 6 already showed one — give the method an
early return:

```ts
		if (this.contentEl.querySelector('.inkling-pdf-readonly')) return;
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 9: Verify**

Run: `npm run build && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 10: Real-device check**

Three cases, on desktop and Android:

1. A normal textbook opens editable, exactly as before, with no banner.
2. A PDF with an interactive form (any government or tax form) opens read-only, showing the banner, with the toolbar visibly greyed out and a stylus doing nothing.
3. A handwritten note created by Inkling still opens editable and "Add page" still works — its `Keywords` template field is the thing most at risk from a mis-scoped gate.

- [ ] **Step 11: Commit**

```bash
git add src/ tests/ styles.css
git commit -m "Open read-only when a PDF can't be safely edited

Runs the cross-parser gate on open: pdf-lib's reading of the document
against pdf.js's, plus a check for forms and signatures. A disagreement
means pdf-lib's model is incomplete, and every save would serialize from
that incomplete model — so the book renders, its existing annotations
display, and drawing is turned off with a banner saying why.

The guard lives in the controller rather than in whether the view attaches
gestures, because pages mount lazily as the book is scrolled and a
view-level check would not cover the ones mounted later."
```

---

## After the plan

Two things this track deliberately leaves undone, recorded so they are not mistaken for oversights:

- **Pointer tests.** jsdom has no `PointerEvent`, and Track B rewrites pointer capture for coalesced events and pressure. Building the shim now means building it against code about to change.
- **A settings tab.** Every value introduced here is a constant. Making the save cadence and the read-only gate configurable belongs to Track D, along with the rest of the settings surface.

One item for the user rather than the implementer: check Self-hosted LiveSync's **max file size** setting. If large PDFs are being silently excluded from sync, there is no history for exactly the files this track is about.
