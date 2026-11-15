import { App, FileView, Menu, Modal, Notice, TFile } from 'obsidian';
import { AnnotationMode, getDocument, type PDFPageProxy } from 'pdfjs-dist';
import { findScrollParent } from './annotate/pointer';
import { toArrayBuffer } from './binary';
import { applyPagePlan, extractPages, movedOrder, removePage, type PlannedPage } from './pdf/pages';
import { ManagePagesModal, type PageExportFormat, type PageSource } from './managePagesModal';
import { followPageLinks, pageMapOfDeletion, pageMapOfPlan } from './pageLinks';
import { writeBinarySafely } from './vaultWrite';
import { annotateViewsOf, refreshCoreReaders } from './coreViews';
import { backUp, type BackupReason } from './backups';

// A menu on the page thumbnails of Obsidian's own PDF reader — a long press
// on a tablet, a right-click on a desktop — that can delete a page.
//
// Obsidian puts a menu there already, with one item, "Copy link to page",
// and no way for a plugin to add to it. So this one is shown instead, with
// that item first, exactly as Obsidian words and builds it, and the delete
// after it. It listens on the whole view in the capture phase, which is
// before Obsidian's own listener on the sidebar, and only for a thumbnail:
// a right-click anywhere else in the reader is left to Obsidian.
//
// The thumbnail's markup is pdf.js's (`.thumbnail` with `data-page-number`),
// which Obsidian keeps. Read defensively: a reader that changed it simply
// gets Obsidian's own menu back.

export function attachThumbnailMenu(app: App, view: FileView, register: (el: HTMLElement, handler: (event: MouseEvent) => void) => void): void {
	register(view.containerEl, (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const thumbnail = target?.closest<HTMLElement>('.thumbnail');
		const pageNumber = Number(thumbnail?.dataset.pageNumber);
		const file = view.file;
		if (!thumbnail || !Number.isInteger(pageNumber) || pageNumber < 1 || !file || file.extension !== 'pdf') return;
		event.preventDefault();
		event.stopPropagation();

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Copy link to page')
				.setIcon('lucide-copy')
				.onClick(() => {
					const link = app.fileManager.generateMarkdownLink(file, '', `#page=${pageNumber}`, `${file.basename}, page ${pageNumber}`);
					void view.containerEl.win.navigator.clipboard.writeText(link);
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Manage pages…')
				.setIcon('layout-list')
				.onClick(() => openManagePages(app, file, pageNumber)),
		);
		menu.addItem((item) =>
			item
				.setTitle('Delete page')
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() => new DeletePageModal(app, file, pageNumber).open()),
		);
		menu.showAtMouseEvent(event);
	});
}

