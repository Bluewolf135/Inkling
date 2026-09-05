import { describe, expect, it, vi } from 'vitest';
import { ToolState } from '../../src/annotate/toolState';
import { DEFAULT_COLOR, DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH } from '../../src/annotate/types';

describe('ToolState', () => {
	it('starts on select at the defaults', () => {
		const state = new ToolState();
		expect(state.getTool()).toBe('select');
		expect(state.getColor()).toBe(DEFAULT_COLOR);
		expect(state.getWidth()).toBe(DEFAULT_WIDTH);
	});

	it('remembers color and width per tool', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setColor('#e03131');
		state.setWidth(8);

		state.setTool('highlighter');
		state.setWidth(20);
		expect(state.getWidth()).toBe(20);

		state.setTool('pen');
		expect(state.getColor()).toBe('#e03131');
		expect(state.getWidth()).toBe(8);
	});

	it('clamps width to the allowed range', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setWidth(9999);
		expect(state.getWidth()).toBe(MAX_WIDTH);
		state.setWidth(-4);
		expect(state.getWidth()).toBe(MIN_WIDTH);
	});

	it('honours a suggestion only until the user picks a tool', () => {
		const state = new ToolState();
		state.suggestTool('pen');
		expect(state.getTool()).toBe('pen');

		state.setTool('select');
		state.suggestTool('pen');
		// An ink block re-renders on every save and suggests again; that must
		// not drag the user back out of the lasso they chose.
		expect(state.getTool()).toBe('select');
	});

	it('notifies listeners with the kind of change', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener);

		state.setTool('pen');
		expect(listener).toHaveBeenLastCalledWith('tool');

		state.setColor('#1971c2');
		expect(listener).toHaveBeenLastCalledWith('style');
	});

	it('stops notifying after unsubscribe', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener)();
		state.setTool('pen');
		expect(listener).not.toHaveBeenCalled();
	});

	it('does not notify when a setter is handed the value already held', () => {
		const state = new ToolState();
		state.setTool('pen');
		const listener = vi.fn();
		state.subscribe(listener);
		state.setTool('pen');
		state.setColor(state.getColor());
		state.setWidth(state.getWidth());
		expect(listener).not.toHaveBeenCalled();
	});
});
