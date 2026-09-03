# Inkling — Obsidian Ink Annotation Plugin — Project Plan

## Name & branding

**Inkling** is the plugin's name. Manifest `id`: `inkling` (short, lowercase,
no "obsidian" substring — compliant with the naming rule under Hard
requirements). Logo concept: a small squid or octopus — an ink pun, and a
friendly, distinctive mark for the eventual community directory listing.
Branding/icon work is not part of the MVP build order below; noted here so
Claude Code doesn't invent a different name or placeholder branding on its
own.

## Goal

A new, from-scratch Obsidian community plugin (not a fork) for handwritten and
text-based annotation of Markdown notes and PDFs, built mobile-first for
stylus input (Apple Pencil / Samsung S Pen), writing annotations directly
into the source file rather than a separate cache. The toolset itself should
feel like a normal PDF editor's full suite — pen, highlighter, select/resize,
etc. — just native to Obsidian, not a trimmed-down subset of one.

This replaces the workflow of using a separate app to mark up PDF textbooks
and technical docs, and extends it to Markdown notes via inline handwriting
blocks.

## Why not fork the existing plugin

Reference: github.com/jepicaju862-lab/ink-annotation (GPL-3.0-or-later).
An audit of it showed it needs enough work that a clean rewrite is the better
path. Its core design (ink stored as a sidecar `.ink.json`, source file never
touched) is also the opposite of the write-into-source behavior we want, so a
fork would mean rebuilding most of the write path anyway.

## Hard requirements

- **Mobile is the primary target**, not an afterthought. Must run well on
  Obsidian iOS/iPadOS and Android with a stylus.
- **`isDesktopOnly: false`** — no Node.js or Electron APIs anywhere,
  including in dependencies. All file I/O goes through Obsidian's Vault API
  (`vault.readBinary`, `vault.modifyBinary`, etc.), never raw `fs`.
- **No network calls at all** — stricter than Obsidian's own policy (which
  only requires disclosure). No CDN-loaded assets, no telemetry, no
  update-check pings.
- **Supply chain hygiene** — small, well-maintained dependency list, lockfile
  committed, no obfuscated/minified-to-hide-behavior output.
- **Meets Obsidian's Developer Policies** for eventual community directory
  submission: no obfuscation, no ads, no telemetry, manifest `id` must not
  contain the substring "obsidian", semver versioning.
- Written in TypeScript against the official `obsidian` npm package types.
- **Repo starts empty; Claude Code clones the official Obsidian sample
  plugin template** (`obsidian-sample-plugin` on GitHub) into it as the
  starting scaffold, rather than hand-building `manifest.json`,
  `package.json`, `tsconfig.json`, and the esbuild config from scratch —
  it already has the correct shape Obsidian expects, which avoids subtle
  packaging bugs. You create and clone the empty repo yourself; Claude
  Code works from that local clone.
- **License: MIT**, confirmed.

## Core feature set (MVP)

### PDF annotation (primary use case: marking up textbooks/technical docs)
- Render PDFs with `pdf.js` (same renderer Obsidian's built-in PDF viewer
  uses — stay consistent with the platform rather than shipping a second
  PDF engine).
