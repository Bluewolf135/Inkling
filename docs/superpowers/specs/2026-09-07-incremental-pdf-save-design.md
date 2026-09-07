# Incremental PDF save — design

Status: design, not approved for implementation
Date: 2026-09-07
Touches the write path hardened by Track A
(`2026-09-04-write-safety-design.md`), which this must not weaken.

## Why this exists

Every save re-serializes the whole document. `PDFDocument.save()` walks
pdf-lib's object model and writes a new file from scratch, so annotating one
page of a 38.9 MB textbook costs 38.9 MB of serialization, 38.9 MB written
to disk, and — under a live-replicating vault — 38.9 MB back out to the
server.

That cost is why `pdf/saveCadence.ts` exists:

| File size | Longest gap between saves |
|---|---|
| under 5 MB | 10 s |
| 5–25 MB | 30 s |
| over 25 MB | 60 s |

The throttle is the real problem, not the bandwidth. **On the largest book
in the vault, a crash can cost a minute of handwriting.** Track A made a
crash mid-write unable to damage the file; it cannot recover strokes that
were never written. Handwriting is not recoverable by any other means — this
is the one loss in the plugin with no fallback.

An incremental update writes only what changed. For a page of annotations
that is a few kilobytes regardless of how large the book is, which removes
the reason for the throttle and takes the worst case from a minute down to
the debounce interval.

## The finding that makes this worth doing

**`Vault.appendBinary(file, data)` exists** (`obsidian.d.ts:6529`, also on
`DataAdapter` at 1526/1990/2923).

This was the open question the item hinged on. Without it, an "incremental"
save would still have to hand Obsidian the entire file for every write, and
the win would be limited to pdf-lib's serialization time — real, but not
worth rewriting the write path for. With it, the appended bytes are the only
bytes that touch the disk, and the original is never rewritten at all.

Two consequences follow, and the second matters more than the first:

1. **The write becomes O(change), not O(document).** Serialization, disk
   I/O, and sync upload all scale with the annotations added rather than
   with the book.
2. **pdf-lib stops re-encoding the document.** Every byte before the
   appended section is the original file, untouched. The failure
   `pdf/fingerprint.ts` exists to catch — pdf-lib quietly re-encoding
   something its object model represents imperfectly, discovered months
   later — becomes structurally impossible for everything we did not write.

The second point is the strongest argument here. This is not only a speed
change; it removes a whole class of risk that the current design can only
detect after the fact.

**Caveat to confirm first.** `minAppVersion` is 1.4.4 and the bundled
typings are 1.12.3. Whether `appendBinary` exists that far back is unknown
and must be established before anything is built. The mitigation is cheap —
feature-detect it and fall back to the current full-rewrite path — but which
of the two is the common case changes how this is sold and how it is tested.

## How an incremental update works

A PDF is designed for this; it is not a trick. Appending to a valid PDF:

```
%PDF-1.7
… the original file, byte for byte, untouched …
startxref
<offset of original xref>
%%EOF
                          ← everything above is never rewritten
12 0 obj                  ← the annotation dictionaries we added
<< /Type /Annot /Subtype /Ink /NM (ink-…) … >>
endobj
13 0 obj                  ← their appearance streams
<< /Type /XObject … >> stream … endstream
endobj
7 0 obj                   ← the modified page, reusing its object number
<< /Type /Page … /Annots [ … 12 0 R ] >>
endobj
xref / XRef stream        ← where those objects now live
trailer << /Root … /Prev <offset of original xref> /ID […] >>
startxref
<offset of the new xref>
%%EOF
```

A reader follows `startxref` to the newest cross-reference section, reads
`/Prev` back through the chain, and takes the most recent definition of each
object. Object 7 appearing twice is the mechanism working, not a corruption:
the later one wins.

## What changes per save

Inkling knows exactly what it touches, so the change set is enumerated
rather than discovered by diffing pdf-lib's object graph:

- the annotation dictionaries written by `writeInklingAnnotations`
  (`annotationSync.ts:336`);
- their appearance streams and any `ExtGState` for highlighter opacity
  (`annotationSync.ts:84`, `:95`);
- the `/Annots` array of each page that changed, and the page dictionary
  itself when `/Annots` had to be added;
- on the first save of a session only, whatever
  `pruneOrphanedInklingAnnotations` removed.

An explicit change set is better than diffing here because it cannot
over-collect. A diff against the loaded model would flag every object
pdf-lib normalised on parse, and appending those would reintroduce exactly
the re-encoding risk this design removes.

## Design decisions

### Track the change set in the writer, not by comparison

`writeDocument` gains a recorder: every `context.register` and every page
mutation it performs adds a `PDFRef` to a set. The set, the original bytes,
and pdf-lib's context are all an appender needs.

This is a change to `annotationSync.ts`'s internals rather than its
interface, which keeps `extract/` and the read path out of it entirely.

### Match the original file's cross-reference style

