#!/usr/bin/env node
// Build: tsc compiles the server, the CLI and the shared core; esbuild bundles the dashboard into one script.
//
//   node scripts/build.mjs            full build into dist/
//   node scripts/build.mjs --web      dashboard bundle and static files only
//   node scripts/build.mjs --demo     also write dist/demo/index.html, a single self-contained sample page
//   node scripts/build.mjs --watch    rebuild the dashboard bundle on change

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const out = join(root, 'dist');
const publicOut = join(out, 'public');

const FONTS = [
  ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
  ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2'],
  ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2']
];

const bundleOptions = {
  entryPoints: [join(root, 'src/web/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  outfile: join(publicOut, 'app.js'),
  logLevel: 'warning'
};

function copyStatic() {
  mkdirSync(join(publicOut, 'fonts'), { recursive: true });
  cpSync(join(root, 'public'), publicOut, { recursive: true });
  for (const [pkg, file] of FONTS) {
    cpSync(join(root, 'node_modules', pkg, 'files', file), join(publicOut, 'fonts', file));
  }
  // IBM Plex is licensed under the SIL Open Font License; ship the notice next to the files.
  const license = join(root, 'node_modules/@fontsource/ibm-plex-sans/LICENSE');
  if (existsSync(license)) cpSync(license, join(publicOut, 'fonts', 'LICENSE.txt'));
}

function compileServer() {
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit', cwd: root });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const main = join(out, 'cli/main.js');
  if (existsSync(main)) chmodSync(main, 0o755);
}

/** One HTML file with styles, fonts and script inlined, running on sample data. */
async function buildDemo() {
  const result = await esbuild.build({ ...bundleOptions, sourcemap: false, write: false, outfile: undefined, format: 'iife' });
  const script = result.outputFiles[0].text;
  let css = readFileSync(join(root, 'public/app.css'), 'utf8');
  for (const [pkg, file] of FONTS) {
    const data = readFileSync(join(root, 'node_modules', pkg, 'files', file)).toString('base64');
    css = css.replace(`url("fonts/${file}")`, `url("data:font/woff2;base64,${data}")`);
  }
  const html = readFileSync(join(root, 'public/index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="app.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script type="module" src="app.js"></script>', () => `<script>window.__TOKENGATOR_SAMPLE__ = true;</script>\n<script>\n${script.replace(/<\/script/g, '<\\/script')}\n</script>`);
  mkdirSync(join(out, 'demo'), { recursive: true });
  writeFileSync(join(out, 'demo/index.html'), html);
  console.error(`demo: dist/demo/index.html (${Math.round(html.length / 1024)} KB)`);

  // The same page as a fragment (no html/head/body), for hosts that wrap content in their own document.
  const fragment = [
    '<title>Tokengator</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    `<style>\n${css}\n</style>`,
    '<div id="app" class="app"><p class="boot" id="boot">Loading sample quotas…</p></div>',
    '<script>window.__TOKENGATOR_SAMPLE__ = true;</script>',
    `<script>\n${script.replace(/<\/script/g, '<\\/script')}\n</script>`
  ].join('\n');
  writeFileSync(join(out, 'demo/fragment.html'), fragment);
}

if (args.has('--watch')) {
  copyStatic();
  const context = await esbuild.context({ ...bundleOptions, minify: false });
  await context.watch();
  console.error('watching src/web and src/core …');
} else {
  if (!args.has('--web') && !args.has('--demo')) rmSync(out, { recursive: true, force: true });
  if (!args.has('--web')) compileServer();
  copyStatic();
  await esbuild.build(bundleOptions);
  if (args.has('--demo')) await buildDemo();
}
