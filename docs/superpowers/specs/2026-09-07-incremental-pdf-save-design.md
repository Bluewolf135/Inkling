# Incremental PDF save — design

Status: design, not approved for implementation
Date: 2026-09-07, revised the same day after review
Touches the write path hardened by Track A
(`2026-09-04-write-safety-design.md`), which this must not weaken.

The first draft enumerated the books then in the vault and made design
decisions against them. That was wrong: the library changes, and a design
that knows today's five books is a design that breaks on the sixth. This
revision replaces that with runtime classification and a decline path, and
the principle below is what everything else hangs off.

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
   with the book. Note the word *write*: verification still has to parse the
   whole document, for reasons set out under "Verify before appending"
   below, and how much of that survives is the largest open question here.
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

## The governing principle

**Incremental save is an optimization, and it must always be able to
decline.**

Every file is classified when it is opened. One we can confidently classify
takes the fast path; one we cannot — for any reason, including reasons
nobody has thought of yet — takes the existing full-rewrite path and is
merely as slow as it is today. Declining is always correct and never loses
data.

This is what makes new books safe. The plugin does not need to have seen a
structure before; it needs to be able to tell that it has not. Any of these
declines:

- `startxref` cannot be found, or does not point at something that parses as
  a cross-reference section;
- the file is encrypted;
- the cross-reference style is neither of the two we write;
- the file carries `/XRefStm` (a hybrid-reference file);
- the last cross-reference section disagrees with pdf-lib about where an
  object we intend to override actually lives;
- the file changed on disk since we read it;
- any assertion in the appender fails for a reason it has no rule for.

A decline is logged once per file per session, never per save, and is not
surfaced to the user. From the outside it is a save that took as long as it
used to.

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

## What pdf-lib actually does, which is not what you would assume

Verified by reading `pdf-lib@1.17.1` rather than inferred, because three
design decisions depend on it.

**It never reads the cross-reference table.** `PDFParser.parseDocument`
walks the file linearly from the header to EOF, parsing every object it
meets. It reads a trailer only to pick up `/Root` and `/Info`, and
`maybeRecoverRoot()` scans the parsed objects for a `/Type /Catalog` when
that fails. `startxref` is parsed and then discarded.

Three consequences:

1. **We have to find `startxref` ourselves**, by scanning the tail of the
   original bytes. pdf-lib keeps nothing we can ask.

2. **A book with a broken xref opens fine in Inkling today**, because
   nothing consults it. Appending to such a file — writing a `/Prev` that
   points at an offset which is not a cross-reference section — produces a
   file pdf-lib still reads and a stricter reader does not. "Is this file's
   cross-reference table actually valid?" is a question the plugin has never
   had to ask, and the classifier now has to ask it of every file. This is
   the most likely way to ship a corruption bug here, precisely because the
   plugin's own reader cannot see it.

3. **pdf-lib reads our appended output correctly by construction.** `PDFRef`
   is interned through a module-level pool keyed on `"<num> <gen> R"`, and
   `PDFContext.assign` is a `Map.set` on that ref, so a later definition
   replaces an earlier one. A linear parse of an appended file therefore
   ends up with the newest version of every object, which is the same answer
   following the xref chain would give.

**Encrypted files are already handled.** `PDFDocument.load` defaults to
`ignoreEncryption: false` and throws `EncryptedPDFError`, and Inkling never
passes the flag (`annotationWriterCore.ts:36`, `:61`, `:96`,
`extract.ts:252`, `pdfView.ts:1203`). An encrypted book cannot be opened for
annotation today, so the incremental path can never meet one. The first
draft listed this as an unknown risk; it is neither unknown nor a risk.

**Object numbering is safe to take from the context.**
`context.largestObjectNumber` is maintained across every `assign` during the
linear parse, so it reflects every object anywhere in the file, including
ones a cross-reference table has marked free. `context.nextRef()` therefore
cannot collide with an existing object. It must not be reset between appends
in a session, which means the same `PDFDocument` has to be held across
saves — which `OpenedDocument` already does.

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

Each update section's trailer carries the following, which the first draft
sketched without stating the rules:

- `/Size` — one greater than the largest object number **across the whole
  chain**, not just this section.
- `/Prev` — the byte offset of the previous cross-reference section, taken
  from the `startxref` scanned out of the tail.
- `/Root`, `/Info` — copied unchanged from the original trailer.
- `/ID` — an array of two strings. The **first is preserved** as the file's
  permanent identity; the **second is regenerated** on every update, which
  is what the array is for. Preserving both, or regenerating both, are
  different flavours of wrong.
