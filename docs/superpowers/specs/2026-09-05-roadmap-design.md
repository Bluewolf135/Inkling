# Inkling roadmap — Tracks A–D design

Status: design
Date: 2026-09-05
Supersedes nothing. Track A's detailed design lives in its own document
(`2026-09-04-write-safety-design.md`) and is summarised here rather than
repeated.

## Why this exists

Inkling today is a competent PDF drawing layer that happens to run inside
Obsidian. The audit that produced this document found fifteen things worth
doing; grouped by subsystem and risk they fall into four tracks. This is
one design document for all four, because they were commissioned together
and because several of them touch the same files and need to agree with
each other up front.

The through-line: **the reason to use Inkling instead of Xodo is that the
knowledge stays in the vault.** Track C is that reason made real. Tracks A
and B are what make it safe and pleasant to get there, and D is the surface
that makes it a product rather than a personal tool.

## Global constraints

These bind every track. Copied forward from `ink-annotation-plugin-plan.md`
and the Track A spec.

- `isDesktopOnly: false`. No Node or Electron APIs anywhere in `src/`,
  including transitively. All vault I/O goes through `Vault` or
  `vault.adapter`.
- No network calls at all. No CDN assets, no telemetry, no update pings.
- No new runtime dependencies. Everything below is built from what is
  already in `package.json` plus the Obsidian API.
- `pdf-lib` stays at 1.17.1 and `pdfjs-dist` at 5.4.530. Both pins are
  load-bearing and documented at `src/pdfView.ts:10`.
- Untrusted content (ink block bodies, PDF annotation text, extracted
  quotes) is parsed defensively and rendered with `textContent` / safe DOM
  APIs, never `innerHTML`.
- Minimum Obsidian version 1.4.4.
- `strict` and `noUncheckedIndexedAccess` are on.

## Track ordering

A → B → C → D, and the dependencies are real rather than a preference:

- **A before everything.** B rewrites how strokes are captured and C
  changes what gets written into the PDF. Both are edits to the write path,
  and today there is no test harness and no verification under either.
- **B before C.** C's comment tool and text capture are new annotation
  kinds flowing through the same serializer B is about to change. Doing B
  second means writing that serializer once.
- **D last.** Its settings tab adopts preferences that B and C introduce.
  Until then those are module constants, which is also how Track A left the
  values it introduced.

---

# Track A — Safety net

Fully designed in `docs/superpowers/specs/2026-09-04-write-safety-design.md`
and planned in `docs/superpowers/plans/2026-09-04-write-safety.md`. In
brief, nine tasks:

1. Vitest over the pure modules (`geometry`, `eraser`, `toolState`,
   `inkBlockFormat`).
2. GitHub Actions running lint, tests, build.
3. Stop rewriting a PDF just because it was opened.
4. Scale the save ceiling to file size (10s / 30s / 60s).
5. A structural fingerprint of a `PDFDocument`.
6. Verify every save against that fingerprint before the bytes leave the
   writer worker.
7. Atomic binary replace through a scratch file outside LiveSync's walk.
8. A structure profile both `pdf-lib` and `pdf.js` can produce.
9. Open read-only when the two parsers disagree, or when the document
   declares forms/signatures.

Nothing in this document changes any of that. Two forward references worth
naming now:

- The fingerprint deliberately **excludes Inkling's own annotations**, so
  every new annotation kind Tracks B and C introduce is automatically
  outside verification's scope, provided it is tagged with the `ink-` `/NM`
  prefix. Every writer added below must go through `tagAndAdd`.
- The read-only gate is the single mechanism for "this document may be read
  but not written". Tracks B and C add no second one.

---

# Track B — Feel

Fifteen minutes with a stylus is enough to notice that Inkling's ink is
uniform-width, faceted, and locked at one zoom on desktop. This track is
about the part you feel every time you pick up the pen.

## B.1 Stroke quality

Three changes that compound, and are worth nothing individually.

### Coalesced events

A 120 Hz stylus delivers several samples per animation frame. The browser
hands over only the last one per `pointermove` unless
`getCoalescedEvents()` is called. Inkling never calls it, so most of the
input resolution is being discarded before smoothing ever gets a chance.

