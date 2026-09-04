# Track A — Write safety and the regression net

Status: design, awaiting review
Date: 2026-09-04

## Why this exists

Inkling replaces the user's PDF in place. `flushAnnotations` re-serializes
the whole document through `pdf-lib` and calls `vault.modifyBinary` at most
every five seconds while the user is handwriting; `addPage` does its own
read-modify-write; and `onLoadFile` fires a third, fire-and-forget rewrite
whenever it finds orphaned annotation objects to prune. None of these
verify what they are about to write, and none of them can be undone.

For imported PDFs — textbooks, papers — the file is often the only copy.
Obsidian's core File Recovery snapshots Markdown only, so there is no net
under any of this today.

Every subsequent track (stroke capture, text-anchored annotations) edits
one of these same paths. This one goes first so the others can be built
aggressively.

## Environment constraints

The target vault syncs through **Self-hosted LiveSync** to CouchDB. Three
consequences drive the design:

- Any file written into the vault is chunked and replicated. A backup copy
  costs database size and bandwidth on every device, not just local disk —
  so this design keeps **no backups** and spends the effort on verification
  instead.
- A scratch file inside the synced tree would replicate on every save and
  then replicate its own deletion. Temporary files must live somewhere
  LiveSync does not walk.
- Replication is immediate, so a bad write reaches CouchDB and the user's
  other devices before they could notice locally. Verification must happen
  **before** bytes enter the vault, never as an after-the-fact audit.

## Goals

1. A structurally damaged PDF is never written into the vault.
2. An interrupted write never leaves a truncated file.
3. Opening a PDF never modifies it.
4. Continuous handwriting does not re-replicate a large binary every five
   seconds.
5. The pure logic modules have tests, and those tests run in CI.

## Non-goals

- Backups or version history of any kind. See "Environment constraints".
- Incremental PDF saving. `pdf-lib` cannot do it; changing that means
  changing PDF libraries, which is its own project.
- A settings tab. Values introduced here are constants; making them
  configurable belongs to Track D.
- Recovering files already damaged by past versions.

## Threat model

| # | Failure | Likelihood | Detectability | Covered by |
|---|---------|-----------|---------------|------------|
| 1 | Write interrupted mid-flight (app killed, especially mobile) | High | Immediate — file won't open | §3 Atomic replace |
| 2 | `pdf-lib` round-trip silently drops structure it didn't model | Low | Very poor — file still opens | §1 Open gate, §2 Save verification |
| 3 | Generational loss from repeated round trips, including on open | Moderate | Very poor | §2, §4, §5 |
| 4 | Binary churn overwhelming LiveSync | Certain, today | Visible as sync lag / data use | §5 Cadence |

`pdf-lib` is pinned at 1.17.1, its last published release (February 2021),
and upstream has been largely dormant since. No fixes are coming, so the
design treats it as a component that must be checked rather than trusted.

## Design

### 1. Open-time cross-parser gate

Save-time verification (§2) compares a saved document against the in-memory
document it came from. That cannot catch the case where `pdf-lib`'s *initial
parse* already lost something — by then the loss is inside the baseline.

Inkling already parses every file twice on open, once with `pdf.js` (to
render) and once with `pdf-lib` (to read annotations back). Comparing those
two independent parses costs almost nothing and catches exactly that case.

On entering annotate mode, compare:

- page count
- per-page `/MediaBox` dimensions
- per-page rotation
- per-page annotation count

Page count is free on both sides. The other three each cost a `pdf.js`
`getPage` call, so they are sampled across at most 10 pages spread through
the document rather than checked on every page.

(An earlier draft called for comparing per-page text-item counts. `pdf-lib`
has no text extraction and cannot produce that number, so the check was not
implementable as written.)

Disagreement means `pdf-lib` does not model this file faithfully. The view
opens **read-only**: pages render, existing annotations display, all
editing tools are disabled, and a notice explains that this PDF cannot be
safely annotated. This is strictly better than the current behavior, which
would happily start writing.

Independently, refuse edit mode outright when the document declares
structure `pdf-lib` is known to round-trip badly — an `/AcroForm` with
fields, a digital signature, or encryption. Detect these from the catalog
on open. Encryption already fails at `PDFDocument.load`; the others do not,
and are the dangerous ones.

### 2. Save-time verification

In `annotationWriterCore.writeDocument`, after `doc.save()` and **before**
the bytes are returned to the view for writing:

1. Re-parse the produced bytes with a fresh `PDFDocument.load`.
2. Build a structural fingerprint of that reparse and of the in-memory
   `doc` it came from.
3. Compare. On any mismatch outside Inkling's own annotations, throw — the
   view keeps the previous file untouched and re-marks the pages dirty.

The fingerprint, per page:

- `/MediaBox`
- decoded content-stream byte length (summed when `/Contents` is an array)
- `/Resources` `/Font` and `/XObject` name counts
- foreign annotation count, with each one's `/Subtype` and `/Rect`

Plus document-level page count and the `/Info` `Keywords` value, which
carries the handwritten-note template style and must survive.

Comparing the reparse against the **in-memory document**, not against the
original file bytes, is deliberate: `pdf-lib` legitimately re-encodes on
serialize, so a byte comparison against the original would be noise. Both
sides of this comparison have been through `pdf-lib`'s model, so anything
that differs is a genuine structural change. §1 covers what the model lost
before this point.

This runs inside the existing annotation-writer worker, so it costs no
main-thread time. It falls back to the main thread exactly as the writer
already does.

### 3. Atomic replace

