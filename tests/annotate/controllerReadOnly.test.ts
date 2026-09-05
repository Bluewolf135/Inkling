import { describe, expect, it } from 'vitest';
import { AnnotationController } from '../../src/annotate/controller';

// The controller's page mounting needs canvases, but read-only state is
// plain bookkeeping that can be checked without one. Input gating itself is
// verified on a real device, since it depends on pointer plumbing this
// suite deliberately does not stand up.
describe('AnnotationController read-only state', () => {
	it('starts editable', () => {
		expect(new AnnotationController().isReadOnly()).toBe(false);
	});

	it('reports what it was set to', () => {
		const controller = new AnnotationController();
		controller.setReadOnly(true);
		expect(controller.isReadOnly()).toBe(true);
		controller.setReadOnly(false);
		expect(controller.isReadOnly()).toBe(false);
	});

	it('notifies subscribers so the toolbar can repaint', () => {
		const controller = new AnnotationController();
		let notifications = 0;
		controller.subscribe(() => {
			notifications += 1;
		});
		controller.setReadOnly(true);
		expect(notifications).toBeGreaterThan(0);
	});

	it('says nothing when set to the state it already holds', () => {
		const controller = new AnnotationController();
		let notifications = 0;
		controller.subscribe(() => {
			notifications += 1;
		});
		controller.setReadOnly(false);
		expect(notifications).toBe(0);
	});

	it('drops any selection when it becomes read-only', () => {
		const controller = new AnnotationController();
		controller.setReadOnly(true);
		expect(controller.hasSelection()).toBe(false);
	});

	it('reports no gesture in flight once read-only', () => {
		// A half-finished gesture would otherwise commit on pointerup into a
		// file we have just decided not to write to.
		const controller = new AnnotationController();
		controller.setReadOnly(true);
		expect(controller.isGestureActive()).toBe(false);
	});
});