`attachPointerGestures` gains a coalesced-sample loop in `onPointerMove`,
feeding every sample through the existing `toPoint` conversion and calling
`handlers.onMove` once per sample. `getCoalescedEvents` is guarded — it is
absent on some WebViews, and returns an empty array on others, in which
case the event itself is the only sample.

This is a pure input-density change: the controller's `handleMove` already
just pushes points, and the overlay is repainted once per handler call,
which is unchanged in cost per frame because the samples arrive batched
inside one event.

### Pressure

`Point` gains an optional `p?: number` in `[0, 1]`.

Optional, not required, and that is the whole compatibility story: every
annotation already in a vault, every persisted ink block, and every `/Ink`
read back from a PDF parses unchanged and simply has no pressure. A stroke
with no pressure on any point renders exactly as it does today.

Pressure is read from `PointerEvent.pressure`, and only for
`pointerType === 'pen'`. A mouse reports a constant 0.5 while a button is
down, which would make every desktop stroke a uniform ribbon at half
weight — worse than no pressure at all. Touch is not a drawing pointer
here.

Rendering: a stroke that carries pressure is drawn as a **filled
variable-width outline** rather than a stroked polyline. The half-width at
each sample is `baseWidth * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE)
* p) / 2`, with `MIN_PRESSURE_SCALE = 0.35` so a light touch thins the line
without breaking it. The outline walks the points offsetting by the
per-point normal on one side and back down the other, and is closed with
round caps.

The highlighter never varies: a highlighter that tapers looks like a
mistake, and its snapped form (§C.1) is a straight segment at line height
anyway.

### Smoothing

`render.ts` draws raw `lineTo` between samples. Combined with the dropped
samples above, fast handwriting comes out visibly faceted.

Quadratic midpoint smoothing: the curve passes through the midpoint of
each consecutive pair of samples, using the sample itself as the control
point. It needs no lookahead, no tension parameter, and no special casing
for the ends beyond a `lineTo` for the first and last half-segment — which
matters because the same geometry has to be emitted twice, once to a canvas
and once to a PDF content stream, and a scheme with fewer degrees of
freedom is a scheme those two can't disagree about.

### Where the geometry lives

A new pure module, `src/annotate/stroke.ts`, is the single source of both
shapes:

```
smoothedPath(points: Point[]): PathSegment[]
outlinePath(points: Point[], baseWidth: number): Point[]
hasPressure(points: Point[]): boolean
```

`PathSegment` is `{ kind: 'move' | 'line'; to: Point } | { kind: 'quad';
control: Point; to: Point }` — an abstract path that `render.ts` walks with
canvas calls and `contentStream.ts` walks emitting `m` / `l` / `v`
operators. Neither renderer owns geometry, which is what stops the canvas
and the PDF drifting apart. It is also the only part of this that is worth
unit-testing, and being pure, it can be.

### Serializing pressure

`/Ink`'s `/InkList` is a flat list of coordinates with no per-point width;
there is nowhere in the standard to put pressure. Two consequences:

- `/InkList` keeps the raw points, unchanged, so any other PDF reader still
  sees the stroke's path.
- The `/AP` appearance stream — which is what every viewer actually draws —
  becomes a filled path (`f`) built from `outlinePath` when pressure is
  present, and a smoothed stroked path (`S`) when it is not.
- Pressure itself round-trips through a private annotation entry,
  `/Inkling << /P [ ... ] >>`, one number per point, written as integers in
  0–255 to keep the file small. `pdf-lib` preserves dictionary entries it
  does not understand, and other viewers ignore keys they don't know. On
  read, a `/P` array whose length disagrees with the point count is
  discarded rather than interpolated.

This private dictionary is deliberately introduced here rather than in
Track C, because C needs the same mechanism for quoted text and it should
exist once.

## B.2 Zoom on desktop

Zoom today exists only inside `pointer.ts`'s pinch handler, so a desktop
mouse is locked at `RENDER_SCALE`.

The zoom model itself is not changed: it stays per-page, a CSS transform on
`.inkling-page-content`, with `upgradeResolution` re-rendering the page
sharper once the gesture settles. Changing it to a document-level zoom
would mean re-laying-out every placeholder and reprojecting every stored
annotation, which is a different project.

