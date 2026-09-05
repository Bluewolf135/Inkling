import { defineConfig } from 'vitest/config';

// Node, not jsdom: everything covered here is pure logic over plain data
// structures — geometry, parsing, tool state, PDF object graphs — with no
// DOM in it. Anything that does touch the DOM gets an environment override
// in its own file rather than slowing every test down with a jsdom global.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
	},
});
