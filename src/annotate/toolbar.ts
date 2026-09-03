import { AnnotationController } from './controller';
import { MAX_WIDTH, MIN_WIDTH, PRESET_COLORS, ToolType } from './types';

const TOOL_BUTTONS: Array<{ tool: ToolType; label: string; title: string }> = [
	{ tool: 'select', label: '⇖', title: 'Select / lasso' },
	{ tool: 'pen', label: '✏️', title: 'Pen' },
	{ tool: 'highlighter', label: '🖊️', title: 'Highlighter' },
	{ tool: 'eraser', label: '⌫', title: 'Eraser' },
	{ tool: 'line', label: '╱', title: 'Line' },
	{ tool: 'rectangle', label: '▭', title: 'Rectangle' },
	{ tool: 'oval', label: '◯', title: 'Oval' },
	{ tool: 'arrow', label: '↗', title: 'Arrow' },
];

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

// A full-width top toolbar for the shared annotation tool module — the
// Xodo/Samsung-Notes-style horizontal strip the user asked for, rather than
// a small draggable floating palette. Pure DOM, no Obsidian dependency, so
// it can front the same controller in the Markdown ink-block view later.
export function buildToolbar(host: HTMLElement, controller: AnnotationController): () => void {
	const toolbar = el('div', 'inkling-toolbar');

	const bar = el('div', 'inkling-toolbar-bar');

	const toolGroup = el('div', 'inkling-toolbar-group');
	const toolButtons = new Map<ToolType, HTMLButtonElement>();
	for (const { tool, label, title } of TOOL_BUTTONS) {
		const button = el('button', 'inkling-tool-button', label);
		button.type = 'button';
		button.title = title;
		button.addEventListener('click', () => controller.setTool(tool));
		toolButtons.set(tool, button);
		toolGroup.appendChild(button);
	}

	const colorGroup = el('div', 'inkling-toolbar-group inkling-color-group');
	const colorButtons = new Map<string, HTMLButtonElement>();
	for (const color of PRESET_COLORS) {
		const swatch = el('button', 'inkling-color-swatch');
		swatch.type = 'button';
		swatch.setCssStyles({ backgroundColor: color });
		swatch.title = color;
		swatch.addEventListener('click', () => controller.setColor(color));
		colorButtons.set(color, swatch);
		colorGroup.appendChild(swatch);
	}
	const customColor = el('input', 'inkling-color-custom');
	customColor.type = 'color';
	customColor.title = 'Custom color';
	customColor.addEventListener('input', () => controller.setColor(customColor.value));
	colorGroup.appendChild(customColor);

	// Only meaningful once a page's actually pinch-zoomed (see pointer.ts) —
	// hidden at 100% via the refresh() below rather than always showing
	// "100%" clutter.
	const zoomLabel = el('span', 'inkling-zoom-label');
	colorGroup.appendChild(zoomLabel);

	const widthGroup = el('div', 'inkling-toolbar-group inkling-width-group');
	const widthSlider = el('input', 'inkling-width-slider');
	widthSlider.type = 'range';
	widthSlider.min = String(MIN_WIDTH);
	widthSlider.max = String(MAX_WIDTH);
	const widthNumber = el('input', 'inkling-width-number');
	widthNumber.type = 'number';
	widthNumber.min = String(MIN_WIDTH);
	widthNumber.max = String(MAX_WIDTH);
	const setWidthFromInput = (value: string) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		controller.setWidth(parsed);
	};
	widthSlider.addEventListener('input', () => setWidthFromInput(widthSlider.value));
	widthNumber.addEventListener('change', () => setWidthFromInput(widthNumber.value));
	widthGroup.append(widthSlider, widthNumber);

	const actionGroup = el('div', 'inkling-toolbar-group');
	const undoButton = el('button', 'inkling-toolbar-button', 'Undo');
	undoButton.type = 'button';
	undoButton.addEventListener('click', () => controller.undo());
	const redoButton = el('button', 'inkling-toolbar-button', 'Redo');
	redoButton.type = 'button';
	redoButton.addEventListener('click', () => controller.redo());
	const deleteButton = el('button', 'inkling-toolbar-button', 'Delete');
	deleteButton.type = 'button';
	deleteButton.addEventListener('click', () => controller.deleteSelection());
	const clearPageButton = el('button', 'inkling-toolbar-button', 'Clear page');
	clearPageButton.type = 'button';
	clearPageButton.addEventListener('click', () => controller.clearCurrentPage());
	// Only meaningful for plugin-created handwritten notes — hidden for
	// imported PDFs (books, papers, ...) via the refresh() below, since
	// there's no notion of "add a blank/lined/dot-grid page" to a book.
	const addPageButton = el('button', 'inkling-toolbar-button', 'Add page');
	addPageButton.type = 'button';
	addPageButton.addEventListener('click', () => controller.addPage());
	actionGroup.append(undoButton, redoButton, deleteButton, clearPageButton, addPageButton);

	bar.append(toolGroup, colorGroup, widthGroup, actionGroup);
	toolbar.append(bar);
	host.appendChild(toolbar);

	const refresh = () => {
		const activeTool = controller.getTool();
		for (const [tool, button] of toolButtons) button.classList.toggle('is-active', tool === activeTool);

		const activeColor = controller.getColor();
		for (const [color, button] of colorButtons) button.classList.toggle('is-active', color === activeColor);
		customColor.value = activeColor;

		widthSlider.value = String(controller.getWidth());
		widthNumber.value = String(controller.getWidth());

		const zoom = controller.getZoom();
		zoomLabel.hidden = zoom <= 1;
		zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

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
