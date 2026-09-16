# Ink outside the note — design

Status: design, not approved for implementation
Date: 2026-09-16

Moves a Markdown ink block's strokes out of the note and into a file of
its own, one per note, leaving a three-line fence behind. Touches the
write path hardened by `2026-09-04-write-safety-design.md`, and removes
most of the reason that path is as intricate as it is.

## Why this exists

An ink block stores its strokes inside the note, as JSON in a fenced code
block. Measured on the vault this was designed against:

| Note | Ink data | Prose | Blocks |
|---|---|---|---|
| Newton's Laws of Motion Exercises | 1,385 KB | 10 KB | 38 |
| Motion in 2-D Exercises | 148 KB | 2 KB | 5 |
| Energy Exercises | 6 KB | 11 KB | 38, still empty |

Three consequences, in the order they hurt.

**Every save rewrites the whole note.** A stroke in block 12 of the
Newton's Laws note rewrites 1,396 KB: through the editor when the note is
open, to disk, through Obsidian's metadata index, and out through a
live-replicating vault to every other device. The debounce in
`markdown/inkBlock.ts` exists to make that survivable, not cheap.

**Writing into a live note is the hard part of the current code.** A save
has to find its own fence in a document the user may be editing, refuse to
write when the answer is ambiguous, merge when the fence moved on, hold
the drawing when it cannot write at all, and put the scroll position back
afterwards. The worst bug in this plugin's history — one block's drawing
written into another block's fence — came from that search being wrong.
None of it is incidental complexity; all of it exists because the strokes
live in the same file as the prose.

**The note stops being text.** Search, diffs, hand edits and AI tooling
all wade through megabytes of coordinates to reach ten kilobytes of
physics.

## What this is not

Not a new drawing surface, not a new format for what a stroke *is*, and
not a change to the PDF side. The annotation model, the toolbar, the
controller and the renderer are untouched. This is a change of address.

## Principles

1. **Ink is the irreplaceable thing.** Every ambiguous case resolves
   toward keeping strokes, even at the cost of a stray file or a
   duplicate. This is the principle the existing write-safety work is
   built on and it does not change.
2. **Nothing is deleted as a side effect.** Deleting a fence, renaming a
   note, or changing a setting never deletes stroke data. Removal is
   always something the user asks for.
3. **The old format keeps working.** In-note blocks render and save
   exactly as they do today, indefinitely. A vault can hold both.
4. **Structure stays readable; only coordinates are opaque.**

## The fence

````
```inkling
file: Attachments/Newton's Laws of Motion Exercises.ink
id: 2b
```
````

Two keys, parsed leniently: unknown keys are preserved on rewrite, so a
future version can add one without this one destroying it.

`file` is a vault-relative path, not a wikilink, and it is explicit rather
than derived from the note's name. Derivation would be shorter and would
survive renames for free, but it makes a fence mean something different
depending on which note holds it — and the user's decision below (a copied
block shares the original's ink) requires that a fence mean the same thing
wherever it is pasted.

`id` is unique within the ink file, not across the vault. It is generated
by the existing `annotate/id.ts` for new blocks.

A fence missing `file` or `id`, or holding a path that is not a vault
path, is damaged: the block renders read-only with a banner and never
saves. This is the same refusal the current format makes for JSON it
cannot parse.

## The ink file

```json
{
  "version": 1,
  "blocks": {
    "2b": {
      "width": 800,
      "height": 400,
      "caption": "friction on the ramp",
      "strokes": "<base64 of deflate-compressed stroke JSON>"
    }
  }
}
```

One file per note by convention, not by rule: the format has no idea which
note refers to it, and two notes may refer to the same file. That falls
out of copy-shares-ink and costs nothing.

`strokes` holds what the `annotations` array holds today, serialized by
the existing `markdown/inkBlockFormat.ts` writer, then compressed and
base64-encoded. Compression is per block, so a save recompresses one
block, not the file. Measured on the largest block in the vault (133 KB):
2.8 ms to compress, 0.3 ms to decompress.

Sizes measured across the Newton's Laws note's 38 blocks: 1,385 KB as
JSON today, 257 KB gzipped, 198 KB with brotli. Deflate via the web platform's
`CompressionStream` is specified: it needs no dependency and exists on
desktop Electron and in the WebViews Obsidian mobile uses. That last part
is the risk — it must be confirmed on the Samsung tablet before this
ships, and the implementation must detect its absence at load and fall
back to storing the block uncompressed rather than failing to save.

