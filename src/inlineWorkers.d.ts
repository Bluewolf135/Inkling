// A worker's bundled source, embedded in main.js by esbuild.config.mjs's
// inline-workers plugin. Only the plugin bundle resolves these; nothing under
// tests/ imports main.ts, so vitest never has to.
declare module 'inline-worker:*' {
	const source: string;
	export default source;
}
