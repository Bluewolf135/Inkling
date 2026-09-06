import { setIcon } from 'obsidian';

// Draws a Lucide icon into `el`, falling back to `text` when there is no
// icon to draw.
//
// The fallback exists because the icon set is the host app's, not ours, and
// it is not the same everywhere: Obsidian on a phone can be several
// versions behind the desktop, and a name added to Lucide recently is
// simply absent there. Every button in this plugin already carried a text
// fallback for exactly that.
//
// What they checked was whether setIcon had added a child, and that is not
// the same question. A name it does not know still leaves an <svg> behind —
// an empty one, with no path in it — so the count was 1, the fallback never
// fired, and the button rendered as a blank box with a working tooltip.
// Reported from a phone, where the block's "Tools" button had no icon on
// it at all.
//
// Asking whether the icon has anything *in* it answers the question that
// was meant, and turns a missing icon back into a legible label.
export function setIconOrText(el: HTMLElement, icon: string, text: string): void {
	setIcon(el, icon);

	const drawn = el.querySelector('svg');
	if (drawn && drawn.childElementCount > 0) return;

	drawn?.remove();
	el.setText(text);
}