Both styles are in the user's own library, and the largest books use xref
streams:

| Book | Size | Cross-reference style |
|---|---|---|
| Digital Forensics | 38.9 MB | xref stream |
| Ethical hacking | 28.3 MB | classic table |
| Engineering A Compiler | 8.9 MB | xref stream |
| Units, Trig, Vectors | 6.6 MB | xref stream |
| Civilian CyberOps Resume | 178 KB | classic table |

A classic table appended after an xref stream is legal (§7.5.8.4, the hybrid
case) and widely accepted, but "widely accepted" is not a property this
plugin should be relying on in the write path. Matching what the file
already uses costs one more writer and removes the question.

**This is the largest piece of work in the item** and the reason it was
never a task to start coding. An xref stream is a compressed binary
structure with a `/W` field-width array, not a text table.

### Compact when the appendix grows past its worth

Appending forever makes a file that grows monotonically. Nothing breaks, but
a long annotation session on a small PDF could double it.

Rule: when the accumulated appended bytes exceed **20% of the original file
size or 2 MB, whichever is larger**, the next save is a full `PDFDocument.save()`
through the existing path, which collapses the chain. Both numbers are
guesses and should be checked against a real session before they are fixed.

### Keep the fingerprint check, but move it

Verification cannot simply be deleted — an appended file can still be
malformed, and the appended objects are the ones we wrote. But re-parsing a
38.9 MB book on every save is the very cost being removed.

Proposal, in descending confidence:

- **Always:** verify the appended region alone — that the new xref resolves,
  that `/Prev` points at the previous `startxref`, and that every ref in the
  change set is reachable. This is bounded by the size of the appendix.
- **On the first save of a session, and on every compaction:** the full
  `fingerprintDocument` comparison as it works today. A session's first
  write is where a structurally surprising file would show itself.
- **Never:** skip verification entirely because appending "cannot" corrupt.

### `writeBinarySafely` needs a second mode

`vaultWrite.ts` is the single chokepoint for binary writes and its
after-write check compares the file's size on disk to the number of bytes
written. For an append the expected size is *original + appended*, so the
check needs the base size passed in rather than inferred.

The `looksLikePdf` guard also cannot apply to an appendix, which does not
start with `%PDF-`. It is replaced for this path by a check that the
appendix ends with `%%EOF` and that the target file is unchanged in size
since it was read — the latter being what stops an append landing on a file
that sync has already moved underneath us.

That last point deserves emphasis: **an append to a file that changed since
we read it produces a corrupt PDF**, where a full rewrite would merely lose
the other change. This is the one place incremental save is *more*
dangerous than what it replaces, and it is a live risk in a
Self-hosted LiveSync vault. The size-and-mtime check before appending is not
optional, and on a mismatch the correct action is to fall back to a full
rewrite from a fresh read.

## What this does not change

- No new dependencies. pdf-lib stays at 1.17.1.
- `extract/` is untouched; it reads with pdf-lib and pdf.js and neither
  cares how the file was written.
- The display copy (`displayBytes`) is unaffected.
- Markdown ink blocks are unrelated to any of this.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Append lands on a file sync changed underneath us | **Corrupt PDF** | Size + mtime check before every append; fall back to full rewrite on mismatch |
| `appendBinary` missing on `minAppVersion` 1.4.4 | Feature unavailable | Feature-detect, fall back to the current path |
| xref stream writer is wrong in a way pdf.js tolerates | Silent, found later | Verify with a second reader; test against all five books above |
| Encrypted PDFs | Unknown | Refuse to append; fall back to the current path, which already handles them however it does today |
| Appendix chain grows unboundedly | File bloat | Compaction rule above |

## Open questions, in the order they should be answered

1. Does `appendBinary` exist at `minAppVersion` 1.4.4, and on mobile?
2. Can a correct xref stream be written for the four books above, and does
   pdf.js — and Obsidian's own viewer, and one external reader — accept the
   result?
3. Does Self-hosted LiveSync actually chunk a PDF such that an append
   re-uploads only the tail? If it re-uploads the whole file regardless, the
   bandwidth argument disappears and only the CPU and crash-window
   arguments remain. Those are still enough, but the item's value changes.
4. What are the real compaction thresholds?

Question 3 is worth answering before questions 2 and 4, because it is cheap
and it is the one that could most change the shape of the work.

## Recommended sequence

1. A spike, throwaway, answering questions 1 and 3. Neither needs any of
   this design to exist.
2. The change-set recorder in `annotationSync.ts` — useful on its own, and
   testable without an appender.
3. The classic-table appender, tested against the two books that use one.
4. The xref-stream appender, tested against the three that use streams.
5. `writeBinarySafely`'s append mode, with the staleness check.
6. Verification split, compaction, and the removal of `maxWriteIntervalMs`.

Step 6 is the payoff and must be last: the throttle is what currently limits
the blast radius of a bad save, and it should not come out until everything
under it has been proven against real books.
