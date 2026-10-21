// Loads the real application code (src/app.js) in a Node VM with DOM stubs and the
// device data from data/*.json, and returns the editor class plus test helpers.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDocument, StubElement } from './dom-stub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadApp() {
  const app = readFileSync(join(root, 'src', 'app.js'), 'utf8');
  const modules = JSON.parse(readFileSync(join(root, 'data', 'modules.json'), 'utf8'));
  const commands = JSON.parse(readFileSync(join(root, 'data', 'commands.json'), 'utf8'));
  const document = createDocument();
  const toasts = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Map, Set, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Uint8Array, parseInt, parseFloat, isNaN,
    Event: class { constructor(type) { this.type = type; } },
    Element: StubElement,
    Node: StubElement,
    document,
    navigator: {},
    window: { PocketEditData: { modules, commands } },
    showToast: (message, type) => toasts.push({ message, type }),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  // Expose the lexical class declaration to tests.
  vm.runInContext(`${app}\n;globalThis.__EditorClass = SonicakeBLEEditor;`, context, { filename: 'src/app.js' });
  const EditorClass = context.__EditorClass;
  if (typeof EditorClass !== 'function') throw new Error('SonicakeBLEEditor not found in src/app.js');

  // An instance whose constructor side effects are skipped, with logging captured.
  const makeEditor = () => {
    const editor = Object.create(EditorClass.prototype);
    editor.definitions = modules;
    editor.commands = commands;
    editor.logs = [];
    editor.log = (message, type = 'info') => editor.logs.push({ message, type });
    editor._writeQueue = Promise.resolve();
    editor._ackWaiters = [];
    return editor;
  };

  return { context, sandbox, document, EditorClass, modules, commands, makeEditor, toasts };
}
