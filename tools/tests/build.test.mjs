import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('index.html is generated from src/ and data/ (build --check)', () => {
  const out = execFileSync(process.execPath, [join(root, 'tools', 'build.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
});

test('index.html embeds the same data as data/*.json', () => {
  const modules = JSON.parse(readFileSync(join(root, 'data', 'modules.json'), 'utf8'));
  const commands = JSON.parse(readFileSync(join(root, 'data', 'commands.json'), 'utf8'));
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const start = html.indexOf('window.PocketEditData = ') + 'window.PocketEditData = '.length;
  const embedded = JSON.parse(html.slice(start, html.indexOf(';', start)));
  assert.deepEqual(embedded.modules, modules);
  assert.deepEqual(embedded.commands, commands);
});

test('built index.html stays a single offline file', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.equal((html.match(/<script/g) || []).length, 1, 'exactly one inline script');
  assert.ok(!/\ssrc=/.test(html), 'no external scripts');
  assert.ok(!/\sfetch\(/.test(html.replace(/window\.PocketEditData = .*;\n/s, '')), 'no fetch at runtime');
});

test('built script is valid and declares each top-level symbol once', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const open = html.lastIndexOf('<script>') + '<script>'.length;
  const close = html.lastIndexOf('</script>');
  const code = html.slice(open, close);

  // Compiling (not running) the script catches duplicate declarations and syntax errors.
  new vm.Script(code, { filename: 'index.html' });

  // A copy of the app code used to be emitted twice (template + injected src/app.js).
  // Count declarations that must be unique in the built file.
  for (const token of [
    'class SonicakeBLEEditor',
    'const CHARACTER_MAP',
    'const MODULES = {',
    'function showToast',
    'const PocketTuner = (()',
    "addEventListener('DOMContentLoaded'",
    'const MODULE_LIBRARY_DATA',
    'const COMMAND_LIBRARY_DATA',
  ]) {
    const count = code.split(token).length - 1;
    const expected = token.startsWith('const MODULE_LIBRARY') || token.startsWith('const COMMAND_LIBRARY') ? 0 : 1;
    assert.equal(count, expected, `${token} appears ${count} time(s)`);
  }
});