- Uses the shared annotation toolset below (highlight/underline/
  strikethrough on selected text, freehand ink for diagrams and marginalia
  that isn't text-selectable).
- Annotations are written directly into the PDF using `pdf-lib` (pure JS,
  no Node dependency, works on mobile) as real PDF annotation objects — see
  Architecture notes for write timing and format details.

### Markdown annotation
- Uses the shared annotation toolset below — highlight/underline/
  strikethrough on rendered note text, plus inline handwriting blocks:
  freehand ink anchored to a position in the rendered note, drawn on an
  overlay layer (same rendering approach as the reference plugin).
- **Insertion UX**: a registered Obsidian command ("Insert ink annotation
  block" or similar), invoked via the command palette (Ctrl+P desktop,
  swipe-down command menu on mobile) — not a slash-command or ribbon icon —
  inserts a new empty ink block at the cursor position.
- Strokes are written directly into the note as structured data inside a
  dedicated block (not a flattened image — see Architecture notes).
  Plugin-only rendering is an accepted tradeoff here, unlike PDF.

### Shared annotation toolset

One tool module, built once, used identically by the PDF view and the
Markdown view — not two separate implementations. Standard PDF-editor-style
assortment:

- **Highlight** — multiple preset colors + custom color picker.
- **Underline** and **strikethrough** — same color options as highlight.
- **Freehand pen** and **highlighter** (semi-transparent) — adjustable
  stroke width (slider + numeric input) and color.
- **Eraser** — removes strokes; adjustable size/radius (same as pen/
  highlighter width control), plus a "clear all" action. Shows a hollow
  circle outline at the pointer, sized to the current erase radius, so it's
  clear what will and won't be caught — tracked via a `pointermove`-driven
  hover signal independent of any active gesture (so it also updates while
  actually erasing, not just before), hidden on pointer-leave or switching
  away from the tool.
- **Note/comment** — attach a text note to a highlighted selection or a
  point on the page.
- **Select/lasso** — freeform or rectangular selection over existing
  strokes/annotations, with move, recolor, resize, and delete — the same
  standard suite of edit actions any PDF editor gives you once something's
  selected. Annotations must remain editable indefinitely, not just in the
  session they were created. This is core toolset parity, not a stretch
  feature — treat it with the same priority as the pen/highlighter tools,
  not as something to trim if time is short.
- **Shape tools** — line, rectangle/oval, arrow, in the same color/width
  options as the other tools. Not previously in this doc — added because
  Xodo (your current reference app) includes these as standard, and useful
  here for boxing equations or circling a diagram cleanly rather than
  freehanding it. Assumption, flagged: stamps, signatures, and form-filling
  — also standard in general PDF apps like Xodo — are left out, since
  they're not relevant to reading/marking up textbooks. Say so if that's
  wrong.
- **Undo/redo.**
- Pointer Events API (`pointerType === 'pen'`) for all drawing input, with
  palm rejection (finger = pan/scroll, pen = draw) — required for both
  Apple Pencil and S Pen to work correctly and to avoid stray touch strokes.
  Verify on a real Android/S Pen device early — Pointer Event behavior for
  stylus varies across Android vendors/WebViews in practice, don't trust
  the spec alone. (An explicit hand/pan tool existed briefly as a
  belt-and-suspenders option alongside pointer-type-based rejection, while
  that rejection was still unreliable — removed once real-device testing
  confirmed automatic touch-vs-pen differentiation works correctly on its
  own; see the panning fix below.)
  Real-device testing (Samsung S Pen) surfaced several bugs since fixed,
  across two passes:
  1. Strokes landing diagonally off from the actual pen tip, worse further
     from the page's top-left corner — the canvas's on-screen (CSS) size
     can differ from its backing-store pixel size (e.g. a page placeholder
     shrunk to fit a narrow phone screen via `max-width: 100%`, invisible
     on a wide desktop window where that never kicked in), and pointer
     coordinates need scaling by that ratio before use, not used as raw
     CSS-pixel offsets. Verified with a simulated-input test.
  2. A second pointer appearing mid-stroke (e.g. a palm the device
     misreports as `pointerType: 'pen'` rather than `'touch'`) was
     hijacking the active gesture instead of being ignored — added a
     contact-geometry heuristic (reject an implausibly wide "pen" touch) as
     a second, independent palm-rejection signal on top of `pointerType`,
     for exactly that kind of device misreport. Verified with a
     simulated-input test.
  3. The page would still pan mid-stroke, and downward strokes/eraser
     drags in particular would just silently fail to do anything. Root
     cause: `touch-action: pan-y` (needed so touch keeps scrolling between
     strokes) doesn't just permit touch to pan — it authorizes the browser
     to recognize a vertical pan from *any* pointer's movement without
     waiting on `preventDefault()`, so a downward pen/eraser drag could get
     taken over mid-gesture. Two attempts before the real fix, both
     insufficient on the test device (a real device was needed to find
     that out each time, since simulated `PointerEvent`s don't exercise
     native gesture recognition the way real hardware input does): calling
     `preventDefault()` on every `pointermove` too, not just `pointerdown`;
     then dynamically toggling `touch-action` to `none` for the duration of
     each gesture. Properly fixed by giving up on native `touch-action`-driven
     panning altogether — the canvas is `touch-action: none`
     unconditionally, and touch panning is instead implemented by hand
     (tracking the pointer and adjusting the scroll container's
     `scrollTop` directly), for deterministic behavior independent of any
     browser/OS gesture-recognition timing. This is what let the hand/pan
     tool be removed again afterward (see above) — with panning fully
     decoupled from pen/mouse input rather than merely deprioritized by
     `pointerType`, there was nothing left for a manual override to do.
     Verified with simulated-input tests: a full pen down-move-up sequence
     no longer moves the scroll position at all, and a touch drag scrolls
     correctly. Confirmed on the real device afterward — this is the fix
     that actually held up.
  4. Downstream of (3): when the browser *did* still hand a gesture off
     mid-stroke, it fires `pointercancel` — and a cancelled draw/erase was
     being silently discarded rather than keeping whatever was captured so
     far, which is what actually made downward strokes and erasing look
     like they "didn't work" (nothing had committed, so there was also
     nothing for Undo to undo). Draw/shape gestures now commit on cancel
     the same as a normal pointerup; erase/move/resize still revert on
     cancel, since undoing a cut-short *mutation* of existing annotations
     is safer than risking a half-applied one. Verified with a
     simulated-input test (a synthetic `pointercancel` mid-stroke now
     correctly commits the partial stroke and undo/redo operate on it).
  5. The width slider (and other toolbar controls) dragged near a screen
     edge got picked up by Obsidian mobile's own edge-swipe-to-open-sidebar
     gesture instead of the control itself — same class of native-gesture
     hijack as (3), just a different app-level gesture recognizer. Fixed
     with `touch-action: none` on the toolbar itself.
  6. The eraser only checked distance to a stroke's *stored points*, not to
     the line segments between them — so erasing along a stroke wherever
     its sample points happened to be sparser than the eraser radius (a
     fast stroke, in particular) silently did nothing, while erasing right
     on top of a point worked fine. Reported as "erase only works on this
     session's strokes, not ones saved from before" — plausible since a
     freshly-drawn stroke's points are dense right where you're erasing if
     you erase right after drawing, while a saved-and-reloaded stroke you
     come back to later doesn't have that correlation. Undo and Clear page
     were also reported broken the same way, but neither reproduced as a
     real bug under direct testing (both correctly affect previously-saved
     annotations, not just ones drawn this session) — most likely the same
     underlying eraser bug read as "nothing to undo" once erasing itself
     silently failed. Fixed by also checking each segment's distance to
     the eraser (matching the select tool's existing hit-testing), not
     just each point's. Verified with a simulated-input test: erasing
     exactly at a sparse segment's midpoint, on a stroke reloaded from a
     previous session, now correctly removes it.
  (3)'s fix required a ground-up rewrite of how panning works, not a small
  patch, precisely because two earlier native-`touch-action`-based attempts
  both looked correct and both failed on the real device. Confirmed on the
  real device: writing no longer drags the page in either direction, and
  the automatic touch-vs-pen split works well enough on its own that the
  hand/pan tool workaround was removed (see above).
- **Full-width top toolbar** (Xodo/Samsung-Notes style — spans the view,
  sticky to the top of the scrollable page area), not a small draggable
  floating palette as originally sketched here — reversed after seeing the
  first pass in practice. Collapsible still applies (more important on
  mobile given screen real estate); dragging does not, since there's
  nowhere meaningful to drag a full-width bar to.

In the PDF view, highlight/underline/strikethrough operate on
text-selection (via `pdf.js` text layer). In the Markdown view, they operate
on rendered note text the same way. Freehand pen/highlighter/eraser work
identically in both — same canvas-overlay drawing code, just layered over a
different document type underneath.

## Explicitly out of scope for MVP
- Cross-device annotation search/index ("annotation center").
- Any licensing/paywall mechanism.
- EPUB support.

### Standalone handwritten notes (blank-template PDFs)

A third annotation mode, alongside PDF markup and Markdown ink blocks: a
complete handwritten note with no underlying Markdown text, backed by a PDF
the plugin generates from a template rather than one the user already has.
Functionally this is still the PDF view from the section above — same
`PdfAnnotateView`, same shared toolset, same native-annotation write path —
just opened on a file the plugin created instead of one the user imported.
The only genuinely new pieces are template generation and page management.

- **Creation UX — both entry points**:
  - A command-palette command ("Create handwritten note"), matching how the
    Markdown ink-block insertion works (command palette, not ribbon) —
    prompts for a template choice and a name/location, then creates and
    opens the file.
  - A file-explorer entry point ("New handwritten note") alongside
    Obsidian's built-in "New note" / "New folder" actions, for
    discoverability, using the same creation flow underneath.
- **Templates**: three choices at creation time — blank, lined, dot-grid.
  Generated programmatically with `pdf-lib` at creation time (draw the
  ruling/dot grid as vector content on an otherwise blank page) rather than
  shipping static template PDF files as bundled assets — keeps the
  dependency surface and repo contents smaller, and guarantees the template
  page size matches whatever the plugin standardizes on.
  - Default page size: US Letter (612×792pt @ 72dpi). Flag if A4 (or a
    configurable default) is actually what you want — this was picked as a
    reasonable default, not requested explicitly.
- **Page management ("Add page")**: a floating-toolbar button (available in
  this mode; not meaningful for an arbitrary imported PDF) that inserts a
  new page **after the currently-viewed page**, not just appended at the
  end — lets a note grow in the middle, not only at the tail.
  - The new page matches the note's existing template style (blank/lined/
    dot-grid), not a hardcoded default. Since a PDF has no natural place to
    record "which template this is," the style is written once at creation
    time into the PDF's Info dictionary `Keywords` field (e.g.
    `inkling:template=dot-grid`) and read back on "Add page" — no sidecar
    file, consistent with the plugin's no-sidecar-store rule elsewhere.
