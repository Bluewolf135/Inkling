# Inkling

Handwritten and text-based annotation for PDFs and Markdown notes in
[Obsidian](https://obsidian.md), built mobile-first for stylus input.

Inkling is for marking up textbooks and technical documents with a pen on a
tablet, and for handwriting inside notes where typing gets in the way — a
worked equation next to its prompt, a quick diagram, a margin note.

## Features

**PDF annotation.** Pen, highlighter, eraser, and line/rectangle/oval/arrow
shapes, plus lasso selection and undo/redo. Annotations are written into the
PDF as **native annotation objects**, so they show up in any other PDF
reader — not baked into a flattened image, and not stored in a sidecar file
only this plugin can read. Annotations made in other PDF software stay
visible and intact.

**Handwritten notes.** Create a blank, lined, or dot-grid note backed by a
real PDF, and add pages to it as you fill them up.

**Ink blocks in Markdown.** Handwrite directly inside a note. Strokes are
stored as structured data in a fenced ` ```inkling ` block, so they stay
individually editable rather than being frozen into an image.

**Built for a stylus.** Palm rejection (touch pans and scrolls, pen draws),
pinch-to-zoom with pan for precise work, flick scrolling with momentum, and
a highlighter that snaps to lines of real PDF text so a freehand drag comes
out straight.

## Usage

### PDFs

Open a PDF as usual — Obsidian's own PDF viewer stays the default, so
nothing gets slower just because this plugin is installed. To start
annotating, click the **pencil** button in the PDF's toolbar, or run
**Annotate this PDF** from the command palette. The **book** button returns
you to the normal reader, keeping your place in both directions.

### Handwritten notes

Run **Create handwritten note** from the command palette, or use the
"New handwritten note" entry in a folder's context menu. Pick blank, lined,
or dot-grid. **Add page** in the toolbar inserts a page after the one you're
on, matching the note's template.

### Ink blocks

Run **Insert ink annotation block** from the command palette to drop a
drawing surface at the cursor. Draw in it with a pen; **Tools** opens the
toolbar for that block, and the strip along its bottom edge resizes it.

## Installing

Inkling is not yet in the community plugin catalogue. To install it
manually, copy `main.js`, `manifest.json`, `styles.css`,
`annotation-writer.worker.js`, and `pdf.worker.js` into
`<vault>/.obsidian/plugins/inkling/`, then enable it in
**Settings → Community plugins**.

Requires Obsidian 1.2.0 or newer. Works on desktop and mobile.

## Building from source

```sh
npm install
npm run dev    # watch build
npm run build  # type-check and produce a production build
```

The build produces `main.js` plus two bundled workers (`pdf.worker.js` for
rendering and `annotation-writer.worker.js` for writing annotations), which
are loaded from the plugin folder — nothing is fetched from a CDN at
runtime, and the plugin makes no network requests at all.

## License

MIT — see [LICENSE](LICENSE).