Added:

- **Ctrl/Cmd + wheel** over a page zooms it about the cursor, using the
  same anchor math the pinch already uses. Debounced into the same
  `onZoomEnd` so a scroll wheel does not trigger a re-render per notch.
- **Toolbar `+` / `−` / reset** buttons acting on the current page.
- The existing zoom readout becomes clickable to reset to 100%.

A plain wheel keeps scrolling the document. That is the one thing a reader
would be annoyed to lose.

## B.3 Keyboard

Two layers, because they answer different needs:

- **View-scoped keys**, handled on the annotate view's `contentEl` via
  `registerDomEvent`: `s` select, `p` pen, `h` highlighter, `e` eraser,
  `l` line, `r` rectangle, `o` oval, `a` arrow, `n` note (Track C), `1`–`6`
  the preset colours, `[` / `]` width down/up, `Delete`/`Backspace` delete
  selection, `Mod+Z` / `Mod+Shift+Z` undo/redo, `PageUp`/`PageDown` page,
  `Mod+=` / `Mod+-` / `Mod+0` zoom. Safe as bare letters because the
  annotate view contains no text input; the handler bails when the event
  target is an `input`, `textarea`, or `contenteditable`.
- **Palette commands** for undo, redo, and "next tool" — registered without
  default hotkeys, per Obsidian's guidelines, so a user who wants global
  bindings can make them.

## B.4 Navigation

Entering annotate mode currently throws away the outline, the page jump,
and search. For a 900-page textbook that is most of how you get around.

- **Page jump.** The toolbar's `12 / 195` readout becomes a number input
  plus the total. Enter jumps.
- **Outline.** `pdf.getOutline()` gives a tree of `{ title, dest, items }`.
  A collapsible panel inside the view lists it; clicking an entry resolves
  its destination through `pdf.getDestination` / `pdf.getPageIndex` and
  scrolls there. Documents with no outline hide the control entirely rather
  than showing an empty panel.
- **Find.** A search field that scans pages' `getTextContent()` on demand,
  in order, reporting matches as it goes and letting the reader jump
  between them. Incremental and cancellable, because on a 900-page scanned
  book it is genuinely slow and may find nothing at all. Matches are
  located to the page, not highlighted in place — highlighting would mean
  maintaining a text layer over every page, which this view deliberately
  does not have.

The panel (outline + find) is one collapsible sidebar, closed by default,
so nothing about the current layout changes for someone who never opens it.

## B.5 Toolbar collapse

The strip eats a real slice of a phone screen in portrait. A chevron button
at its end collapses it to a single row holding the active tool, undo, and
the chevron. State lives on `ToolState` (which already outlives the
per-file view rebuilds) and is persisted by Track D.

---

# Track C — Annotations as notes

The reason to build this at all.

## C.1 Capturing what a highlight covers

This needs no new interaction, which is the important part. The user's
highlighter gesture — a freehand drag over text — stays exactly as it is.

`snapHighlighterStroke` already computes which text lines a stroke swept
and clips each to the x-range the stroke actually covered.
`computeTextLines` already reads `item.str`, uses it to skip blanks, and
throws the string away. Carrying it through is the entire change.

`TextLine` gains `items: { minX: number; maxX: number; text: string }[]`,
built from the same boxes already being grouped into lines. Clipping to the
stroke's x-range selects **whole items** whose x-extent overlaps the
stroke, not partial ones: pdf.js reports an item's total width but not its
per-glyph positions, so a partial clip would be a linear guess that cuts
words in half on any proportional font. Whole items over-capture slightly
at the ends of a drag, which is the right way to be wrong.

Because the match is geometric, it also works **retroactively**: any
existing highlight — including one made in Xodo, which has a `/Rect` and no
Inkling tag — can have its quote recomputed at extraction time by
intersecting its geometry with the page's text lines. Stored quotes are an
optimisation, not the mechanism.

`Annotation` gains two optional fields on the base type:

- `quote?: string` — text the annotation covers.
- `note?: string` — what the user wrote about it.