- Reuses the PDF write path (step below) for the actual page-insert
  mutation — `vault.readBinary` → `pdf-lib` page copy/insert →
  `vault.modifyBinary` — the same primitive used later for annotation
  writes, just simpler (whole-page copy, no coordinate transforms).

## Architecture notes

- **File I/O**: Vault API only. Read PDFs as bytes via `vault.readBinary()`,
  write back via `vault.modifyBinary()`. Never touch the filesystem directly.
- **Editability is a hard constraint** — lasso-select, move, recolor, and
  delete must keep working on annotations after the file is closed and
  reopened later, not just in the session they were created in. This rules
  out any format that bakes strokes into a flat raster/rasterized-only
  representation.
- **No sidecar store.** Annotations are written directly into the PDF/note
  as the single source of truth — no separate JSON cache. Editability
  (lasso/select/edit-later) still holds without one, because it comes from
  writing *native* PDF annotation objects (below), which get parsed back
  out of the PDF itself on reopen.
- **Write granularity.** In-progress stroke points stay in memory until
  pointer-up, as normal. On stroke/annotation completion, commit to the
  file — but debounce rapid successive edits (e.g. ~1-2s of inactivity)
  rather than doing a full PDF re-serialization on every single completed
  mark, since `pdf-lib` rewrites aren't incremental. Force a write on file
  close / view teardown so nothing pending is lost — but "on file close"
  isn't the only path that discards in-memory state; the view's own
  teardown (called at the *start* of loading any file, including
  re-loading the one already open, to reset for the incoming one) does
  too, with no save of its own. Found by real-usage testing (rapid
  open/edit/close/reopen cycles making "different things appear and
  vanish"): a debounced write still waiting out its delay when `onLoadFile`
  fires again on the same view — without a preceding `onUnloadFile`, which
  can happen — was silently discarded. Fixed by flushing unconditionally at
  the top of `onLoadFile` too, not just `onUnloadFile`, using a
  self-tracked "current file" reference rather than `FileView`'s own
  `this.file` (whose value at that exact transition point isn't something
  the public API documents, so it's not safe to assume which file it
  points to there).
- **Write must be idempotent/re-runnable.** Tag each annotation with a
  stable ID so re-committing after further edits updates/replaces that
  annotation instead of duplicating a second copy on top of the first.
- **Must gracefully handle foreign annotations.** Since state lives only in
  the PDF itself (no private format we fully control), opening a PDF that
  already has annotations from other software (Acrobat, Xodo, etc.) means
  our parser will encounter annotation types/structures we didn't create.
  Real interop bonus (can display/select annotations made elsewhere), but
  requires the lasso/edit logic to degrade gracefully — render what it can,
  don't crash or corrupt on annotation shapes it doesn't fully recognize,
  and be conservative about which foreign annotation types it allows
  editing (vs. just displaying).
  **Update**: `pdf.js`'s own page render (`page.render()`) bakes
  `/Annots` — including our own, since they carry real `/AP` appearance
  streams for other viewers' sake — onto the same static canvas as the
  page content by default (`AnnotationMode.ENABLE`). That duplicated our
  own live overlay, and since the baked copy only updates on a full page
  reload, an edit (erase, move, ...) updated the overlay instantly but
  looked like it silently "didn't work" until the file was closed and
  reopened. First fix (`AnnotationMode.DISABLE`) solved that but
  traded away `pdf.js`'s baked rendering of *foreign* annotations
  entirely, since that flag is all-or-nothing per render call — not
  acceptable as a lasting answer. Properly fixed by keeping
  `AnnotationMode.ENABLE` and instead giving `pdf.js` a *display copy* of
  the bytes with only our own (`ink-`-tagged) annotations stripped out —
  built once per file open via the same `pdf-lib` parse already needed to
  read our annotations back for the overlay (`stripInklingAnnotations`,
  skipped entirely when there's nothing of ours to strip, which is the
  common case for a plain book with no Inkling edits yet, so no added cost
  there). The real file on disk is untouched — full annotations, ours and
  foreign, exactly as before. So: our own annotations render exclusively
  and always-currently through the overlay; `pdf.js` bakes in whatever
  foreign annotations are present, same as it always did, just never ours
  a second time. Foreign annotations are still only *displayed*, not
  selectable/editable by us — that's still real step 6 work — but the
  display half is no longer blocked on it.
- **PDF annotation format**: use `pdf-lib` to write PDF's *native*
  annotation types — Ink (freehand paths), Highlight, Underline, StrikeOut,
  Text/Note — rather than flattening to a rasterized overlay. Native
  annotation objects stay individually selectable and editable by any
  PDF-annotation-aware tool, including our own view when reopened, and are
  viewable in any standards-compliant PDF reader with zero plugin
  dependency. Watch for three known gotchas, all hit and fixed during the
  first implementation pass: (1) `pdf-lib` doesn't auto-generate appearance
  streams (`/AP`) for Ink/Line/Square/Circle — built by hand as small
  content-stream operator strings (`m`/`l`/`re`/Bezier `c` for the ellipse
  approximation), one XObject Form per annotation; (2) screen-space stroke
  coordinates need correct transformation into PDF space (bottom-left
  origin, point units, page-rotation-aware) — solved by routing both
  directions through `pdf.js`'s own `PageViewport.convertToPdfPoint`/
  `convertToViewportPoint` (already rotation-aware, since it's the exact
  matrix used to render) rather than hand-deriving a flip/scale; (3) `PDFName.asString()`
  returns the name *with* its leading slash (`"/Ink"`, not `"Ink"`) — every
  subtype comparison against a bare string silently failed until switched
  to `.decodeText()`. Also watch for a `pdf.js`/`pdf-lib` interaction, not a
  `pdf-lib` issue by itself: `pdf.js`'s worker-based `getDocument()` takes
  ownership of (and detaches) the `ArrayBuffer` passed to it for off-thread
  parsing — reusing that same buffer for a second, `pdf-lib` parse handed
  it an already-emptied buffer and silently produced zero annotations on
  every read-back. Fixed by giving `pdf-lib` its own independent
  `vault.readBinary()` read rather than sharing the one read for `pdf.js`.
- **Markdown annotation format**: store structured stroke data (each stroke
  as a discrete, editable object, versioned with a schema-version field for
  future migrations) inside a single fenced block in the note, rendered
  into an interactive overlay by a Markdown post-processor. Plugin-only
  rendering is an accepted tradeoff — unlike PDF, Markdown ink is NOT
  required to be viewable outside the plugin, since usage is expected to be
  occasional and block-scoped (e.g. working a homework problem by hand next
  to its prompt), not document-wide digitization meant for other readers.
  Parse this block defensively (plain `JSON.parse`, never `eval`) since a
  synced/shared/malformed vault could contain adversarial input — never
  render user-authored note text via `innerHTML`; use `textContent`/safe
  DOM APIs to avoid a stored-XSS path through the annotation renderer.
- **Scanned/image-only PDFs have no text layer.** `pdf.js`'s text-selection
  layer only exists for PDFs with real embedded text — a scanned textbook
  chapter with no OCR has nothing to select, so highlight/underline/
  strikethrough (which depend on text selection) have nothing to attach to.
  Don't let this silently no-op: when no text layer is detected on a page,
  either hide/disable the text-selection tools for that page, or offer a
  freehand "box highlight" fallback (a semi-transparent drawn rectangle
  instead of a real text-anchored highlight) so the feature degrades
  visibly instead of just failing quietly. Freehand pen/ink already works
  regardless of text layer, so this only affects the selection-based tools.
- **Undo/redo scope**: default to session-only (cleared when the file is
  closed) rather than persisted indefinitely — once an annotation is
  committed to the file it's already durable and independently editable via
  select/lasso, so there's no need to also carry a cross-session undo log.
  Flag if this doesn't match expectations; it's a default, not a hard
  requirement.
  `main.js`, no runtime dependency downloads.
- **Manifest**: `isDesktopOnly: false`, semver version, `id` without the
  substring "obsidian".

## Suggested build order

Each numbered step should end with a clean build (`tsc`/esbuild with no
errors) and a manual smoke test on both desktop and a real mobile device
before moving to the next — don't stack steps 4-7 on top of an unverified
step 3.

1. **Skeleton**: minimal plugin that loads on both desktop and mobile
   (`isDesktopOnly: false`), confirm the mobile dev/test loop works
   (Android via `chrome://inspect`, iOS via Safari Web Inspector, or the
   desktop mobile emulator) before writing any annotation logic.
2. **PDF read + render**: open a PDF via `pdf.js` inside a custom view,
   confirm it renders correctly on both desktop and a real mobile device.
3. **Handwritten note creation + page management**: template generation
   (blank/lined/dot-grid, drawn with `pdf-lib`), the "Create handwritten
   note" command + file-explorer entry, and the toolbar "Add page" action
   (insert-after-current, matching template style read back from the PDF's
   `Keywords` field). A light, self-contained `pdf-lib` exercise — whole-page
   copy/insert, no coordinate transforms — that also validates the
   `vault.readBinary`/`modifyBinary` write loop before step 5's harder
   annotation-object work.
4. **Shared toolset + PDF ink drawing (in-memory only)**: build the shared
   tool module (colors, sizing, eraser, select/lasso, undo/redo) against
   pointer events, drawing on top of the rendered PDF, no persistence yet.
   Get palm rejection and the toolbar working here first on a real device,
   since this is the highest-value slice and the module gets reused
   everywhere after.
5. **PDF write path**: `pdf-lib` integration — coordinate transform, native
   annotation objects, debounced write-on-completion, appearance-stream
   spike. This is the highest-risk step technically; budget real time for
   it rather than treating it as a quick wire-up.
6. **PDF text annotations + select/edit existing**: wire the shared
   toolset's highlight/underline/strikethrough/note tools to `pdf.js`'s
   text-selection layer; confirm lasso-select and edit works on annotations
   read back from a reopened file, including foreign ones.
7. **Markdown ink block**: port the drawing/toolbar code to the Markdown
   view, structured-stroke-data block + post-processor rendering (see
   Architecture notes).
8. **Polish pass against Obsidian's plugin guidelines**: manifest cleanup,
   settings UI conventions (sentence case, no "Settings for X Plugin"
   heading), remove dev-only console logging, verify no network calls slip
   in via a dependency.

## Open decisions (need a call before/while building)

- Exact fenced-block syntax for embedded Markdown stroke data (needs to be
  something Obsidian's Markdown post-processor API can reliably intercept
  and re-render, and ideally something that doesn't look like garbage if
  viewed outside Obsidian or before the plugin loads).
- How aggressively to support editing foreign (non-plugin-authored) PDF
  annotations vs. just displaying them.
- Confirm the scanned-PDF fallback behavior (hide selection tools vs.
  freehand box-highlight) matches what you'd actually want when you hit a
  scanned textbook with no text layer.
- Confirm the shape-tools addition (line/rectangle/oval/arrow) actually
  matches what you want, since it wasn't explicitly requested before —
  added by inference from "match what Xodo does."
