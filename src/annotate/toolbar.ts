import { setIcon, setTooltip } from 'obsidian';
import { AnnotationController } from './controller';
import { MAX_WIDTH, MIN_WIDTH, PRESET_COLORS, ToolType } from './types';

// Lucide icon names (Obsidian ships the set, and setIcon resolves them), so
// the strip reads as part of the app instead of the emoji/box-drawing mix it
// used to be — those rendered at a different weight and baseline from every
// other control in Obsidian, and at wildly different sizes across platforms
// (an emoji pencil is a full-color glyph on Windows and a thin monochrome
// one on Linux). `fallback` is the old glyph, used only if setIcon draws
// nothing: an icon renamed out from under an older Obsidian (the manifest
// still admits releases back to 1.4.4) should leave a button that's merely
// plain, never blank.
interface ButtonSpec {
	icon: string;
	fallback: string;
	title: string;
}

const TOOL_BUTTONS: ReadonlyArray<ButtonSpec & { tool: ToolType }> = [
	{ tool: 'select', icon: 'lasso', fallback: '⇖', title: 'Select / lasso' },
	{ tool: 'pen', icon: 'pencil', fallback: '✏️', title: 'Pen' },
	{ tool: 'highlighter', icon: 'highlighter', fallback: '🖊️', title: 'Highlighter' },
	{ tool: 'eraser', icon: 'eraser', fallback: '⌫', title: 'Eraser' },
	{ tool: 'line', icon: 'minus', fallback: '╱', title: 'Line' },
	{ tool: 'rectangle', icon: 'square', fallback: '▭', title: 'Rectangle' },
	{ tool: 'oval', icon: 'circle', fallback: '◯', title: 'Oval' },
	{ tool: 'arrow', icon: 'arrow-up-right', fallback: '↗', title: 'Arrow' },
];

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	// Obsidian's own createEl rather than document.createElement, per its
	// plugin guidelines. Detached on purpose — callers append these
	// themselves, so this can't build straight into a parent.
	return createEl(tag, { cls: className, text });
}

// An icon button with a real tooltip and an accessible name. The tooltip is
// Obsidian's own (setTooltip) rather than the browser's `title=`, so it
// matches the styling and timing of every other control in the app.
//
// `clickable-icon` is Obsidian's own class for exactly this kind of button
// (its view-header actions and ribbon are built from it), and carrying it
// here is what makes the strip look native under any theme rather than only
// the default one: measured in the running app, a bare <button> in this
// vault's theme came out with a raised grey fill and a four-layer drop
// shadow, so thirteen of them in a row read as a cluttered bank of chunky
// keys instead of a tool strip. Themes style `clickable-icon` flat and
// muted, and adjust it for their own metrics — much better than fighting
// each one with overrides here.
function iconButton(className: string, spec: ButtonSpec, onClick: () => void): HTMLButtonElement {
	const button = el('button', `clickable-icon ${className}`);
	button.type = 'button';
	setIcon(button, spec.icon);
	if (button.childElementCount === 0) button.setText(spec.fallback);
	setTooltip(button, spec.title);
	button.setAttribute('aria-label', spec.title);
	button.addEventListener('click', onClick);
	return button;
}

function separator(): HTMLElement {
	const sep = el('div', 'inkling-toolbar-sep');
	// Decoration, not structure — a screen reader announcing "separator"
	// between every group would just be noise over a row of eight buttons.
	sep.setAttribute('aria-hidden', 'true');
	return sep;
}

