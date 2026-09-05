import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { PRESET_COLORS } from './annotate';
import { TEMPLATE_STYLES, TEMPLATE_STYLE_LABELS } from './templates';
import { defaultSettings, normalizeSettings, type InklingSettings } from './settings';

// The Obsidian-facing half of the settings. The pure half — the shape,
// the defaults, and the defensive read of whatever loadData() returns —
// lives in ./settings so it can be tested without standing up an app.
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export interface SettingsHost extends Plugin {
	settings: InklingSettings;
	saveSettings(): Promise<void>;
}

// Built imperatively, which lint warns about and which is deliberate: the
// declarative settings API landed in Obsidian 1.13 and this plugin still
// admits 1.4.4 (see manifest.json). Adopting it means either dropping the
// tab for older builds or maintaining both descriptions of the same
// settings, which is exactly the kind of duplication that drifts. Revisit
// when minAppVersion moves past 1.13.
export class InklingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SettingsHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const commit = () => void this.plugin.saveSettings();

		new Setting(containerEl).setName('Handwritten notes').setHeading();

		new Setting(containerEl)
			.setName('Default template')
			.setDesc('The ruling a new handwritten note starts with.')
			.addDropdown((dropdown) => {
				for (const style of TEMPLATE_STYLES) dropdown.addOption(style, TEMPLATE_STYLE_LABELS[style]);
				dropdown.setValue(this.plugin.settings.defaultTemplate).onChange((value) => {
					this.plugin.settings.defaultTemplate = pick(value, TEMPLATE_STYLES, 'blank');
					commit();
				});
			});

		new Setting(containerEl)
			.setName('Page size')
			.setDesc('The paper size for new handwritten notes and for pages added to them.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('letter', 'Letter')
					.addOption('a4', 'A4')
					.setValue(this.plugin.settings.pageSize)
					.onChange((value) => {
						this.plugin.settings.pageSize = pick(value, ['letter', 'a4'] as const, 'letter');
						commit();
					});
			});

		new Setting(containerEl).setName('Pen').setHeading();

		new Setting(containerEl)
			.setName('Pressure sensitivity')
			.setDesc('Vary a pen stroke’s width with how hard the stylus presses. Has no effect on a mouse.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pressure).onChange((value) => {
					this.plugin.settings.pressure = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName('Stroke smoothing')
			.setDesc('Fit a curve through the pen’s samples instead of joining them with straight lines.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.smoothing).onChange((value) => {
					this.plugin.settings.smoothing = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName('Shape recognition')
			.setDesc('Hold the pen still at the end of a stroke to snap a rough circle, box or line to a clean one.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('hold', 'Hold to snap')
					.addOption('off', 'Off')
					.setValue(this.plugin.settings.shapeRecognition)
					.onChange((value) => {
						this.plugin.settings.shapeRecognition = pick(value, ['off', 'hold'] as const, 'hold');
						commit();
					});
			});

		new Setting(containerEl).setName('Reading and editing').setHeading();

		new Setting(containerEl)
			.setName('Invert pages in dark mode')
			.setDesc('Darken the PDF page itself. Your ink keeps its real colours either way.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('follow-theme', 'Follow theme')
					.addOption('on', 'Always')
					.addOption('off', 'Never')
					.setValue(this.plugin.settings.darkInversion)
					.onChange((value) => {
						this.plugin.settings.darkInversion = pick(value, ['off', 'on', 'follow-theme'] as const, 'follow-theme');
						commit();
					});
			});

		new Setting(containerEl)
			.setName('Start with the toolbar collapsed')
			.setDesc('Useful on a phone, where the full tool strip covers a real slice of the page.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.toolbarStartsCollapsed).onChange((value) => {
					this.plugin.settings.toolbarStartsCollapsed = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName('Save frequency')
			.setDesc(
				'Automatic scales how often a PDF is written to its size, so a large textbook is not rewritten every few seconds. ' +
					'Frequent saves every ten seconds whatever the size.',
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption('auto', 'Automatic')
					.addOption('frequent', 'Frequent')
					.setValue(this.plugin.settings.saveCadence)
					.onChange((value) => {
						this.plugin.settings.saveCadence = pick(value, ['auto', 'frequent'] as const, 'auto');
						commit();
					});
			});

		new Setting(containerEl).setName('Extracted notes').setHeading();

		new Setting(containerEl)
			.setName('Note path')
			.setDesc('Where an extracted note goes. {folder} and {name} come from the PDF. Must contain {name}.')
			.addText((text) =>
				text
					.setPlaceholder(defaultSettings().extractionNotePattern)
					.setValue(this.plugin.settings.extractionNotePattern)
					.onChange((value) => {
						// Normalised on the way in rather than validated with a
						// warning: a pattern with no {name} would put every
						// book's annotations in one file, each run wiping the
						// last, and that is not worth letting anyone save.
						this.plugin.settings.extractionNotePattern = normalizeSettings({
							...this.plugin.settings,
							extractionNotePattern: value,
						}).extractionNotePattern;
						commit();
					}),
			);

		new Setting(containerEl)
			.setName('Colour categories')
			.setDesc('What each highlighter colour means. These become the headings in an extracted note.');

		for (const { value, label } of PRESET_COLORS) {
			const key = value.toLowerCase();
			new Setting(containerEl)
				.setName(label)
				.addText((text) =>
					text
						.setPlaceholder(label)
						.setValue(this.plugin.settings.colorLabels[key] ?? label)
						.onChange((typed) => {
							this.plugin.settings.colorLabels[key] = typed.trim() || label;
							commit();
						}),
				);
		}
	}
}
