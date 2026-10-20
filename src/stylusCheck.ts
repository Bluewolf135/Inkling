import { Notice } from 'obsidian';

// What a stylus tells this device, live — for finding out whether a pen's
// side button and eraser reach Obsidian at all, which depends on the device
// and its system rather than on anything here.
//
// A Samsung S Pen's button needs no Bluetooth: the screen reads it from the
// pen's own signal, which is why it works in Samsung Notes with the pen
// disconnected. Whether Obsidian's web view passes it on is what this shows.

export function startStylusCheck(win: Window): void {
	const notice = new Notice('', 0);
	const show = (lines: string[]) => notice.setMessage(lines.join('\n'));
	show([
		'Stylus check — touch the screen with the pen.',
		'Hold the side button while touching, and try the eraser end if it has one.',
		'Tap this message to stop.',
	]);

	let frame: number | null = null;
	let last: PointerEvent | null = null;
	const onPointer = (event: PointerEvent) => {
		// Stopped when the message is gone: a notice closes when tapped.
		if (!notice.messageEl.isConnected) {
			stop();
			return;
		}
		last = event;
		frame ??= win.requestAnimationFrame(() => {
			frame = null;
			const sample = last;
			if (!sample) return;
			const side = sample.button === 2 || (sample.buttons & 2) !== 0;
			const eraser = sample.button === 5 || (sample.buttons & 32) !== 0;
			show([
				`Input: ${sample.pointerType}${sample.pointerType === 'pen' ? '' : ' (not recognised as a pen)'}`,
				`Pressure: ${sample.pressure.toFixed(2)}`,
				`Side button: ${side ? 'pressed ✓' : 'not pressed'}`,
				`Eraser end: ${eraser ? 'in use ✓' : 'no'}`,
				`(button ${sample.button}, buttons ${sample.buttons}) — tap here to stop`,
			]);
		});
	};
	const stop = () => {
		win.removeEventListener('pointerdown', onPointer, true);
		win.removeEventListener('pointermove', onPointer, true);
		if (frame !== null) win.cancelAnimationFrame(frame);
		notice.hide();
	};
	win.addEventListener('pointerdown', onPointer, true);
	win.addEventListener('pointermove', onPointer, true);
}
