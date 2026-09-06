import { defineConfig } from 'vitest/config';

// Node, not jsdom: everything covered here is pure logic over plain data
// structures — geometry, parsing, tool state, PDF object graphs — with no
// DOM in it. Anything that does touch the DOM gets an environment override
// in its own file rather than slowing every test down with a jsdom global.
export default defineConfig({
	resolve: {
		// pdfjs's default entry is the browser build and reaches for DOM
		// globals (DOMMatrix) the moment it is imported, which Node does not
		// have. The legacy build is the one pdf.js ships for exactly this.
		// Only tests resolve through here; the plugin bundle is unaffected.
		alias: { 'pdfjs-dist': new URL('./node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url).pathname },
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
	},
});
