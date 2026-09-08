// Straight from the types module rather than through the ./annotate barrel:
// that barrel re-exports the toolbar, which imports Obsidian, and this
// module has to stay loadable without an app around it — which is what
// makes it testable.
import { ALL_PRESET_COLORS } from './annotate/types';
import { TEMPLATE_STYLES, type PageSizeName, type TemplateStyle } from './templates';

export type { PageSizeName };

// Everything the tracks introduced as a constant, made a preference.
//
// Every default here reproduces the behaviour that shipped before this
// existed. A settings tab that changes how the plugin works the moment it
// is added is a settings tab that broke something.

export type SaveCadence = 'auto' | 'frequent';
export type ShapeRecognition = 'off' | 'hold';
export type DarkInversion = 'off' | 'on' | 'follow-theme';

export interface InklingSettings {
	defaultTemplate: TemplateStyle;
	pageSize: PageSizeName;
	saveCadence: SaveCadence;
	pressure: boolean;
	smoothing: boolean;
	shapeRecognition: ShapeRecognition;
	darkInversion: DarkInversion;
	toolbarStartsCollapsed: boolean;
	extractionNotePattern: string;
	// Colour category names, keyed by lowercase hex — so "Yellow =
	// definition, Red = disagree" works without touching code.
	colorLabels: Record<string, string>;
}

function defaultColorLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const { value, label } of ALL_PRESET_COLORS) labels[value.toLowerCase()] = label;
	return labels;
}

export function defaultSettings(): InklingSettings {
	return {
		defaultTemplate: 'blank',
		pageSize: 'letter',
		saveCadence: 'auto',
		pressure: true,
		smoothing: true,
		shapeRecognition: 'hold',
		darkInversion: 'follow-theme',
		toolbarStartsCollapsed: false,
		extractionNotePattern: '{folder}/{name} — annotations.md',
		colorLabels: defaultColorLabels(),
	};
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

// loadData() returns whatever is on disk — hand-edited, written by a future
// version, or absent entirely — so this is the boundary that has to be
// defensive. Every field falls back to its default when missing, wrongly
// typed, or out of range, and unknown keys are dropped rather than carried
// into the rest of the plugin.
export function normalizeSettings(raw: unknown): InklingSettings {
	const defaults = defaultSettings();
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaults;
	const source = raw as Record<string, unknown>;

	const labels = defaultColorLabels();
	const rawLabels = source.colorLabels;
	if (typeof rawLabels === 'object' && rawLabels !== null && !Array.isArray(rawLabels)) {
		for (const [color, label] of Object.entries(rawLabels as Record<string, unknown>)) {
			// Only labels for colours we know about: a stray key would become
			// a category that can never be applied to anything.
			if (typeof label === 'string' && label.trim() && color.toLowerCase() in labels) {
				labels[color.toLowerCase()] = label.trim();
			}
		}
	}

	const pattern = source.extractionNotePattern;
	// A pattern with no {name} in it would put every book's annotations in
	// one file, each run wiping the last. That is not a preference anyone
	// means to express.
	const usablePattern =
		typeof pattern === 'string' && pattern.trim().includes('{name}') ? pattern.trim() : defaults.extractionNotePattern;

	return {
		defaultTemplate: pick(source.defaultTemplate, TEMPLATE_STYLES, defaults.defaultTemplate),
		pageSize: pick(source.pageSize, ['letter', 'a4'] as const, defaults.pageSize),
		saveCadence: pick(source.saveCadence, ['auto', 'frequent'] as const, defaults.saveCadence),
		pressure: bool(source.pressure, defaults.pressure),
		smoothing: bool(source.smoothing, defaults.smoothing),
		shapeRecognition: pick(source.shapeRecognition, ['off', 'hold'] as const, defaults.shapeRecognition),
		darkInversion: pick(source.darkInversion, ['off', 'on', 'follow-theme'] as const, defaults.darkInversion),
		toolbarStartsCollapsed: bool(source.toolbarStartsCollapsed, defaults.toolbarStartsCollapsed),
		extractionNotePattern: usablePattern,
		colorLabels: labels,
	};
}