**The codec is per block, not per file.** An optional `codec` key beside
`strokes`, absent meaning `deflate`, `"none"` meaning the fallback above.
It cannot live in `version`: compression is per block and the fallback is
per block, so one device without `CompressionStream` saving one block
produces a file whose blocks disagree, which a single file-level codec
cannot describe. `version` governs the structure of the file and nothing
else.

**The fallback is still base64**, of the uncompressed bytes. There is no
saving in writing the JSON inline, and everything below — salvage
especially — depends on `strokes` being an opaque base64 string in every
case, whatever produced it.

`CompressionStream('deflate')` specifically, not `'deflate-raw'`. The zlib
wrapper costs six bytes a block and carries an Adler-32 trailer that
`DecompressionStream` validates, so a block corrupted in transit or on
disk fails loudly instead of inflating into plausible nonsense. That is
the whole of this design's integrity checking; no separate checksum is
stored.

Those sizes are a floor, not a prediction of the file. 257 KB is the whole
set gzipped as one stream; compressing per block forgoes a shared
dictionary, and base64 adds a third on top, so the file on disk should be
expected nearer 350–380 KB. Still a quarter of today's 1,385 KB, and it
changes no decision here, but the real figure should be measured rather
than quoted from the table above.

Why the structure stays in text: a damaged file can be inspected and
partly rescued by hand, a caption can be fixed in a text editor, and a
three-way sync merge can operate per block. The coordinates are 99% of
the bytes and none of the meaning.

### How a file classifies on read

**Readable.** Its JSON parses and its `version` is one this build knows.

**From the future.** Its JSON parses but its `version` is newer than this
build understands. The file is valid, not broken: a newer Inkling wrote
it. Its blocks render read-only with a banner naming that reason, and the
file is never written over, never quarantined and never salvaged. The
in-note format already draws this distinction — `fromFuture` in
`markdown/inkBlockFormat.ts` — and the ink file follows it.

**Damaged.** Its JSON does not parse at all, or parses into something that
is not a block map. Only this enters the repair path below.

Within a readable file, a block classifies on its own, two ways:

**Undecodable.** Its `strokes` is not valid base64, fails its Adler-32
check, or does not parse back into annotations. Something corrupted it.

**Unsupported.** It names a `codec` this build does not have — in
practice, `deflate` read on a device where `CompressionStream` turned out
to be missing. Nothing is wrong with the block; this reader simply cannot
open it. Worth separating from undecodable because it is not a fault and
should not be reported as one.

### A block this build cannot read is still carried through

Both of the above render read-only with a banner naming which they are.
But read-only is not enough on its own, and this is the trap: the store
holds *parsed* blocks, so a file serialized from what the store parsed
would omit every block that failed to parse. A single stroke in block 3
would then erase block 12, on a file that was merely written by a newer
build or read on a weaker device. That is the worst outcome in this
document, and it arrives through the ordinary save path rather than
through any failure.

So `strokes` is treated as an opaque string throughout. A block the store
could not decode keeps its original text, is written back byte for byte on
every rewrite, and is never re-encoded. The same holds for keys within a
block and at the top of the file that this build does not recognise: they
are preserved on rewrite, exactly as the fence preserves unknown keys and
for the same reason.

This is what makes the `CompressionStream` risk survivable rather than
fatal. A device without it can open a file full of deflated blocks, draw
in a new one, save, and hand every other block back untouched.

Read-only means never written over, exactly as now. Any drawing that
cannot be saved goes to the rescue store (`markdown/inkRecovery.ts`) and
is written as soon as the file is writable again.

## Where new files go

A setting, defaulting to **follow Obsidian's attachment location** via
`fileManager.getNewFileParent`, so ink lands wherever the user's images
already do without configuring anything. Alternatives: beside the note,
or a named folder.

The setting governs creation only. Changing it never moves an existing
file, and no file is ever relocated as a side effect.

**To keep ink out of the way**, point the setting at a named folder and
add that folder to Obsidian's **Settings → Files & Links → Excluded
files**. It disappears from search, the graph and the quick switcher while
staying an ordinary vault file for every API and every sync. The
quarantine files below land there too, which is most of the reason to
bother.

