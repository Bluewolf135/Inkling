import { FileView, ItemView, Notice, Plugin, WorkspaceLeaf, normalizePath } from 'obsidian';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { registerNoteCreation } from './noteCreation';
import { setAnnotationWriterWorkerSourceProvider } from './pdf/annotationWriterClient';
import { CORE_PDF_VIEW_TYPE, PdfAnnotateView, VIEW_TYPE_PDF } from './pdfView';

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

	async onload() {
		this.configurePdfWorker();
		this.configureAnnotationWriterWorker();

		this.registerView(VIEW_TYPE_PDF, (leaf) => new PdfAnnotateView(leaf));
		registerNoteCreation(this);

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
			id: 'annotate-pdf',
			name: 'Annotate this PDF with Inkling',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				if (!view || view.getViewType() !== CORE_PDF_VIEW_TYPE) return false;
				if (!checking) void this.switchToInkling(view.leaf);
				return true;
			},
		});

		new Notice('Inkling loaded');
	}

	private decorateIfCorePdfLeaf(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view;
		if (!leaf || !(view instanceof ItemView) || view.getViewType() !== CORE_PDF_VIEW_TYPE) return;
		if (this.decoratedViews.has(view)) return;
		this.decoratedViews.add(view);
		view.addAction('pencil', 'Annotate with Inkling', () => void this.switchToInkling(leaf));
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
