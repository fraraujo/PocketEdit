// Loads the real application code (src/app.js) in a Node VM with DOM stubs and the
// device data from data/*.json, and returns the editor class plus test helpers.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  // Use real file URLs so the Node test runner attributes V8 coverage to the sources.
  // (An unnamed script would be exposed as anonymous eval code and never measured.)
  const appPath = join(root, 'src', 'app.js');
  vm.runInContext(`${app}\n;globalThis.__EditorClass = SonicakeBLEEditor;`, context, {
    filename: pathToFileURL(appPath).href,
  });
  const EditorClass = context.__EditorClass;
  if (typeof EditorClass !== 'function') throw new Error('SonicakeBLEEditor not found in src/app.js');

  // src/shell.js holds the page-level listeners and the bootstrap. It is executed as its
  // own script (its own file URL) so coverage is attributed to it. The template's data
  // shell is loaded just before it, mirroring the order used by the build.
  // The template's only JavaScript is the data assignment; everything else inside its
  // script tag is injected from src/app.js and src/shell.js (already executed above).
  vm.runInContext('window.PocketEditData = window.PocketEditData || {};', context, {
    filename: pathToFileURL(join(root, 'src', 'template.html')).href,
  });
  const shell = readFileSync(join(root, 'src', 'shell.js'), 'utf8');
  vm.runInContext(shell, context, { filename: pathToFileURL(join(root, 'src', 'shell.js')).href });

  // An instance whose constructor side effects are skipped, with logging captured.
  const makeEditor = () => {
    const editor = Object.create(EditorClass.prototype);
    editor.definitions = modules;
    editor.commands = commands;
    editor.logs = [];
    editor.log = (message, type = 'info') => editor.logs.push({ message, type });
    // Fields the constructor normally sets; keep them in sync with it.
    editor._writeQueue = Promise.resolve();
    editor._ackWaiters = [];
    editor.isApplyingState = false;
    editor.isSyncing = false;
    editor.isWaitingForPresetDump = false;
    editor.isWaitingForGlobals = false;
    editor.isInitialSyncing = false;
    editor.isPresetModified = false;
    editor.dumpPackets = [];
    editor.usbMidiBuffer = null;
    editor.usbMultiPacketResponses = {};
    return editor;
  };

  return { context, sandbox, document, EditorClass, modules, commands, makeEditor, toasts };
}