`vault.modifyBinary` is not guaranteed atomic on either platform. Route the two remaining
calls (§4 removes the third) through a single helper:

1. `adapter.writeBinary(<scratch path>, bytes)`
2. Re-read that file and confirm its byte length matches what was written
3. `adapter.remove(<target>)` then `adapter.rename(<scratch>, <target>)`,
   or copy-through if rename across the boundary proves unreliable
4. On any failure, remove the scratch file and leave the target untouched

The scratch path must sit outside LiveSync's walk. LiveSync skips
dot-prefixed paths unless hidden-file sync is enabled, so a vault-root
`.inkling-scratch/` directory is the intended location, written through
`vault.adapter` rather than the `Vault` API (dot-folders are not indexed as
`TFile`s).

**Spike required** — confirm on desktop and Android that adapter writes to
a dot-folder work, that rename into the vault tree fires the right Obsidian
file events, and that LiveSync ignores it under a default configuration. If
rename proves unsafe, fall back to verify-then-`modifyBinary`, which still
gets goals 1 and 3 and loses only goal 2.

Stale scratch files from a killed session are cleaned up on plugin load.

### 4. Opening a PDF never writes to it

Delete the fire-and-forget `modifyBinary` of `prunedBytes` in `onLoadFile`.
`pruneOrphanedInklingAnnotations` keeps running on open — its result is
still needed in memory so the session works from a clean document — but the
pruned bytes are no longer written back as a standalone act.

Instead, mark the document as needing a prune and let the next save that
happens anyway carry it. A file the user only reads is never rewritten. A
file the user annotates gets pruned as part of a write it was already
paying for.

### 5. Save cadence

`WRITE_DEBOUNCE_MS` (1500) stays: it is the right trailing delay for
batching a burst of strokes.

`MAX_WRITE_INTERVAL_MS` (5000) is replaced by a value scaled to file size,
since the cost being bounded is a full re-serialize plus a full LiveSync
replication of the whole binary:

- under 5 MB: 10s
- 5–25 MB: 30s
- over 25 MB: 60s

Measured once per file on open. The trade-off is explicit: a crash loses at
most one interval of ink, so a large book risks up to a minute. That is the
right side of the trade when the alternative is re-replicating 40 MB twelve
times a minute — and §3 means a crash mid-write no longer damages the file,
only loses recent strokes.

Unchanged: `flushAnnotations` already returns early when no pages are
dirty, and teardown still forces a flush.

### 6. Test harness

Vitest, with two environments: `node` for the PDF and pure-logic modules,
`jsdom` for anything touching the DOM.

First tests, chosen because they cover the logic this track depends on and
the bugs the plan records as having already happened once:

- `annotationSync` — write each annotation kind, reparse, assert the
  round-trip recovers the same geometry, color, and width. Covers the
  `PDFName.asString()` leading-slash bug and the shape `/Rect` padding
  round-trip.
- The §2 fingerprint — a document that round-trips cleanly passes; a
  document mutated behind the fingerprint's back fails.
- `geometry` and `eraser` — segment-distance hit testing, including the
  sparse-segment-midpoint case reported as "erase only works on this
  session's strokes".
- `inkBlockFormat` — parse malformed, truncated, and hostile block content
  without throwing.
- `toolState` — per-tool style memory, and `suggestTool` not overriding a
  user choice.
- `history`, `store`, `contentStream`, `binary` — straightforward unit
  coverage.

Fixture PDFs are generated with `pdf-lib` inside the tests. No binary
fixtures in the repo.

Pointer tests are deferred to Track B, which rewrites pointer capture
anyway. jsdom has no `PointerEvent`, so they need a shim; building it now
would mean building it against code about to change.

### 7. CI

One GitHub Actions workflow on push and pull request: `npm ci`, then
`npm run lint`, `npm test`, `npm run build`. No release automation — that
belongs with a decision to publish, which has not been made.

## Error handling

Every failure in this design resolves the same way: **the file on disk is
left exactly as it was**, and the user is told what happened to their work.

| Condition | Behavior |
|---|---|
| Open gate fails (§1) | View opens read-only; notice explains this PDF can't be safely annotated |
| Forms/signatures detected (§1) | Same read-only path, with a reason naming the feature |
| Save verification fails (§2) | File untouched; pages stay dirty; notice; error logged with the specific invariant that moved |
| Scratch write or rename fails (§3) | Scratch removed, file untouched, pages stay dirty, notice |
| Repeated verification failure | Stop retrying after the second consecutive failure on one file and switch the view to read-only, so a systematic problem does not produce a notice every interval |

Keeping pages dirty on failure means a later successful save still captures
the work. Ink is lost only if the session ends without one — which is the
existing behavior, not a regression.

## Testing strategy

Unit tests as listed in §6. Beyond those, three things need real-device
confirmation because simulated tests cannot reach them:

1. Scratch-file write, rename, and LiveSync invisibility on Android
   (§3's spike).
2. A long handwriting session on a large book, confirming the new cadence
   and watching LiveSync's actual traffic.
3. Opening a PDF with an `/AcroForm` and confirming the read-only path
   engages rather than silently editing.

## Open questions

- **Scratch path viability** (§3) — the one genuine unknown. Resolved by
  the spike; the fallback is specified.
- LiveSync's max-file-size setting may exclude large PDFs from sync
  entirely. Does not change this design, but the user should check it: if
  big textbooks are not syncing, there is no history for exactly the files
  that matter most.
- Whether §1's 10-page sampling threshold is the right strength for very
  large books. Revisit if it proves too weak or too slow.