- Generation numbers stay at 0 for objects we override. Incrementing them is
  for reusing a freed object number, which we never do.

## Design decisions

### Track the change set in the writer, not by comparison

`writeDocument` gains a recorder: every `context.register` and every page
mutation it performs adds a `PDFRef` to a set. The set, the original bytes,
and pdf-lib's context are all an appender needs.

This is a change to `annotationSync.ts`'s internals rather than its
interface, which keeps `extract/` and the read path out of it entirely.

### Classify the file, then match what it already uses

Two cross-reference styles are worth writing: the classic table and the xref
stream. Which one a file gets is decided per file, at open time, by reading
that file's own last cross-reference section — never from a build-time
assumption and never from a list of known books.

A classic table appended after an xref stream is legal (§7.5.8.4, the hybrid
case) and widely accepted, but "widely accepted" is not a property this
plugin should rely on in the write path. Matching what the file already uses
costs one more writer and removes the question.

**The xref stream writer is the largest piece of work in the item** and the
reason this was never a task to start coding. It is a compressed binary
structure with a `/W` field-width array, not a text table.

A snapshot of the vault on 2026-09-07, recorded as evidence that both styles
occur in real use and that the largest books use streams — **not a test
plan, and not a set of cases to code against**:

| Book | Size | Cross-reference style |
|---|---|---|
| Digital Forensics | 38.9 MB | xref stream |
| Ethical hacking | 28.3 MB | classic table |
| Engineering A Compiler | 8.9 MB | xref stream |
| Units, Trig, Vectors | 6.6 MB | xref stream |
| Civilian CyberOps Resume | 178 KB | classic table |

This table will be wrong within weeks. It is here to justify building two
writers rather than one, and for nothing else.

### Test against generated fixtures, not against the library

The corpus is synthesised: one fixture per structural class — classic table,
xref stream, object streams, hybrid `/XRefStm`, linearized, already
incrementally updated, deliberately broken xref — each built in the test
itself and each asserted to round-trip.

Testing against the books in the vault instead produces a suite that cannot
run in CI, depends on files not in the repository, and changes meaning every
time a book is added or removed.

The vault is still worth one opt-in smoke check: walk whatever PDFs it
finds and assert the classifier reaches a decision — fast path or decline —
on every one of them without throwing. That check is about the classifier's
total coverage, which is precisely the property that has to survive the
library changing.

### Compact when the appendix grows past its worth

Appending forever makes a file that grows monotonically. Nothing breaks, but
a long annotation session on a small PDF could double it.

Rule: when the accumulated appended bytes exceed **20% of the original file
size, or 8 MB, whichever is smaller**, the next save is a full
`PDFDocument.save()` through the existing path, which collapses the chain.

Smaller, not larger — the first draft had this backwards. A percentage alone
scales the wrong way as the library grows: 20% of a future 200 MB book is
40 MB of appendix before anything compacts. The absolute ceiling stops a big
book accumulating a big appendix; the percentage stops a small one
compacting constantly.

Both numbers are guesses and should be checked against a real session,
including an eraser-heavy one, before they are fixed.

### Verify before appending, because an append cannot be undone

This is the correction that matters most.

The current path verifies after producing the bytes and before handing them
to the vault, and a failure means the file on disk is simply never touched.
That works because a full write is a replacement: declining to perform it
costs nothing.

An append has no such property. **Obsidian's API has no truncate.** Once
bytes are on the end of the file, undoing them means rewriting the whole
document — the exact cost this design exists to avoid, incurred on the
failure path, on a file that is invalid at that moment.

So verification moves ahead of the write:

- **Before appending, in memory.** Assemble the appendix, concatenate it
  with the original bytes in memory, and parse the result. Every check the
  full path makes today — `fingerprintDocument` against the intended
  document — runs here, on a buffer that has not touched the disk. A failure
  discards the buffer and falls back to a full rewrite; the file on disk is
  still the last known-good version.
- **After appending, the size check only.** Original length plus appendix
  length against `adapter.stat`, which is what catches a truncated write and
  is what Track A's after-check is for.

The cost this reintroduces has to be stated plainly: parsing the
concatenated buffer is O(document), so the 38.9 MB book is still parsed once
per save. **Serialization, the disk write and the sync upload all become
O(change); the verification parse does not.**

Whether that is acceptable is an open question below. Three options, none
yet chosen:

1. Full verification parse on every save. Safest, and still a large win,
   since parsing is cheaper than serializing plus writing plus uploading.
2. Full verification on the first save of a session and on every compaction;
   between them, verify only that the appendix parses in isolation and that
   every ref in the change set resolves.
3. Full verification on a background timer rather than per save.

Option 2 is the recommendation and also the decision here most likely to be
wrong. It should be made against a measurement of what the parse actually
costs on the largest book, not against this paragraph.

### Deleting an annotation still grows the file

An append-only format cannot remove anything. Erasing rewrites the page's
`/Annots` without that ref, which is enough for correctness — no reader will
show it — but the annotation dictionary and its appearance stream stay in
the file.

Marking them free in the new cross-reference section is correct, cheap for a
classic table, and what the format is for. It does not reclaim the bytes; it
stops the objects being reachable.

The bytes come back only at compaction, which means the compaction rule is
doing more than tidying an appendix: **it is the plugin's only garbage
collector.** An eraser-heavy session is the case that reaches it first, and
the one the thresholds should be measured against.

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
| Append lands on a file sync changed underneath us | **Corrupt PDF** | Size + mtime check immediately before every append; decline to full rewrite on mismatch |
| Appending to a file whose xref was already broken | **Corrupt PDF, invisible to us** | Classifier validates the existing xref before the fast path is ever taken; pdf-lib cannot detect this after the fact, so it has to be a precondition |
| A bad append cannot be rolled back | **File left invalid** | Verify the concatenated buffer in memory *before* writing; the disk only ever sees bytes that already parsed |
| xref stream writer wrong in a way pdf-lib tolerates | Silent, found later | pdf-lib is not a witness — it ignores the xref entirely. Verify with pdf.js and one external reader |
| `appendBinary` missing at `minAppVersion` 1.4.4 or on mobile | Feature unavailable | Feature-detect; decline to the current path |
| A structure nobody anticipated | None | The decline path. This is what it is for |
| Appendix grows unboundedly, including from erasing | File bloat | Compaction, which is the only garbage collector |
| ~~Encrypted PDFs~~ | Not a risk | Already rejected at `PDFDocument.load`; see above |

## Open questions, in the order they should be answered

1. Does `appendBinary` exist at `minAppVersion` 1.4.4, and on mobile?
2. **What does the verification parse actually cost on the largest book?**
   This decides between the three verification options above, and with them
   how much of the win survives. It is the question the value of the item
   now turns on, and it is measurable today against the current code — no
   part of this design has to exist first.
3. Does Self-hosted LiveSync chunk a PDF such that an append re-uploads only
   the tail? If it re-uploads the whole file regardless, the bandwidth
   argument disappears and only the CPU and crash-window arguments remain.
   Those are still enough, but the item's value changes.
4. How many PDFs in a real library fail classification? If the decline rate
   is high, the fast path is rarely taken and the work is not worth doing.
   The opt-in vault smoke check answers this directly, and keeps answering
   it as the library grows.
5. Can a correct xref stream be written and read back by pdf.js, Obsidian's
   viewer, and one external reader? Note that pdf-lib is not a witness here
   — it ignores the cross-reference table, so it will happily accept a
   stream we got wrong.
6. What are the real compaction thresholds, measured against an
   eraser-heavy session rather than a drawing-only one?

Questions 1 to 4 are all cheap, need none of this design to exist, and any
of them can kill or reshape the item. Neither 5 nor 6 should be started
before all four are answered.

## Recommended sequence

1. **A spike, throwaway, answering questions 1 to 4.** None of them needs a
   line of this design to exist, and between them they decide whether the
   item is worth building at all.
2. **The classifier**, with the decline path and the generated fixtures. It
   is useful on its own — it answers question 4 permanently rather than once
   — and nothing else here can be trusted without it.
3. **The change-set recorder** in `annotationSync.ts`. Also useful alone,
   and testable with no appender in existence.
4. **The classic-table appender**, against its fixtures.
5. **The xref-stream appender**, against its fixtures.
6. **`writeBinarySafely`'s append mode**, with the staleness check and
   in-memory verification ahead of the write.
7. **Compaction, free-list entries, and the removal of
   `maxWriteIntervalMs`.**

Step 7 is the payoff and must be last: the throttle is what currently limits
the blast radius of a bad save, and it should not come out until everything
under it has been proven.

Steps 2 and 3 are worth doing even if the item is later abandoned. The
classifier tells us what is actually in a library, and the change-set
recorder makes the write path describe its own effects — both worth having
on their own terms.
