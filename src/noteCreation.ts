import { App, Modal, Plugin, Setting, TFile, TFolder, normalizePath } from 'obsidian';
import { toArrayBuffer } from './binary';
import { VIEW_TYPE_PDF } from './pdfView';
import { createHandwrittenNoteBytes, TEMPLATE_STYLE_LABELS, TEMPLATE_STYLES, TemplateStyle } from './templates';

const DEFAULT_NAME = 'Untitled note';
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

class CreateHandwrittenNoteModal extends Modal {
	private name = DEFAULT_NAME;
	private style: TemplateStyle = 'blank';

	constructor(app: App, private readonly onSubmit: (name: string, style: TemplateStyle) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Create handwritten note');
		// Obsidian styles its own modals off these classes; without them this
		// one sat with settings-sized rows in an unpadded box, which is why
		// it read as noticeably plainer than the app's own dialogs.
		this.modalEl.addClass('mod-confirmation');
		this.contentEl.addClass('inkling-create-note-modal');

		let textInputEl: HTMLInputElement | undefined;

		new Setting(this.contentEl)
			.setName('Name')
			.setDesc('Saved as a PDF beside the note you have open.')
			.addText((text) => {
				textInputEl = text.inputEl;
				text.setPlaceholder(DEFAULT_NAME);
				text.setValue(this.name).onChange((value) => (this.name = value));
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') this.submit();
				});
			});

		new Setting(this.contentEl)
			.setName('Template')
			.setDesc('The ruling printed on every page, including pages added later.')
			.addDropdown((dropdown) => {
				for (const style of TEMPLATE_STYLES) dropdown.addOption(style, TEMPLATE_STYLE_LABELS[style]);
				dropdown.setValue(this.style).onChange((value) => (this.style = value as TemplateStyle));
			});

		// The button row, not another labelled setting — `mod-button-row`
		// right-aligns it and drops the divider a plain Setting draws, so
		// Create doesn't look like the value half of a nameless row.
		new Setting(this.contentEl)
			.setClass('mod-button-row')
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('Create').setCta().onClick(() => this.submit()));

		textInputEl?.focus();
		textInputEl?.select();
	}

	private submit(): void {
		const name = this.name.trim();
		if (!name) return;
		this.close();
		this.onSubmit(name, this.style);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function sanitizeFilename(name: string): string {
	return name.replace(INVALID_FILENAME_CHARS, '-').trim() || DEFAULT_NAME;
}

function getUniqueNotePath(app: App, folder: TFolder, baseName: string): string {
	const safeName = sanitizeFilename(baseName);
	const folderPath = folder.isRoot() ? '' : `${folder.path}/`;

	let candidate = normalizePath(`${folderPath}${safeName}.pdf`);
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = normalizePath(`${folderPath}${safeName} ${++suffix}.pdf`);
	}
	return candidate;
}

async function createHandwrittenNote(
	app: App,
	folder: TFolder,
	baseName: string,
	style: TemplateStyle,
): Promise<TFile> {
	const path = getUniqueNotePath(app, folder, baseName);
	const bytes = await createHandwrittenNoteBytes(style);
	return app.vault.createBinary(path, toArrayBuffer(bytes));
}

function getTargetFolder(app: App): TFolder {
	return app.workspace.getActiveFile()?.parent ?? app.vault.getRoot();
}

function openCreateNoteModal(app: App, folder: TFolder): void {
	new CreateHandwrittenNoteModal(app, (name, style) => {
		void createHandwrittenNote(app, folder, name, style)
			// A brand-new handwritten note is created specifically to be
			// written on right away — opened straight into Inkling's edit
			// view rather than `openFile`'s default extension resolution,
			// which (now that Inkling no longer claims .pdf outright, see
			// main.ts) would otherwise land on Obsidian's read-only core
			// PDF view first.
			.then((file) => app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE_PDF, state: { file: file.path } }))
			.catch((error) => console.error('Inkling: failed to create handwritten note.', error));
	}).open();
}

export function registerNoteCreation(plugin: Plugin): void {
	plugin.addCommand({
		id: 'create-handwritten-note',
		name: 'Create handwritten note',
		callback: () => openCreateNoteModal(plugin.app, getTargetFolder(plugin.app)),
	});

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFolder)) return;
			menu.addItem((item) =>
				item
					.setTitle('New handwritten note')
					.setIcon('pen-line')
					.onClick(() => openCreateNoteModal(plugin.app, file)),
			);
		}),
	);
}
