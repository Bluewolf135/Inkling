import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'pdf.worker.js',
		// Bundled build output, like the two above it — added when the
		// annotation writer moved into its own worker.
		'annotation-writer.worker.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The obsidianmd rules encode constraints of the Obsidian *runtime* —
		// use createDiv() rather than document.createElement, prefer the
		// active window to globalThis. Tests run in Node, where none of those
		// helpers exist and globalThis is the only window there is, so the
		// rules would be asking test code to call functions that are not
		// there. The plugin's own sources are still held to all of them.
		files: ['tests/**/*.ts'],
		rules: {
			'obsidianmd/prefer-create-el': 'off',
			'obsidianmd/no-global-this': 'off',
		},
	},
);