Serialization: `note` goes in the annotation's `/Contents`, which is the
standard field and means other PDF readers show it as a tooltip. `quote`
goes in the private `/Inkling` dict from §B.1 as `/Q`, because `/Contents`
holding both would be ambiguous on read-back.

## C.2 A comment tool

A new tool, `'note'`. Tap a spot on a page; a small popover opens; type;
it commits.

- New annotation kind: `NoteAnnotation { kind: 'note'; at: Point; note:
  string }`. It has a colour (matching the pen colour, so colour-as-
  category works the same way) and no width.
- Rendered as a small rounded marker with a fold, drawn at a fixed canvas
  size independent of zoom, so it stays tappable on a phone.
- Hit-tested as a fixed-radius disc around `at`.
- Serialized as a PDF `/Text` annotation (a sticky note) with `/Contents`,
  `/Name /Comment`, and an `/AP` stream drawing the same marker — so it
  shows up correctly in Xodo, Acrobat, and Obsidian's own reader.
- Editing: tapping an existing note with the select tool opens the same
  popover. The popover is plain DOM built with `createEl`, positioned
  against the page element, and its text is set with `textContent`.

## C.3 Extract to note

A command, **"Extract annotations to a note"**, available on the annotate
view and on any `.pdf` in the file explorer.

Output is one Markdown note per PDF, at a configurable path (Track D;
default `<pdf folder>/<pdf basename> — annotations.md`).

**Structure.** The generated content lives inside a managed region:

```markdown
%% inkling:begin — generated, edits inside this block are replaced %%
...
%% inkling:end %%
```

Everything outside the markers is the user's and is never touched, so a
note can carry an intro, tags, links, and outgoing thoughts across
re-runs. Inside, the region is rebuilt from scratch on every run. This is
a deliberate simplification over trying to merge per-annotation: a
predictable rule the user can plan around beats a clever one they have to
reverse-engineer when it guesses wrong. The marker line says so in the
note itself.

**Content.** Grouped by page, ascending; within a page, ordered top to
bottom by the annotation's `/Rect`. Each entry:

```markdown
- **p. 42** · <colour label> — > the quoted text
  <the user's note, if any>
  [[book.pdf#page=42]] ^ink-3f9a2c
```

The trailing `^ink-...` is an Obsidian block reference built from the
annotation's own id, so any note in the vault can link to a specific
highlight and the link survives re-runs.

**Colour as category.** The preset palette's labels (Ink, Red, Orange,
Green, Blue, Purple) become the category names, and Track D lets the user
rename them (so "Yellow = definition, Red = disagree" works). An
unrecognised colour is rendered as its hex value rather than dropped.

**Sources.** Both Inkling's own annotations and foreign ones. Foreign
highlights (`/Highlight`, `/Square`, `/Ink` without our `/NM` tag) get
their quote recomputed geometrically and are labelled as external, so a
book marked up in Xodo before Inkling existed extracts too. Foreign
annotations are read only; extraction never writes to the PDF.

**Idempotence.** Running twice with no new annotations produces a
byte-identical managed region. That is the property the tests pin down.

## C.4 What this deliberately does not do

- No `/Highlight` / `/Underline` / `/StrikeOut` subtypes. The audit
  recommended them; on reflection they buy little here. Inkling's snapped
  highlighter already produces a straight, line-height, translucent `/Ink`
  at exactly the covered text, which renders correctly everywhere, and
  extraction works off geometry rather than subtype. Switching subtype
  would change how every existing highlight in the user's vault reads back.
- No text-selection interaction. The freehand drag is the interaction the
  user built this around and asked to keep.
- No sync back from the Markdown note into the PDF. One direction only.

---

# Track D — Polish

Independent, low-risk, and the part that makes this installable by someone
else.

## D.1 Settings

The first task in the track, because everything else in it and several
constants from B and C become settings.

`PluginSettingTab` plus `loadData`/`saveData`, with defaults that reproduce
today's behaviour exactly:

| Setting | Default |
|---|---|
| Default note template | Blank |
| Handwritten note page size | Letter |
| Save cadence | Automatic (Track A's size-scaled values) |
| Pressure sensitivity | On |
| Stroke smoothing | On |
| Shape recognition | Hold to snap |
| Dark-mode page inversion | Follow theme |
| Toolbar starts collapsed | Off |
| Extraction note path | `<folder>/<name> — annotations.md` |
| Colour category labels | The palette's own labels |
| Open PDFs in Inkling by default | Off |

## D.2 Dark-mode page inversion

Reading a white textbook page inside a dark Obsidian is genuinely
unpleasant, and the core viewer does not solve it either.

A CSS filter — `invert(1) hue-rotate(180deg)` — applied **only to
`.inkling-pdf-page`**, the canvas holding the rendered PDF. The annotation
layers stacked above it are untouched, so ink keeps its real colours
against an inverted page. That separation is only possible because the
annotation canvases are already separate elements; it is the reason this is
a small change.

Three states: off, on, follow theme (invert when Obsidian is in a dark
theme). A toolbar toggle flips it for the session.

## D.3 Shape recognition

A pure module, `src/annotate/recognize.ts`:

```
recognizeShape(points: Point[]): { tool: ShapeToolType; start: Point; end: Point } | null
```

- **Line** when the maximum perpendicular deviation from the chord is under
  a fraction of the chord's length.
- **Closed** when the endpoints are within a fraction of the path length of
  each other. Then **oval** when the radial distances from the centroid
  have low variance, **rectangle** when the direction histogram clusters
  into four axis-ish groups.
- `null` for anything else, which is most handwriting, and the stroke
  commits as drawn.

Trigger: **hold to snap**. If the pen dwells at the end of a stroke —
little movement for `SHAPE_HOLD_MS` before lifting — recognition runs. This
is the gesture GoodNotes and OneNote use, needs no new UI, and is opt-in
per stroke, so ordinary handwriting is never rewritten behind the user's
back. The controller already tracks the drag; it gains a last-moved
timestamp.

## D.4 README and release

- A README with what it is, a feature list, install via BRAT, the mobile
  story, and explicit places for a writing GIF and two screenshots. The
  images themselves need a device and a stylus, so they are the user's to
  capture; the README ships with the sections and named file paths ready.
- A release workflow attaching `main.js`, `manifest.json`, `styles.css`,
  `pdf.worker.js`, and `annotation-writer.worker.js` to a tag. Track A
  deliberately left this out; it is the prerequisite for BRAT and for the
  community catalogue, so it belongs here.

---

## Testing strategy

Track A establishes Vitest over the pure modules. Every track below adds to
the same suite, and the same rule applies: **pure logic is unit-tested,
everything else is confirmed on a device.**

Unit-testable, and tested:

- `stroke.ts` — smoothed path shape, outline closure and width response to
  pressure, degenerate inputs (one point, two identical points).
- `recognize.ts` — a hand-shaky circle, square, and line recognised; a
  letter and a scribble refused.
- Text capture — line grouping and item clipping against synthetic pdf.js
  text-content shapes.
- Extraction — grouping, ordering, colour categorisation, the managed
  region's boundaries, and idempotence across two runs.
- Annotation round trips for every new kind and field: pressure, quote,
  note, and the `note` annotation, through a real `pdf-lib` save and
  reload.

Device-confirmed, because simulated tests cannot reach them:

- That coalesced events actually arrive on the S Pen, and that pressure
  varies as expected.
- That variable-width ink looks right, which is a judgement no assertion
  makes.
- That the collapsed toolbar and the navigation panel work in portrait.
- That an extracted note's links open the right page.

## Open questions

- **Coalesced-event volume on a 120 Hz panel.** Every sample becomes a
  stored point, which means larger `/InkList` arrays and larger files. If
  it proves excessive, the fix is a distance-based decimation on commit
  (drop samples closer than a fraction of a point apart) — cheap, and it
  can be added without changing anything else. Measure first.
- **Whether whole-item quote clipping over-captures enough to annoy.** The
  alternative is proportional character clipping, which is a guess. Worth
  living with the honest version first.
- **Outline destination resolution.** pdf.js destinations come in several
  shapes; some documents use named destinations that need a second lookup.
  Anything that fails to resolve is skipped rather than shown as a dead
  entry.