// Asked first, because it cannot be undone from here: the page is gone from
// the file, not hidden.
class DeletePageModal extends Modal {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly pageNumber: number,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Delete page ${this.pageNumber}?`);
		this.contentEl.createEl('p', {
			text: `Page ${this.pageNumber} of “${this.file.basename}” is removed from the PDF for good, with everything drawn or written on it.`,
		});
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const remove = buttons.createEl('button', { cls: 'mod-warning', text: 'Delete page' });
		remove.type = 'button';
		remove.addEventListener('click', () => {
			this.close();
			void deletePage(this.app, this.file, this.pageNumber);
		});
		remove.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Removes the page and writes the file. Obsidian's reader reloads a PDF that
// changes, so whatever has it open shows the result.
export async function deletePage(app: App, file: TFile, pageNumber: number): Promise<boolean> {
	const done = await rewriteFile(app, file, 'delete-page', `could not delete page ${pageNumber}.`, async (before) => {
		const result = await removePage(before, pageNumber);
		if (result.kind === 'refused') {
			new Notice(`InklingExpanded: page ${pageNumber} was not deleted — ${result.reason}.`);
			return null;
		}
		return {
			bytes: toArrayBuffer(result.bytes),
			notice: `InklingExpanded: deleted page ${pageNumber}. ${result.pageCount} ${result.pageCount === 1 ? 'page' : 'pages'} left.`,
		};
	});
	if (done) await followPageLinks(app, file, pageMapOfDeletion(pageNumber));
	return done;
}

// Rewrites the file as `change` says, with a backup of it as it was.
//
// The same PDF open to annotate, here, is the one thing that can be writing
// to it meanwhile. Flushing that view first was not enough: a stroke drawn
// between the flush and the write here was saved by the view in between,
// then written over, and the view took its absence for a deletion made on
// another device. So with a view open the change is made by the view, as
// its own page changes are — drawing paused and its save slot held for the
// whole of it (see PdfAnnotateView.rebuild). Only with none is the file
// written from here.
async function rewriteFile(
	app: App,
	file: TFile,
	reason: BackupReason,
	failure: string,
	change: (before: ArrayBuffer) => Promise<{ bytes: ArrayBuffer; notice?: string } | null>,
): Promise<boolean> {
	const [view] = annotateViewsOf(app, file);
	if (view) {
		const done = await view.rebuildFromOutside(reason, failure, change);
		if (done === null) new Notice(`InklingExpanded: “${file.basename}” is busy being changed in its annotate view — try again in a moment.`);
		return done === true;
	}
	try {
		const before = await app.vault.readBinary(file);
		const result = await change(before);
		if (!result) return false;
		await backUp(app, file, before, reason);
		await writeBinarySafely(app.vault, file, result.bytes);
		await refreshCoreReaders(app, file);
		if (result.notice) new Notice(result.notice);
		return true;
	} catch (error) {
		console.error(`InklingExpanded: ${failure}`, error);
		new Notice(`InklingExpanded: ${failure}`);
		return false;
	}
}

// ---- Moving pages ----
//
// The list of the document's pages, from the thumbnails' menu or the command
// palette, which is how it is done with a finger or a pen: in the sidebar
// those scroll. A mouse can also drag a thumbnail where it is, below.

const THUMBNAIL_WIDTH = 96;

// Small pictures of a PDF's pages, from the file as it is on disk.
async function pageSourceOf(app: App, file: TFile): Promise<PageSource> {
	const pdf = await getDocument({ data: await app.vault.readBinary(file), isEvalSupported: false }).promise;
	return {
		numPages: pdf.numPages,
		draw: async (pageNumber, canvas) => {
			const page = await pdf.getPage(pageNumber);
			const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / page.getViewport({ scale: 1 }).width });
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
		},
		close: () => void pdf.destroy(),
	};
}

export function openManagePages(app: App, file: TFile, focusPage = 1): void {
	new ManagePagesModal(
		app,
		file,
		focusPage,
		(target) => pageSourceOf(app, target),
		(plan) => void applyPlanToFile(app, file, plan),
		(plan, format) => void exportPages(app, file, plan, format),
	).open();
}

export function applyPageOrder(app: App, file: TFile, order: readonly number[]): Promise<boolean> {
	return applyPlanToFile(app, file, order.map((page) => ({ page })));
}

// Writes the pages as `plan` has them (see rewriteFile). On another device
// the sync brings this over as a change of theirs (see takeInRemote in
// pdfView.ts): pages are matched by what they are, so ink not yet saved
// there stays on its own page.
export async function applyPlanToFile(app: App, file: TFile, plan: readonly PlannedPage[]): Promise<boolean> {
	const done = await rewriteFile(app, file, 'move-page', 'could not change the pages.', async (before) => {
		const result = await applyPagePlan(before, plan);
		if (result.kind === 'unchanged') return null;
		if (result.kind === 'refused') {
			new Notice(`InklingExpanded: the pages were not changed — ${result.reason}.`);
			return null;
		}
		return { bytes: toArrayBuffer(result.bytes) };
	});
	if (done) await followPageLinks(app, file, pageMapOfPlan(plan));
	return done;
}

// ---- Exporting pages ----

// Twice the size a PDF states, which is 144 dpi: sharp on a screen, and no
// larger than a phone can draw. A page the size of a poster is held to
// EXPORT_MAX_SIDE, past which a canvas on a tablet silently comes out blank.
const EXPORT_SCALE = 2;
const EXPORT_MAX_SIDE = 4096;

// Beside the PDF, under a name not yet taken.
function freePath(app: App, file: TFile, name: string, extension: string): string {
	const folder = file.path.slice(0, file.path.length - file.name.length);
	let path = `${folder}${name}.${extension}`;
	for (let attempt = 2; app.vault.getAbstractFileByPath(path); attempt++) path = `${folder}${name} ${attempt}.${extension}`;
	return path;
}

export function exportedPagesName(basename: string, pages: readonly number[]): string {
	const [first] = pages;
	const last = pages[pages.length - 1];
	if (first === undefined || last === undefined) return basename;
	if (pages.length === 1) return `${basename} - page ${first}`;
	const running = pages.every((page, index) => page === first + index);
	return running ? `${basename} - pages ${first}-${last}` : `${basename} - ${pages.length} pages`;
}

async function pagePicture(page: PDFPageProxy, turn: number): Promise<ArrayBuffer> {
	const rotation = (((page.rotate + turn) % 360) + 360) % 360;
	const natural = page.getViewport({ scale: 1, rotation });
	const scale = Math.min(EXPORT_SCALE, EXPORT_MAX_SIDE / Math.max(natural.width, natural.height));
	const viewport = page.getViewport({ scale, rotation });
	const canvas = createEl('canvas');
	canvas.width = Math.ceil(viewport.width);
	canvas.height = Math.ceil(viewport.height);
	try {
		await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) throw new Error('the page could not be turned into a picture');
		return await blob.arrayBuffer();
	} finally {
		// A canvas holds its memory until it is sized down, and a long export
		// on a tablet runs out of it otherwise.
		canvas.width = 0;
		canvas.height = 0;
	}
}

// The pages as they are shown in the dialog, turned as it has them, into new
// files next to the PDF. The PDF itself is not touched.
export async function exportPages(app: App, file: TFile, plan: readonly PlannedPage[], format: PageExportFormat): Promise<boolean> {
	try {
		for (const view of annotateViewsOf(app, file)) await view.flushPendingWrites();
		const bytes = await app.vault.readBinary(file);
		if (format === 'pdf') {
			const result = await extractPages(bytes, plan);
			if (result.kind === 'refused') {
				new Notice(`InklingExpanded: the pages were not exported — ${result.reason}.`);
				return false;
			}
			const path = freePath(app, file, exportedPagesName(file.basename, plan.map(({ page }) => page)), 'pdf');
			await app.vault.createBinary(path, toArrayBuffer(result.bytes));
			new Notice(`InklingExpanded: saved ${path}.`);
			return true;
		}
		const pdf = await getDocument({ data: bytes, isEvalSupported: false }).promise;
		try {
			let last = '';
			for (const { page: number, turn = 0 } of plan) {
				const picture = await pagePicture(await pdf.getPage(number), turn);
				last = freePath(app, file, exportedPagesName(file.basename, [number]), 'png');
				await app.vault.createBinary(last, picture);
			}
			new Notice(plan.length === 1 ? `InklingExpanded: saved ${last}.` : `InklingExpanded: saved ${plan.length} pictures next to the PDF.`);
			return true;
		} finally {
			void pdf.destroy();
		}
	} catch (error) {
		console.error('InklingExpanded: failed to export pages.', error);
		new Notice('InklingExpanded: could not export the pages.');
		return false;
	}
}

// How far a mouse must move before a press on a thumbnail is a drag.
const DRAG_THRESHOLD = 6;
const DRAG_AUTOSCROLL_EDGE = 40;
const DRAG_AUTOSCROLL_SPEED = 10;

// Dragging a thumbnail with a mouse, in the reader's own sidebar. A line
// between the thumbnails shows where it will land.
export function attachThumbnailDrag(app: App, view: FileView, register: (type: 'pointerdown' | 'dragstart', handler: (event: Event) => void) => void): void {
	// A thumbnail is an image in a link, which the browser would drag itself.
	register('dragstart', (event) => {
		if (event.target instanceof Element && event.target.closest('.thumbnail')) event.preventDefault();
	});
	register('pointerdown', (raw) => {
		const event = raw as PointerEvent;
		if (event.pointerType !== 'mouse' || event.button !== 0 || !(event.target instanceof Element)) return;
		const thumbnail = event.target.closest<HTMLElement>('.thumbnail');
		const pageNumber = Number(thumbnail?.dataset.pageNumber);
		const file = view.file;
		if (!thumbnail || !Number.isInteger(pageNumber) || pageNumber < 1 || !file || file.extension !== 'pdf') return;
		trackThumbnailDrag(app, view, file, thumbnail, pageNumber, event);
	});
}

function trackThumbnailDrag(app: App, view: FileView, file: TFile, thumbnail: HTMLElement, pageNumber: number, start: PointerEvent): void {
	const doc = view.containerEl.ownerDocument;
	const win = doc.defaultView ?? window;
	const thumbnails = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.thumbnail'));
	const from = pageNumber - 1;
	const scroller = findScrollParent(thumbnail);
	let line: HTMLElement | null = null;
	let frame: number | null = null;
	let lastY = start.clientY;
	let gap = from;

	// The gap before the first thumbnail whose middle is below the pointer.
	const gapAt = (y: number): number => {
		let low = 0;
		let high = thumbnails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			const rect = (thumbnails[middle] as HTMLElement).getBoundingClientRect();
			if (y < rect.top + rect.height / 2) high = middle;
			else low = middle + 1;
		}
		return low;
	};

	// Once a frame while the drag lasts, so that a pointer held still at the
	// edge of the sidebar goes on scrolling it.
	const tick = () => {
		if (scroller) {
			const rect = scroller.getBoundingClientRect();
			if (lastY < rect.top + DRAG_AUTOSCROLL_EDGE) scroller.scrollTop -= DRAG_AUTOSCROLL_SPEED;
			else if (lastY > rect.bottom - DRAG_AUTOSCROLL_EDGE) scroller.scrollTop += DRAG_AUTOSCROLL_SPEED;
		}
		gap = gapAt(lastY);
		const before = thumbnails[gap];
		const edge = before ?? thumbnails[thumbnails.length - 1];
		if (edge) {
			const rect = edge.getBoundingClientRect();
			line?.setCssProps({
				'--inkling-drop-left': `${rect.left}px`,
				'--inkling-drop-top': `${before ? rect.top : rect.bottom}px`,
				'--inkling-drop-width': `${rect.width}px`,
			});
		}
		frame = win.requestAnimationFrame(tick);
	};

	const onMove = (event: PointerEvent) => {
		if (event.pointerId !== start.pointerId) return;
		lastY = event.clientY;
		if (!line && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > DRAG_THRESHOLD) {
			line = doc.body.createDiv({ cls: 'inkling-page-drop-line' });
			thumbnail.addClass('inkling-page-moving');
			tick();
		}
		if (line) event.preventDefault();
	};
	const finish = (commit: boolean) => {
		doc.removeEventListener('pointermove', onMove, true);
		doc.removeEventListener('pointerup', onUp, true);
		doc.removeEventListener('pointercancel', onCancel, true);
		if (frame !== null) win.cancelAnimationFrame(frame);
		if (!line) return;
		line.remove();
		thumbnail.removeClass('inkling-page-moving');
		// The press and release were a drag: not also a click that jumps to
		// the page.
		const swallow = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		doc.addEventListener('click', swallow, { capture: true, once: true });
		win.setTimeout(() => doc.removeEventListener('click', swallow, true), 0);
		// A gap past the page's own place is one fewer once it has left it.
		gap = gapAt(lastY);
		const to = gap > from ? gap - 1 : gap;
		if (commit && to !== from) void applyPageOrder(app, file, movedOrder(thumbnails.length, from, to));
	};
	const onUp = (event: PointerEvent) => {
		if (event.pointerId === start.pointerId) finish(true);
	};
	const onCancel = (event: PointerEvent) => {
		if (event.pointerId === start.pointerId) finish(false);
	};
	doc.addEventListener('pointermove', onMove, true);
	doc.addEventListener('pointerup', onUp, true);
	doc.addEventListener('pointercancel', onCancel, true);
}