**Not a hidden folder.** Obsidian's Vault API does not see paths beginning
with a dot at all, so ink under `.inkling/` would have to go through
`vault.adapter` — losing the `modify` event the external-change watch
needs, the `rename` event the fence rewrite is driven by, the `delete`
event the missing-file state depends on, and `adapter.trashLocal` as a
restore source. Worse, Self-hosted LiveSync treats hidden files as a
separate opt-in mechanism from ordinary replication, so a dot-folder is
exactly where "it syncs everything" stops being true. Ink that silently
stops syncing is the worst failure available here, and the in-note format
cannot produce it. `src/vaultWrite.ts` declined the same bet for the same
reason.

## Lifecycle

**Insert.** The command writes the fence with a generated `id` and the
path the setting resolves to. The ink file is not created until the first
stroke, so empty blocks — the Energy note has 38 of them — cost nothing.

**Save.** Recompress the one block, rewrite the ink file, leave the note
untouched. The debounce stays; the editor path, the fence search, the
three-way merge against the note, and the scroll restoration all go away
for new-format blocks.

**Write ordering.** Writes are queued per ink file, so two blocks saving
in the same moment apply one after the other. A queued write for a block
that is written again before it runs is collapsed into the later one.

**Copy a fence into another note.** Both fences point at the same block,
and editing either shows in both. Chosen deliberately over splitting on
edit, which was the more expensive behavior to build.

**Rename or move a note.** Nothing happens. The fence names a file, not a
note, so the link still resolves.

**Rename or move an ink file.** Fences that name it are rewritten, driven
by the vault `rename` event. Obsidian does not do this for us: it does not
track links inside code blocks. The scan is limited to notes containing an
ink fence.

**Command: rename ink file to match note.** The tidy-up for the drift the
previous two paragraphs allow. Renames the file and rewrites every fence
that names it, in one pass, reporting what it touched.

**Delete a fence from a note.** The block's strokes stay in the file.
Nothing in the editing of a note removes stroke data.

**Command: remove unreferenced blocks.** Scans the vault for fences,
reports blocks no fence names, and removes them on confirmation. The only
path by which stroke data is deleted, and it always names what it will
remove first.

## When a file or block goes missing

A setting, **when an ink file goes missing**, with three values:

| Value | Behavior |
|---|---|
| Restore it (default) | Restore immediately, with a notice saying so and an action to really delete it |
| Ask me | A notice offering restore or leave it; the file stays in the trash until answered |
| Just tell me | The block shows the missing state; restoring is a button on the block |

All three end in the same place if the user does nothing: the block shows
a **ink file missing** state with a Restore button, and refuses to save.
Refusing is the point — a block that saved in this state would write an
empty file over a file that was merely misplaced.

Restore draws on three sources in order: the copy the block holds in
memory, Obsidian's trash (`adapter.trashLocal` puts files in `.trash`;
system trash is reported as unavailable and the notice says so), and the
rescue store.

**A note deleted while its ink file survives** leaves the file alone, and
says so once. Keeping is the default because deleting data nobody asked to
delete is the worse mistake, and the tidy-up command exists for the rest.

**A fence naming a block the file does not hold** — usually a fence pasted
from another vault — shows the same missing state, with "start a new
drawing here" as an explicit action rather than silently creating one.

Obsidian offers no way to intervene before a delete: `vault.on('delete')`
fires after the file is gone. So a true "this is still linked" prompt is
possible only for deletions Inkling itself initiates, and everything above
is prompt-plus-undo rather than prevention.

## Repairing a damaged file

A damaged file is not a file to refuse and leave alone. It is quarantined,
salvaged and rewritten, automatically, with one notice and an undo. The
reasoning is principle 1: a file nobody can read is already the bad
outcome, and most of the strokes in it are still recoverable.

### The invariant

**Never repair a file that was not quarantined first.** If the copy-aside
fails for any reason — no space, a read-only vault, a name collision that
cannot be resolved — nothing is written, the file's blocks go read-only,
and the notice names the step that failed. Every other guarantee in this
section rests on the original bytes existing somewhere before anything
replaces them.

