// Build: client bundle → public/js/app.js; server bundle → dist/server.js (deps stay external).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const cfg = fs.existsSync('fragged.config.json') ? JSON.parse(fs.readFileSync('fragged.config.json', 'utf8')) : {};
// module packages are bundled (so they share the app's single SDK/registry instance); other dependencies stay external
const modulePackages = new Set(cfg.modules ?? []);
const external = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter((d) => !modulePackages.has(d)).flatMap((d) => [d, `${d}/*`]);
execFileSync(process.execPath, ['scripts/sync-modules.mjs'], { stdio: 'inherit' });
const clientOnly = process.argv.includes('--client');
const watch = process.argv.includes('--watch');
await build({
  entryPoints: ['src/client/main.ts'], bundle: true, minify: !watch, sourcemap: true, format: 'iife', target: ['es2020'],
  outfile: 'public/js/app.js', logLevel: 'info',
});
if (!clientOnly) {
  await build({
    entryPoints: ['src/server.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', external,
    alias: { 'fragged-forums/sdk': './src/sdk/index.ts' },
    outfile: 'dist/server.js', jsx: 'automatic', jsxImportSource: 'hono/jsx', sourcemap: true, logLevel: 'info',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  });
}
