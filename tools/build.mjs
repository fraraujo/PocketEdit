#!/usr/bin/env node
// Builds the single, self-contained index.html from:
//   src/template.html - markup, CSS and the script shell with three markers:
//                         window.PocketEditData = /*POCKETEDIT-DATA*/;
//                         /*POCKETEDIT-SHELL*/  (page-level listeners + bootstrap)
//                         /*POCKETEDIT-APP*/    (the editor itself)
//   src/app.js        - the editor code (no device data)
//   src/shell.js      - page-level DOM listeners and the DOMContentLoaded bootstrap
//   data/*.json       - the device data (source of truth)
//
// The result works offline with a double-click and can be published as a static
// page. It must be byte-identical to the previous hand-maintained file when the
// inputs are unchanged (verified with --check in CI).
//
// Usage:
//   node tools/build.mjs           # write index.html
//   node tools/build.mjs --check   # exit 1 if index.html is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const DATA_MARKER = '/*POCKETEDIT-DATA*/';
const SHELL_MARKER = '/*POCKETEDIT-SHELL*/';
const APP_MARKER = '/*POCKETEDIT-APP*/';

const fail = (msg) => { console.error(`build: ${msg}`); process.exit(1); };

const modules = JSON.parse(read('data/modules.json'));
const commands = JSON.parse(read('data/commands.json'));
const template = read('src/template.html');
const app = read('src/app.js');
const shell = read('src/shell.js');

// ---- sanity checks: a broken data file must fail the build loudly ----
if (!modules.effectLibrary || !Array.isArray(modules.modules)) fail('data/modules.json is missing effectLibrary/modules');
for (const key of ['effectTypes', 'parameters', 'chainOrderCommands', 'moduleStates', 'ampModes', 'globalCommands', 'presetCommands']) {
  if (!commands[key]) fail(`data/commands.json is missing "${key}"`);
}
// The FIXME that used to be a JS comment in the data is preserved as a key.
if (!commands._comment) fail('data/commands.json lost its _comment');
for (const mod of modules.modules) {
  for (const fxId of mod.effects) {
    if (!modules.effectLibrary[fxId]) fail(`module ${mod.name} references unknown effect ${fxId}`);
  }
}
for (const modId in commands.effectTypes) {
  for (const fxId in commands.effectTypes[modId]) {
    if (!modules.effectLibrary[fxId]) fail(`commands.effectTypes references unknown effect ${fxId}`);
  }
}

if (!template.includes(DATA_MARKER)) fail(`src/template.html has no ${DATA_MARKER} marker`);
if (!template.includes(APP_MARKER)) fail(`src/template.html has no ${APP_MARKER} marker`);
if (!template.includes(SHELL_MARKER)) fail(`src/template.html has no ${SHELL_MARKER} marker`);
for (const [name, code] of [['src/app.js', app], ['src/shell.js', shell]]) {
  for (const marker of [DATA_MARKER, APP_MARKER, SHELL_MARKER]) {
    if (code.includes(marker)) fail(`${name} must not contain the ${marker} marker`);
  }
}

// The JSON is used inline; it must be byte-identical to the original hand-written
// object (same minified representation) so no behaviour changes sneak in.
const dataJson = JSON.stringify({ modules, commands });
if (dataJson.includes('</script')) fail('data contains "</script" and would break the inline script');

// The template is indented with 8 spaces before the data marker in the source.
const indent = (template.slice(0, template.indexOf(DATA_MARKER)).match(/[ \t]*$/) || [''])[0];
const html = template
  .replace(DATA_MARKER, () => dataJson)
  .replace(SHELL_MARKER, () => shell.replace(/\s+$/, ''))
  .replace(APP_MARKER, () => app);

const target = join(root, 'index.html');

if (process.argv.includes('--check')) {
  const current = (() => { try { return readFileSync(target, 'utf8'); } catch { return ''; } })();
  if (current !== html) {
    console.error('build: index.html is out of date. Run `node tools/build.mjs`.');
    process.exit(1);
  }
  console.log('build: index.html is up to date.');
  process.exit(0);
}

writeFileSync(target, html);
console.log(`build: index.html written (${(html.length / 1024).toFixed(1)} KB, ${html.split('\n').length} lines)`);
