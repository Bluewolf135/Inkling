// Keeping a popover inside the page it belongs to.
//
// A note's editor is a child of the page placeholder, and that placeholder
// sets `overflow: hidden` — it has to, because a pinch-zoomed page must not
// spill over the pages around it. The consequence is that anything
// positioned near an edge is *cut off* rather than merely awkward: measured
// in the running app, a note tapped at 97% of the page width put 251px of a
// 280px popover outside the box, taking the Save button with it. There was
// no way to save that note at all.
//
// Pure, and separated from the view for that reason: the arithmetic is worth
// testing and the DOM around it is not.

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

/**
 * Where to put a popover of `size` asked for at `at`, so that it stays
 * within `box` with `margin` to spare on the far edges.
 *
 * The near edge wins any argument with the far one: a popover larger than
 * the box is placed at the origin rather than pushed off the opposite side,
 * because half a popover with its text showing beats half a popover with
 * nothing.
 */
export function placeWithin(at: Point, size: Size, box: Size, margin: number): Point {
	const clamp = (value: number, extent: number, limit: number): number => {
		// Math.max last, so a popover too large for the box lands at 0 rather
		// than at a negative offset.
		const furthest = limit - extent - margin;
		return Math.max(0, Math.min(value, furthest));
	};

	return {
		// A popover with no measured size yet must not be moved on the
		// strength of that zero — it is placed where it was asked for and
		// corrected once layout has given it an extent.
		x: size.width > 0 ? clamp(at.x, size.width, box.width) : Math.max(0, at.x),
		y: size.height > 0 ? clamp(at.y, size.height, box.height) : Math.max(0, at.y),
	};
}