### A damaged read never displaces a good one

`inkFileStore` keeps the last parse that succeeded. A later read that does
not parse — a reload, or the external-change watch firing on a sync that
landed badly — does not adopt, does not mark anything read-only and does
not interrupt drawing. The session goes on serving what it already holds,
and a save made in the meantime still lands.

It keeps the parsed blocks, not the raw text. The text is never wanted
again: the merge below works on parsed blocks, and retaining it would add
the whole file's size to memory per open note for nothing.

### Salvage

The file is unusually recoverable, because `strokes` is base64 and so
contains no `{`, `}`, `"` or `\`. A scanner can lift intact
`"<id>": { … }` regions out of a file that has been truncated, or has sync
conflict markers spliced into it, and parse each region on its own.
Scanning rather than parsing top to bottom means damage in the middle does
not cost the blocks after it. Only `caption` needs care, being the one
field that can hold a brace or an escaped quote.

**The scanner is hand-written and single-pass, tracking string and escape
state. It does not use a regular expression.** A pattern with `.*` in it
backtracks quadratically across a few hundred KB of base64, which turns a
recoverable file into a hung app.

A file carrying conflict markers holds the same `id` twice, and both
copies are usually intact. Salvage returns duplicates as a list rather
than picking a side, and the store merges them through the existing
`markdown/mergeInkBlocks.ts`, which matches annotations by id and keeps
both sides' strokes. A conflicted file therefore resolves to the union of
what was drawn, which is what principle 1 asks for.

**Duplicates merge against an empty base.** `mergeInkBlocks` is genuinely
three-way, and its base is load-bearing: an annotation present in the base
and absent from ours is read as a deliberate erasure and dropped. Between
two salvaged copies there is no base — neither was derived from the other,
and nothing here knows which came first — so passing anything but an empty
base would silently discard strokes in the name of an erasure that never
happened. With an empty base the function reduces to the union, which is
the only defensible answer when provenance is unknown.

### Damage is confirmed before it is acted on

A read that fails does not start a repair. The file is re-read after a
short delay, and only a second failure counts as damage.

The reason is replication. A file caught mid-write by a sync is partial on
disk for a moment and complete a moment later, and that moment is exactly
when the external-change watch fires. Repairing on the first failed read
would convert a transient state into a permanent rewrite — and then
replicate that rewrite to every other device, having salvaged an
incomplete file over a whole one. Waiting costs nothing, because a damaged
read never displaces what the session already holds, so nobody is blocked
while the answer settles.

### What repair does

1. Copy the damaged text aside, unaltered, to
   `<name>.ink.damaged-<timestamp>.txt` beside the file. An ordinary vault
   file, so it syncs to the other device — which is where a good copy may
   still be sitting — and so this needs none of the dot-folder assumptions
   `src/vaultWrite.ts` records as unverified. `.txt` because the contents
   are bytes as found, not necessarily JSON; the `.damaged-` infix keeps
   the fence scan from mistaking it for ink.
2. Salvage the text.
3. Merge per id: a block the session already holds wins where salvage
   found nothing, salvage wins where the session holds nothing, and
   `mergeInkBlocks` decides where both have one.
4. Write the result.
5. Raise one notice, per file, per session — not per block, or the
   Newton's Laws note would raise thirty-eight. It says how many drawings
   came back and how many did not, names the quarantine file, and offers
   **Undo the repair**.

Undo puts the damaged file back, and the wording says so: it is for the
case where the salvage looks wrong and someone would rather have the
original bytes to work on by hand. It is not a way to recover a good file,
because there was no good file.

**Undo also stops the repair from running again.** Restoring the damaged
text means the next read fails, which would repair it, which the user
would undo — a loop that writes a quarantine file every time round. So a
file whose repair has been undone is marked for the rest of the session
and left alone: its blocks go read-only, and the banner says a repair was
undone rather than that the file is unreadable.

Blocks salvage could not recover show the same missing state as a block
the file does not hold, with Restore reaching memory, the trash and the
rescue store as above.

### Quarantine files do not multiply

One is written per damage event, not per save and not per session, and the
confirming re-read above means a file caught mid-sync produces none at
all. In normal use the count is zero and stays zero.

The case that would multiply is the same file going damaged repeatedly —
a sync corrupting it the same way each time. So **an identical quarantine
is not written twice**: if a quarantine for this ink file already exists
with the same contents, the existing one is the copy, and repair proceeds
without writing another. Sizes are compared first, so the contents are
only read when they might match.

They are never removed automatically. The rescue store expires entries
after a fortnight because a stale drawing reappearing is an ambush; a
quarantine file is the opposite, and can be the only surviving copy of
what was lost. But never-automatically is not never: the
unreferenced-blocks command lists them with their dates and sizes and
removes the ones the user picks, which is the same bargain that command
already makes for blocks — it names what it will delete and waits to be
told.

### Guarding the write

Nothing above catches a file this plugin wrote wrongly but validly — the
modern form of one block's drawing landing in another block's fence. That
needs guards on the way out, in the shape `src/vaultWrite.ts` already uses
for PDFs.

**Before.** A serialization holding no blocks never goes over a file that
held blocks. A block serialized with an empty stroke payload never goes
over one whose view holds annotations. Either refuses the write and routes
the drawing to the rescue store, exactly as a failed save does today.

**These guard saves, not commands.** Removing unreferenced blocks can
legitimately empty a file, and it is the one path licensed to destroy
stroke data because it names what it will remove and waits to be told to
go ahead. It writes through the same queue with the emptiness guard
disabled. A guard that cannot be turned off by the one operation it is
wrong for gets turned off everywhere by the first person it annoys.

**After.** `adapter.stat` compares the file's size on disk against what was
written, which is what notices a write cut short — the failure a
backgrounded app on mobile is killed into. A full re-read and parse runs
only on the first write after an open or a repair.

The comparison is in bytes, measured with `TextEncoder`, not in string
length. Everything in the file is ASCII except `caption`, which holds
whatever the user typed, so a single accented character makes UTF-16
length disagree with the file on disk and a length-based check report a
truncated write on every save. A guard that cries wolf on notes with
accents in them is worse than no guard.

**Not after every write.** Re-reading and parsing a few hundred KB once a
second while the pen is still moving is the cost Phases E and F were spent
removing. The size check is cheap enough to run every time; the parse is
not, and the first write after an open is where a file that was already
wrong would show it.

## Two devices at once

The ink file syncs like any other file. Because blocks are separate keys,
concurrent edits to *different* blocks merge by key with no conflict.

For the same block on both devices, the existing three-way merge
(`markdown/mergeInkBlocks.ts`) applies unchanged: it matches annotations
by id and keeps both sides' strokes. Its base is what this view last read,
which the block already tracks.

**External modification.** Inkling watches the ink file and reloads blocks
that are not currently being drawn in, so a sync landing mid-read updates
the canvas rather than being overwritten by the next save.

## Reading the old format

`markdown/inkBlockFormat.ts` already parses the in-note JSON and reports
damage. A fence is classified by its content: JSON means the old format,
`file:`/`id:` keys mean the new one. Old blocks keep their current save
path, including the editor write, the fence search and the merge. Neither
path is a fallback for the other.

No conversion command ships. The three notes in this vault are converted
by a one-off script after the feature is verified, checked against the
originals, with the originals kept.

## Shape of the code

New, small, and each testable without Obsidian:

- `markdown/inkFile.ts` — parse and serialize the ink file, including
  per-block compression, the per-block codec, and the classification
  above. Unknown keys and undecodable blocks survive the round trip.
- `markdown/inkFileSalvage.ts` — the scanner: raw text in, blocks
  recovered by id (duplicates as a list) and the ids it could not recover
  out. Pure, no Obsidian, driven entirely by fixtures.
- `markdown/inkFileStore.ts` — one live instance per ink file: reads it,
  holds it, applies per-block updates, queues writes, watches for external
  change, and runs quarantine-salvage-repair when a read does not parse.
  The thing every block in a note shares.
- `markdown/inkFence.ts` — parse and serialize the three-line fence,
  including preservation of unknown keys.
- `markdown/inkFileLinks.ts` — vault-wide fence scan, used by the rename
  rewrite and the unreferenced-blocks command.

`markdown/inkBlock.ts` is 1,366 lines today, most of it the in-note write
path. The new path is a different, much shorter set of responsibilities,
so `InkBlockView` gains a storage backend rather than another branch:
today's in-note logic moves behind one, the ink file store is the other.
The view keeps mounting, the toolbar, the resize handle and the recovery
store, which are common to both.

## Testing

Unit, no Obsidian required:

- Ink file round-trip, including a block with pressure, a block with a
  caption, and unknown keys preserved.
- Compression round-trip and size, asserted against a real block from the
  vault.
- Damage: unparseable file, one unparseable block, a block failing its
  Adler-32 check, a file from a newer version, fence missing a key, fence
  naming a path outside the vault.
- Write queue: two blocks saving at once, a write superseded while queued.
- Fence parse and serialize, including preservation of unknown keys.
- Salvage fixtures: truncated between blocks, truncated mid-base64,
  conflict markers spliced in, a caption holding a brace and an escaped
  quote, trailing garbage after the closing brace, and a file where the
  same id appears twice — which must merge by annotation rather than pick
  a side.
- Write guards: a serialization with no blocks is refused over a file that
  had blocks, and the drawing reaches the rescue store instead; the same
  write is allowed when the unreferenced-blocks command makes it.
- The size comparison is in bytes: a block whose caption holds a non-ASCII
  character does not report a truncated write.
- Carry-through, which is the one that protects the most: a file holding
  an undecodable block, a block with an unrecognised `codec`, an unknown
  key inside a block and an unknown key at the top is rewritten after a
  *different* block is edited, and every one of those survives byte for
  byte.
- Salvaged duplicates merge against an empty base, and no annotation
  present in either copy is missing from the result.

Integration, in the style of `tests/markdown/inkBlockIntegration.test.ts`:

- A save landing after the ink file changed elsewhere merges rather than
  overwrites.
- A missing file in each of the three settings.
- A fence naming a block that is not in the file.
- A damaged file read at open is quarantined, salvaged and rewritten, and
  the blocks that survived are drawable afterwards.
- A damaged read arriving while a note is open does not displace what the
  session holds, and a save made afterwards still lands.
- A quarantine that cannot be written stops the repair: the file is left
  exactly as it was and its blocks go read-only.
- A file from a newer version is never quarantined and never written.
- A read that fails once and parses on the re-read does not repair, and
  leaves no quarantine file behind.
- Undoing a repair does not trigger a second one, and writes no second
  quarantine file.
- The same file damaged the same way twice leaves one quarantine file, not
  two; damaged a second, different way leaves two.
- A copied fence in two notes, edited from both.
- An old-format block in the same note as a new-format one.
- Rename of an ink file rewrites the fences that name it.

Then live verification in the vault, against a copy of the Newton's Laws
note before the real one is touched.

## Non-goals

No preview images, no SVG, no handwriting recognition, no conversion UI,
no change to the PDF side, no per-block files. Each was considered and
declined: SVG and previews cost most of the size saving this exists for,
per-block files mean thousands of files in a vault, and recognition is a
separate feature that this design does not block.

No last-known-good backup file either. A second copy per note would
roughly double the sync traffic for the exact data whose size this design
exists to reduce, and it buys only one case: a file already damaged at
first open, with nothing in memory to fall back on. Salvage usually
recovers most of that case anyway. If it is ever wanted, it is additive
and nothing here forecloses it.

## Consequences accepted

- A repaired file still loses the block that straddled the damage, and
  anything else salvage could not lift out intact.
- Quarantine files sit beside ink files until someone removes them, at
  roughly 350 KB each, on every device. One per distinct damage event, and
  none at all in normal use. Nothing removes them automatically,
  deliberately: a quarantine file can be the only surviving copy of what
  was lost, and the tidy command is where removal lives.
- Repair happens without being asked, so a file is rewritten on open. The
  quarantine copy, the confirming re-read and the undo action are what
  make that acceptable.
- Every save carries one extra `adapter.stat`.
- The repair path is code that should never run in normal use, which makes
  it the code most likely to be wrong on the day it does. The fixtures are
  the mitigation, and the quarantine invariant is what bounds the damage
  when the fixtures turn out to have missed a case.
- A copied fence shares its ink, so editing the copy changes the
  original. This is what the user asked for, and it is the cheap
  behavior; splitting on edit remains possible later.
- Ink filenames drift from note names until the tidy command is run.
- A vault holds two block formats indefinitely.
