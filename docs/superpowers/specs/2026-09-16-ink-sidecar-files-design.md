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
back to storing the block uncompressed rather than failing to save. The
format records the codec in `version`.

Why the structure stays in text: a damaged file can be inspected and
partly rescued by hand, a caption can be fixed in a text editor, and a
three-way sync merge can operate per block. The coordinates are 99% of
the bytes and none of the meaning.

### Damage is scoped as tightly as possible

- A file whose JSON does not parse makes every block in it read-only,
  with a banner. This is strictly worse than today, where damage is
  per block, and it is the main cost of this design.
- A single block whose `strokes` will not decompress or parse is
  isolated: that block is read-only, the rest of the file is normal.
- Read-only means never written over, exactly as now. Any drawing that
  cannot be saved goes to the rescue store (`markdown/inkRecovery.ts`)
  and is written as soon as the file is readable again.

## Where new files go

A setting, defaulting to **follow Obsidian's attachment location** via
`fileManager.getNewFileParent`, so ink lands wherever the user's images
already do without configuring anything. Alternatives: beside the note,
or a named folder.

The setting governs creation only. Changing it never moves an existing
file, and no file is ever relocated as a side effect.

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
  per-block compression and the damage classification above.
- `markdown/inkFileStore.ts` — one live instance per ink file: reads it,
  holds it, applies per-block updates, queues writes, watches for external
  change. The thing every block in a note shares.
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
- Damage: unparseable file, one unparseable block, fence missing a key,
  fence naming a path outside the vault.
- Write queue: two blocks saving at once, a write superseded while queued.
- Fence parse and serialize, including preservation of unknown keys.

Integration, in the style of `tests/markdown/inkBlockIntegration.test.ts`:

- A save landing after the ink file changed elsewhere merges rather than
  overwrites.
- A missing file in each of the three settings.
- A fence naming a block that is not in the file.
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

## Consequences accepted

- One corrupt ink file affects a note's blocks rather than one block.
- A copied fence shares its ink, so editing the copy changes the
  original. This is what the user asked for, and it is the cheap
  behavior; splitting on edit remains possible later.
- Ink filenames drift from note names until the tidy command is run.
- A vault holds two block formats indefinitely.
