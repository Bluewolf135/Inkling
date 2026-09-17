import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from 'obsidian';
import { ALL_PRESET_COLORS } from './annotate';
import { TEMPLATE_STYLES, TEMPLATE_STYLE_LABELS } from './templates';
import { colorLabelKey, defaultSettings, readSetting, writeSetting, type InklingSettings } from './settings';

// The Obsidian-facing half of the settings. The pure half — the shape,
// the defaults, the defensive read of whatever loadData() returns, and
// reading or writing one setting by key — lives in ./settings so it can be
// tested without standing up an app.
export interface SettingsHost extends Plugin {
	settings: InklingSettings;
	saveSettings(): Promise<void>;
}

// Described declaratively, with Obsidian 1.13's settings API: the tab says
// what its settings are and Obsidian draws them, which is also what puts
// every one of them in Obsidian's settings search. minAppVersion is 1.13.0
// for this; an older app would load the plugin with an empty tab.
export class InklingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SettingsHost,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const defaults = defaultSettings();

		return [
			{
				type: 'group',
				heading: 'Handwritten notes',
				items: [
					{
						name: 'Default template',
						desc: 'The ruling a new handwritten note starts with.',
						control: {
							type: 'dropdown',
							key: 'defaultTemplate',
							defaultValue: defaults.defaultTemplate,
							options: Object.fromEntries(TEMPLATE_STYLES.map((style) => [style, TEMPLATE_STYLE_LABELS[style]])),
						},
					},
					{
						name: 'Page size',
						desc: 'The paper size for new handwritten notes and for pages added to them.',
						control: { type: 'dropdown', key: 'pageSize', defaultValue: defaults.pageSize, options: { letter: 'Letter', a4: 'A4' } },
					},
				],
			},
			{
				type: 'group',
				heading: 'Pen',
				items: [
					{
						name: 'Pressure sensitivity',
						desc: 'Vary a pen stroke’s width with how hard the stylus presses. Has no effect on a mouse.',
						aliases: ['stylus', 'taper'],
						control: { type: 'toggle', key: 'pressure', defaultValue: defaults.pressure },
					},
					{
						name: 'Stroke smoothing',
						desc: 'Fit a curve through the pen’s samples instead of joining them with straight lines.',
						control: { type: 'toggle', key: 'smoothing', defaultValue: defaults.smoothing },
					},
					{
						name: 'Shape recognition',
						desc: 'Hold the pen still at the end of a stroke to snap a rough circle, box or line to a clean one.',
						control: {
							type: 'dropdown',
							key: 'shapeRecognition',
							defaultValue: defaults.shapeRecognition,
							options: { hold: 'Hold to snap', off: 'Off' },
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Reading and editing',
				items: [
					{
						name: 'Invert PDF pages',
						desc: 'Darken the PDF page, and invert the ink on it so it stays readable. Off by default: the toolbar’s contrast button flips one document without changing this.',
						aliases: ['dark mode', 'night'],
						control: {
							type: 'dropdown',
							key: 'darkInversion',
							defaultValue: defaults.darkInversion,
							options: { off: 'Never', 'follow-theme': 'Follow theme', on: 'Always' },
						},
					},
					{
						name: 'Start with the toolbar collapsed',
						desc: 'Useful on a phone, where the full tool strip covers a real slice of the page.',
						control: { type: 'toggle', key: 'toolbarStartsCollapsed', defaultValue: defaults.toolbarStartsCollapsed },
					},
					{
						name: 'Ink block captions',
						desc:
							'Adds a line under each ink block for a short description, so a page of handwriting reads as something in search results ' +
							'and to a screen reader. A block that already has a caption always shows it, whether or not this is on.',
						control: { type: 'toggle', key: 'blockCaptions', defaultValue: defaults.blockCaptions },
					},
					{
						name: 'Save frequency',
						desc:
							'Automatic scales how often a PDF is written to its size, so a large textbook is not rewritten every few seconds. ' +
							'Frequent saves every ten seconds whatever the size.',
						control: { type: 'dropdown', key: 'saveCadence', defaultValue: defaults.saveCadence, options: { auto: 'Automatic', frequent: 'Frequent' } },
					},
				],
			},
			{
				type: 'group',
				heading: 'Extracted notes',
				items: [
					{
						name: 'Note path',
						desc: 'Where an extracted note goes. {folder} and {name} come from the PDF. Must contain {name}.',
						control: {
							type: 'text',
							key: 'extractionNotePattern',
							defaultValue: defaults.extractionNotePattern,
							placeholder: defaults.extractionNotePattern,
							// Refused rather than saved: a path with no {name} would
							// put every book's annotations in one file, each run
							// wiping the last.
							validate: (value) => (value.includes('{name}') ? undefined : 'Must contain {name}, or every PDF would share one note.'),
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Colour categories',
				items: [
					{
						name: 'What each colour means',
						desc: 'For the pen and the highlighter alike. These become the headings in an extracted note.',
					},
					...ALL_PRESET_COLORS.map(({ value, label }) => ({
						name: label,
						aliases: [value],
						control: { type: 'text' as const, key: colorLabelKey(value), defaultValue: label, placeholder: label },
					})),
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return readSetting(this.plugin.settings, key);
	}

	// In place: the views, commands and ink blocks each hold a getter over
	// this one object, so replacing it would leave them reading the old one.
	async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, writeSetting(this.plugin.settings, key, value));
		await this.plugin.saveSettings();
	}
}