// A full-width top toolbar for the shared annotation tool module — the
// Xodo/Samsung-Notes-style horizontal strip the user asked for, rather than
// a small draggable floating palette. Fronts the same controller in both the
// PDF view and Markdown ink blocks, which is why it takes a host element
// rather than reaching into either one's DOM itself.
export function buildToolbar(host: HTMLElement, controller: AnnotationController): () => void {
	const toolbar = el('div', 'inkling-toolbar');

	const bar = el('div', 'inkling-toolbar-bar');

	const toolGroup = el('div', 'inkling-toolbar-group');
	toolGroup.setAttribute('role', 'radiogroup');
	toolGroup.setAttribute('aria-label', 'Drawing tool');
	const toolButtons = new Map<ToolType, HTMLButtonElement>();
	for (const spec of TOOL_BUTTONS) {
		const button = iconButton('inkling-tool-button', spec, () => controller.setTool(spec.tool));
		button.setAttribute('role', 'radio');
		toolButtons.set(spec.tool, button);
		toolGroup.appendChild(button);
	}

	const colorGroup = el('div', 'inkling-toolbar-group inkling-color-group');
	colorGroup.setAttribute('aria-label', 'Color');
	const colorButtons = new Map<string, HTMLButtonElement>();
	for (const { value, label } of PRESET_COLORS) {
		const swatch = el('button', 'clickable-icon inkling-color-swatch');
		swatch.type = 'button';
		// The one thing about a swatch that can't live in the stylesheet:
		// its color *is* the data.
		swatch.setCssProps({ '--inkling-swatch-color': value });
		setTooltip(swatch, label);
		swatch.setAttribute('aria-label', label);
		swatch.addEventListener('click', () => controller.setColor(value));
		colorButtons.set(value, swatch);
		colorGroup.appendChild(swatch);
	}
	const customColor = el('input', 'inkling-color-custom');
	customColor.type = 'color';
	setTooltip(customColor, 'Custom color');
	customColor.setAttribute('aria-label', 'Custom color');
	customColor.addEventListener('input', () => controller.setColor(customColor.value));
	colorGroup.appendChild(customColor);

	const widthGroup = el('div', 'inkling-toolbar-group inkling-width-group');
	// A dot drawn at the current stroke width in the current color. The
	// slider and the number say what the width *is*; this shows what it will
	// look like, which is the actual question being asked at the moment
	// someone reaches for this control.
	const widthPreview = el('div', 'inkling-width-preview');
	widthPreview.setAttribute('aria-hidden', 'true');
	const widthDot = el('div', 'inkling-width-dot');
	widthPreview.appendChild(widthDot);
	const widthSlider = el('input', 'inkling-width-slider');
	widthSlider.type = 'range';
	widthSlider.min = String(MIN_WIDTH);
	widthSlider.max = String(MAX_WIDTH);
	setTooltip(widthSlider, 'Stroke width');
	widthSlider.setAttribute('aria-label', 'Stroke width');
	const widthNumber = el('input', 'inkling-width-number');
	widthNumber.type = 'number';
	widthNumber.min = String(MIN_WIDTH);
	widthNumber.max = String(MAX_WIDTH);
	widthNumber.setAttribute('aria-label', 'Stroke width');
	const setWidthFromInput = (value: string) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		controller.setWidth(parsed);
	};
	widthSlider.addEventListener('input', () => setWidthFromInput(widthSlider.value));
	widthNumber.addEventListener('change', () => setWidthFromInput(widthNumber.value));
	widthGroup.append(widthPreview, widthSlider, widthNumber);

	const actionGroup = el('div', 'inkling-toolbar-group');
	// Icons, where these used to be text ("Undo", "Redo", "Delete", "Clear
	// page", "Add page"). That row was wider than a phone screen on its own —
	// see .inkling-toolbar-group in styles.css for the wrapping that had to
	// be added to stop it running off-screen — and it's the same five verbs
	// every drawing app labels with icons anyway.
	const undoButton = iconButton('inkling-tool-button', { icon: 'undo', fallback: '↶', title: 'Undo' }, () => controller.undo());
	const redoButton = iconButton('inkling-tool-button', { icon: 'redo', fallback: '↷', title: 'Redo' }, () => controller.redo());
	const deleteButton = iconButton(
		'inkling-tool-button',
		{ icon: 'trash-2', fallback: '␡', title: 'Delete selection' },
		() => controller.deleteSelection(),
	);
	const clearPageButton = iconButton(
		'inkling-tool-button',
		{ icon: 'file-x', fallback: '⌧', title: 'Clear page' },
		() => controller.clearCurrentPage(),
	);
	// Only meaningful for plugin-created handwritten notes — hidden for
	// imported PDFs (books, papers, ...) via the refresh() below, since
	// there's no notion of "add a blank/lined/dot-grid page" to a book.
	const addPageButton = iconButton(
		'inkling-tool-button',
		{ icon: 'file-plus', fallback: '＋', title: 'Add page' },
		() => controller.addPage(),
	);
	actionGroup.append(undoButton, redoButton, separator(), deleteButton, clearPageButton, addPageButton);

	// Readouts, not controls — pushed to the far end of the strip (see
	// .inkling-toolbar-status) so the things you press stay together on the
	// left instead of being pulled apart by text that changes width as you
	// scroll or zoom.
	const statusGroup = el('div', 'inkling-toolbar-group inkling-toolbar-status');
	const pageLabel = el('span', 'inkling-status-label');
	setTooltip(pageLabel, 'Current page');
	// Only meaningful once a page is actually pinch-zoomed (see pointer.ts) —
	// hidden at 100% by the refresh() below rather than sitting there as
	// permanent "100%" clutter.
	const zoomLabel = el('span', 'inkling-status-label');
	setTooltip(zoomLabel, 'Zoom');
	statusGroup.append(pageLabel, zoomLabel);

	bar.append(toolGroup, separator(), colorGroup, separator(), widthGroup, separator(), actionGroup, statusGroup);
	toolbar.append(bar);
	host.appendChild(toolbar);

	const refresh = () => {
		const activeTool = controller.getTool();
		for (const [tool, button] of toolButtons) {
			const active = tool === activeTool;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-checked', String(active));
		}

		const activeColor = controller.getColor();
		for (const [color, button] of colorButtons) {
			const active = color === activeColor;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-pressed', String(active));
		}
		customColor.value = activeColor;

		const width = controller.getWidth();
		widthSlider.value = String(width);
		widthNumber.value = String(width);
		// Capped well below MAX_WIDTH: a 40px dot would be taller than the
		// toolbar row itself. Past the cap the dot simply stops growing,
		// which is fine — by then the number beside it is doing the talking.
		widthDot.setCssProps({
			'--inkling-dot-size': `${Math.min(width, 16)}px`,
			'--inkling-dot-color': activeColor,
		});

		const zoom = controller.getZoom();
		zoomLabel.hidden = zoom <= 1;
		zoomLabel.setText(`${Math.round(zoom * 100)}%`);

		// Hidden for a single-page surface (every Markdown ink block, and a
		// one-page note), where "1 / 1" says nothing anyone needed to know.
		const pageCount = controller.getPageCount();
		pageLabel.hidden = pageCount <= 1;
		pageLabel.setText(`${controller.getCurrentPageNumber()} / ${pageCount}`);

		undoButton.disabled = !controller.canUndo;
		redoButton.disabled = !controller.canRedo;
		deleteButton.disabled = !controller.hasSelection();
		addPageButton.hidden = !controller.getCanManagePages();
	};
	refresh();

	const unsubscribe = controller.subscribe(refresh);

	return () => {
		unsubscribe();
		toolbar.remove();
	};
}
