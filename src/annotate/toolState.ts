import { DEFAULT_COLOR, DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, ToolType } from './types';

export interface ToolStyle {
	color: string;
	width: number;
}

// Which half of the state moved. Listeners need to tell them apart: a
// controller drops any in-flight drag and clears a selection the new tool
// can't act on when the *tool* changes, but must leave that selection alone
// on a *style* change — recoloring a selection is exactly what the color
// swatches do while something is selected.
export type ToolStateChange = 'tool' | 'style';

// The selected tool and its color/width, held *outside* any one controller.
//
// This exists because a Markdown ink block's controller does not survive the
// user drawing in it. Saving a block rewrites its own fenced source, which
// makes Obsidian re-render that section, which unloads the render child and
// builds a fresh InkBlockView — so anything the user had set on the old
// controller (pen 8px, red) died with it about a second after they finished
// a stroke, and the next stroke came out at the defaults. Keeping tool
// state here, owned by the plugin and handed to every controller, means a
// re-render rebuilds the surface without disturbing the choices made about
// what to draw with.
//
// Sharing it across surfaces is deliberate rather than merely convenient:
// picking red 8px in one ink block and finding the pen black 3px again in
// the next block down (or in a PDF) is the same "it forgot" complaint one
// scope up. Every drawing app treats the pen as one pen.
export class ToolState {
	private tool: ToolType = 'select';
	// Whether `tool` reflects a choice the user actually made, as opposed to
	// the starting default. See suggestTool.
	private toolChosen = false;
	private color: string = DEFAULT_COLOR;
	private width: number = DEFAULT_WIDTH;
	// Color/width are remembered per tool (pen, highlighter, eraser, each
	// shape) rather than as one global pair — otherwise picking a color/size
	// for the highlighter and then switching to the pen would carry the
	// highlighter's values over, which reads as the pen "forgetting" its own
	// last-used settings. 'select' has no style of its own; it just reflects
	// whatever the most recently used styled tool left behind.
	private readonly styles = new Map<ToolType, ToolStyle>();
	private readonly listeners = new Set<(change: ToolStateChange) => void>();

	getTool(): ToolType {
		return this.tool;
	}

	setTool(tool: ToolType): void {
		this.toolChosen = true;
		if (tool === this.tool) return;
		this.tool = tool;
		if (tool !== 'select') {
			const style = this.styleFor(tool);
			this.color = style.color;
			this.width = style.width;
		}
		this.notify('tool');
	}

	// A surface's preferred starting tool, applied only while the user has
	// not picked one themselves. Ink blocks want to open ready to write
	// rather than in select mode — a block you added specifically to
	// handwrite into where a stylus does nothing is just broken-feeling —
	// but that preference must not keep reasserting itself: a block
	// re-renders on every save, and hard-setting the tool there would drag
	// the user out of the lasso every time they deleted a selection.
	suggestTool(tool: ToolType): void {
		if (this.toolChosen) return;
		this.setTool(tool);
		this.toolChosen = false;
	}

	getColor(): string {
		return this.color;
	}

	setColor(color: string): void {
		if (color === this.color) return;
		this.color = color;
		if (this.tool !== 'select') this.styles.set(this.tool, { ...this.styleFor(this.tool), color });
		this.notify('style');
	}

	getWidth(): number {
		return this.width;
	}

	setWidth(width: number): void {
		const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
		if (clamped === this.width) return;
		this.width = clamped;
		if (this.tool !== 'select') this.styles.set(this.tool, { ...this.styleFor(this.tool), width: clamped });
		this.notify('style');
	}

	private styleFor(tool: ToolType): ToolStyle {
		return this.styles.get(tool) ?? { color: DEFAULT_COLOR, width: DEFAULT_WIDTH };
	}

	// Lets every live controller repaint its toolbar when the state changes
	// under it — two ink blocks in one note, or a note beside a PDF, are
	// separate controllers over this one selection, and a strip still
	// showing the old width would be lying about what the next stroke does.
	subscribe(listener: (change: ToolStateChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(change: ToolStateChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
