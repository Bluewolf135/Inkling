import { FileView, ItemView, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { ToolState } from './annotate';
import { collectAnnotations } from './extract/extract';
import { extractionNotePath, mergeIntoNote, renderExtraction } from './extract/extractFormat';
import { compactInkBlocks } from './markdown/compactInkBlocks';
import { registerInkBlock } from './markdown/inkBlock';
import { registerNoteCreation } from './noteCreation';
import { setAnnotationWriterWorkerSourceProvider } from './pdf/annotationWriterClient';
import { CORE_PDF_VIEW_TYPE, PdfAnnotateView, VIEW_TYPE_PDF } from './pdfView';
import { defaultSettings, normalizeSettings, type InklingSettings } from './settings';
import { InklingSettingTab } from './settingsTab';

// The page Obsidian's own PDF view is currently showing. Its ephemeral
// state is no help here — verified against the running app, the core PDF
// view's getEphemeralState() returns `{}` no matter where it's scrolled, so
// simply passing that through carried nothing over and the editor always
// opened at page 1 (what looked like it working was Obsidian's own
// per-file position memory, not us). This reads the live viewer instead,
// which is undocumented internals, hence the fully defensive walk and the
// null result callers must handle.
function readCorePdfPage(view: unknown): number | null {
	const page = (
		view as {
			viewer?: { child?: { pdfViewer?: { pdfViewer?: { currentPageNumber?: unknown } } } };
		}
	)?.viewer?.child?.pdfViewer?.pdfViewer?.currentPageNumber;
	return typeof page === 'number' && Number.isFinite(page) && page >= 1 ? page : null;
}


export default class InklingPlugin extends Plugin {
	// Leaves we've already added the "Annotate with Inkling" action to —
	// active-leaf-change fires repeatedly for the same leaf, and addAction
	// has no de-dupe of its own, so without this the button would multiply.
	private readonly decoratedViews = new WeakSet<ItemView>();
	// The action buttons added to core PDF views, kept so onunload can take
	// them back off again.
	private readonly actions: HTMLElement[] = [];
	// The selected tool, its color and its width, held once for the whole
	// plugin rather than per drawing surface. A Markdown ink block's
	// controller is destroyed and rebuilt every time the block saves — which
	// is a second after every burst of handwriting — so tool state kept
	// inside one silently reverted to the defaults mid-page. Living here it
	// outlives those rebuilds, and it means the pen carries between blocks
	// and PDFs the way a real one does. See src/annotate/toolState.ts.
	private readonly toolState = new ToolState();
	// Read once on load and handed around by reference, never by
	// snapshot, so changing a setting takes effect without reopening a
	// file. Initialised to the defaults so nothing has to cope with it
	// being absent during the async load below.
	settings: InklingSettings = defaultSettings();

	async onload() {
		this.settings = normalizeSettings(await this.loadData());
		this.addSettingTab(new InklingSettingTab(this.app, this));
		// Applied here rather than inside ToolState, which has no idea
		// settings exist — it is shared with surfaces that have no
		// settings tab behind them.
		this.toolState.setToolbarCollapsed(this.settings.toolbarStartsCollapsed);

		this.configurePdfWorker();
		this.configureAnnotationWriterWorker();

		this.registerView(VIEW_TYPE_PDF, (leaf) => new PdfAnnotateView(leaf, this.toolState, () => this.settings));
		registerNoteCreation(this, () => ({ template: this.settings.defaultTemplate, pageSize: this.settings.pageSize }));
		registerInkBlock(this, this.toolState);

		// Obsidian's own core PDF view stays the default for opening a .pdf —
		// full native chrome (page number, zoom, outline) and no pdf-lib
		// parsing cost. Inkling used to unclaim the "pdf" extension outright
		// and replace it everywhere, which is what lost that chrome and made
		// every PDF open pay pdf-lib's parse cost up front, whether or not
		// the user ever intended to annotate. Now editing is opt-in: a
		// "pencil" action added to core PDF leaves below swaps just that leaf
		// into VIEW_TYPE_PDF, and Inkling's own view offers a matching action
		// back to the core view (see PdfAnnotateView.exitEditMode).
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.decorateIfCorePdfLeaf(leaf)));
		this.app.workspace.onLayoutReady(() => {
			for (const leaf of this.app.workspace.getLeavesOfType(CORE_PDF_VIEW_TYPE)) this.decorateIfCorePdfLeaf(leaf);
		});

		this.addCommand({
			// Not "…with Inkling": Obsidian already prefixes a command with
			// the plugin's name in the palette, so saying it again reads as
			// "Inkling: Annotate this PDF with Inkling".
			id: 'annotate-pdf',
			name: 'Annotate this PDF',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				if (!view || view.getViewType() !== CORE_PDF_VIEW_TYPE) return false;
				if (!checking) void this.switchToInkling(view.leaf);
				return true;
			},
		});

		// Undo and redo as palette commands as well as view-scoped keys.
		// Registered with no default hotkey, per Obsidian guidelines: the bare
		// Mod+Z inside the annotate view already covers the ergonomics, and
		// these exist so someone who wants a global binding can make one
		// without us claiming a shortcut out from under another plugin.
		this.addCommand({
			id: 'undo-annotation',
			name: 'Undo annotation',
			checkCallback: (checking) => this.withAnnotateView(checking, (view) => view.undoAnnotation()),
		});

		this.addCommand({
			id: 'redo-annotation',
			name: 'Redo annotation',
			checkCallback: (checking) => this.withAnnotateView(checking, (view) => view.redoAnnotation()),
		});

		this.addCommand({
			id: 'compact-ink-blocks',
			name: 'Compact ink blocks in this note',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) void this.compactInkBlocksIn(file);
				return true;
			},
		});

		this.addCommand({
			id: 'extract-annotations',
			name: 'Extract annotations to a note',
			checkCallback: (checking) => {
				const file = this.activePdfFile();
				if (!file) return false;
				if (!checking) void this.extractAnnotations(file);
				return true;
			},
		});
	}

	// The PDF the user is looking at, whichever view is showing it —
	// Inkling’s own or Obsidian’s. Extraction is read-only, so it has no
	// reason to care which.
	private activePdfFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(FileView);
		const file = view?.file ?? null;
		return file && file.extension.toLowerCase() === 'pdf' ? file : null;
	}

	private async extractAnnotations(file: TFile): Promise<void> {
		const notice = new Notice(`Inkling: reading ${file.basename}…`, 0);
		try {
			// Anything still sitting in a debounce belongs in the file before it
			// is read, or the last minute of highlighting is simply missing
			// from the note — and the user has no way to tell that from "the
			// extraction dropped it".
			const view = this.app.workspace.getActiveViewOfType(PdfAnnotateView);
			if (view?.file?.path === file.path) await view.flushPendingWrites();

			const annotations = await collectAnnotations(await this.app.vault.readBinary(file), {
				onProgress: (pageNumber, pageCount) => {
					notice.setMessage(`Inkling: reading ${file.basename} — page ${pageNumber} of ${pageCount}`);
				},
			});

			const path = extractionNotePath(this.settings.extractionNotePattern, file.path);
			const generated = renderExtraction(file.path, annotations, this.settings.colorLabels);

			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				// process, not modify: it reads and writes under one lock, so a
				// note being edited in another pane cannot be clobbered by a
				// stale copy read a moment ago.
				await this.app.vault.process(existing, (contents) => mergeIntoNote(contents, generated));
			} else {
				await this.app.vault.create(path, mergeIntoNote('', generated));
			}

			notice.hide();
			new Notice(
				annotations.length === 0
					? `Inkling: no annotations found in ${file.basename}.`
					: `Inkling: extracted ${annotations.length} annotations from ${file.basename}.`,
			);

			const note = this.app.vault.getAbstractFileByPath(path);
			if (note instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(note);
		} catch (error) {
			notice.hide();
			console.error('Inkling: failed to extract annotations.', error);
			new Notice('Inkling: could not extract annotations from this PDF.');
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// Runs `act` on the active annotate view, or reports that there is none.
	// The checking pass must not act, which is the whole contract of
	// checkCallback and easy to get subtly wrong when it is inlined.
	// Thins the strokes in every ink block in a note, for blocks written
	// before strokes were thinned as they were drawn (see
	// annotate/simplify.ts).
	//
	// Through the vault rather than the open editor, unlike the ink block
	// save path. That path makes a small, targeted replaceRange inside one
	// fence; this rewrites the whole document, and setValue on a view in
	// preview mode does not survive — the view re-syncs from the file and
	// the change is simply gone, which is exactly what happened the first
	// time this was written that way. vault.process is atomic and does not
	// care which mode the note is being viewed in.
	//
	// The cost is that this is not a single editor undo step. It is the one
	// operation in the plugin that deliberately discards detail, so it says
	// so plainly, and Obsidian's own file recovery is the way back.
	private async compactInkBlocksIn(file: TFile): Promise<void> {
		const source = await this.app.vault.read(file);
		const result = compactInkBlocks(source);

		const unreadable = result.skipped > 0 ? ` ${result.skipped} could not be read and were left alone.` : '';

		if (result.blocks === 0) {
			new Notice(`Inkling: nothing to compact in this note.${unreadable}`);
			return;
		}

		try {
			let wrote = false;
			await this.app.vault.process(file, (current) => {
				// Refuses rather than overwrites if the note moved under us
				// between reading it and writing it back. Recomputing here
				// instead would mean silently compacting something the user
				// has not seen the numbers for.
				if (current !== source) return current;
				wrote = true;
				return result.content;
			});

			if (!wrote) {
				new Notice('Inkling: the note changed while compacting, so nothing was written. Try again.');
				return;
			}
		} catch (error) {
			console.error('Inkling: failed to compact ink blocks.', error);
			new Notice('Inkling: could not compact this note. Nothing was changed.');
			return;
		}

		const dropped = Math.round(((result.pointsBefore - result.pointsAfter) / result.pointsBefore) * 100);
		const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		new Notice(
			`Inkling: compacted ${result.blocks} ink block${result.blocks === 1 ? '' : 's'} — ` +
				`${dropped}% fewer points, ${mb(source.length)} to ${mb(result.content.length)}.${unreadable}`,
			10_000,
		);
	}

	private withAnnotateView(checking: boolean, act: (view: PdfAnnotateView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(PdfAnnotateView);
		if (!view) return false;
		if (!checking) act(view);
		return true;
	}

	onunload(): void {
		// The "annotate" buttons live on Obsidian's *own* PDF views, not on
		// anything this plugin owns and Obsidian would tear down for it — so
		// without this they'd outlive the plugin, still sitting in the
		// toolbar of every open PDF with nothing behind them.
		for (const action of this.actions) action.remove();
		this.actions.length = 0;
	}

	private decorateIfCorePdfLeaf(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view;
		if (!leaf || !(view instanceof ItemView) || view.getViewType() !== CORE_PDF_VIEW_TYPE) return;
		if (this.decoratedViews.has(view)) return;
		this.decoratedViews.add(view);
		// Buttons belonging to PDF views that have since been closed went out
		// of the document with them, but stayed in this array — which only
		// ever grew, for the whole session, one entry per PDF ever opened.
		// Dropping them here keeps it to what actually still needs removing
		// at unload.
		for (let i = this.actions.length - 1; i >= 0; i--) {
			const action = this.actions[i];
			if (action && !action.isConnected) this.actions.splice(i, 1);
		}
		this.actions.push(view.addAction('pencil', 'Annotate with Inkling', () => void this.switchToInkling(leaf)));
	}

	private async switchToInkling(leaf: WorkspaceLeaf): Promise<void> {
		const view = leaf.view;
		const file = view instanceof FileView ? view.file : null;
		if (!file) return;
		// Carries over whatever page the native view was showing, rather than
		// always reopening at page 1. Read *before* the state swap below,
		// while `leaf`'s view is still the native one whose position this is.
		const page = readCorePdfPage(view);
		await leaf.setViewState({ type: VIEW_TYPE_PDF, state: { file: file.path } }, page === null ? undefined : { page });
	}

	private configurePdfWorker() {
		const pluginDir = this.manifest.dir;
		if (!pluginDir) {
			throw new Error('Inkling: could not resolve plugin directory for pdf.worker.js');
		}
		const workerPath = normalizePath(`${pluginDir}/pdf.worker.js`);
		GlobalWorkerOptions.workerSrc = this.app.vault.adapter.getResourcePath(workerPath);
	}

	// See src/pdf/annotationWriter.worker.ts — runs pdf-lib's parse/mutate/
	// save off the main thread so saving a heavily-annotated PDF can't stall
	// pointer input while the user is actively writing.
	//
	// Hands over a reader for the bundle's *source*, not a resource path:
	// the client builds the worker from a same-origin blob, because a Worker
	// constructed from a plugin resource URL is cross-origin to the main
	// window in desktop Obsidian and fails there (see its comment). Lazy, so
	// only a session that actually annotates pays for reading it.
	private configureAnnotationWriterWorker() {
		const pluginDir = this.manifest.dir;
		if (!pluginDir) {
			throw new Error('Inkling: could not resolve plugin directory for annotation-writer.worker.js');
		}
		const workerPath = normalizePath(`${pluginDir}/annotation-writer.worker.js`);
		setAnnotationWriterWorkerSourceProvider(() => this.app.vault.adapter.read(workerPath));
	}
}
