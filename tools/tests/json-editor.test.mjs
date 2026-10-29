import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor, document } = loadApp();

const VALID_PRESET = {
  version: '1.0',
  presetName: 'Test',
  ampMode: 'Normal',
  presetVolume: 75,
  modules: {
    NR: { enabled: true, effect: null, parameters: {} },
  },
  signalChain: ['NR'],
};

function editorWithJsonEditor() {
  const ed = makeEditor();
  ed.presetJsonText = document.getElementById('presetJsonText');
  ed.presetJsonStatus = document.getElementById('presetJsonStatus');
  ed.presetJsonText.value = '';
  return ed;
}

test('parsePresetJsonText rejects invalid JSON with a line hint', () => {
  const ed = makeEditor();
  assert.throws(
    () => ed.parsePresetJsonText('{\n  "modules": {\n    broken\n  }\n}'),
    (error) => {
      assert.match(error.message, /Invalid JSON/);
      assert.match(error.message, /line 3/);
      return true;
    },
  );
});

test('parsePresetJsonText requires an object with a modules map', () => {
  const ed = makeEditor();
  assert.throws(() => ed.parsePresetJsonText('[]'), /must be an object/);
  assert.throws(() => ed.parsePresetJsonText('{"version":"1.0"}'), /missing the "modules" object/);
  assert.deepEqual(ed.parsePresetJsonText(JSON.stringify(VALID_PRESET)), VALID_PRESET);
});

test('validatePresetJsonInput reports valid and invalid text', () => {
  const ed = editorWithJsonEditor();

  ed.presetJsonText.value = JSON.stringify(VALID_PRESET);
  assert.equal(ed.validatePresetJsonInput(), true);
  assert.match(ed.presetJsonStatus.textContent, /Valid JSON/);
  assert.match(ed.presetJsonStatus.className, /success/);
  assert.ok(!ed.presetJsonText.classList.contains('invalid'));

  ed.presetJsonText.value = '{ nope }';
  assert.equal(ed.validatePresetJsonInput(), false);
  assert.match(ed.presetJsonStatus.className, /error/);
  assert.ok(ed.presetJsonText.classList.contains('invalid'));
});

test('formatPresetJson re-indents and keeps the parsed content', () => {
  const ed = editorWithJsonEditor();
  ed.presetJsonText.value = '{"version":"1.0","presetName":"X","modules":{}}';

  ed.formatPresetJson();

  const parsed = JSON.parse(ed.presetJsonText.value);
  assert.equal(parsed.presetName, 'X');
  assert.match(ed.presetJsonText.value, /\n  "version": "1.0"/);
  assert.match(ed.presetJsonStatus.className, /success/);
  assert.equal(ed._presetJsonDirty, true);
});

test('applyPresetJsonFromEditor applies the converted preset and marks it modified', async () => {
  const ed = editorWithJsonEditor();
  ed.presetJsonText.value = JSON.stringify(VALID_PRESET);
  let applied = null;
  ed.convertHumanReadableToFullPresetData = () => ({ converted: true });
  ed.applyPresetState = (data) => { applied = data; };
  ed.updatePresetModifiedUI = () => {};
  ed.showToast = () => {};

  const result = await ed.applyPresetJsonFromEditor();

  assert.equal(result, true);
  assert.deepEqual(applied, { converted: true });
  assert.equal(ed.isPresetModified, true);
  assert.equal(ed._presetJsonDirty, false);
});

test('applyPresetJsonFromEditor does not touch the editor when the JSON is invalid', async () => {
  const ed = editorWithJsonEditor();
  ed.presetJsonText.value = '{ broken }';
  let applied = false;
  ed.applyPresetState = () => { applied = true; };
  ed.showToast = () => {};

  const result = await ed.applyPresetJsonFromEditor();

  assert.equal(result, false);
  assert.equal(applied, false);
  assert.ok(ed.presetJsonText.classList.contains('invalid'));
});

test('apply & send applies to the editor but warns when disconnected', async () => {
  const ed = editorWithJsonEditor();
  ed.presetJsonText.value = JSON.stringify(VALID_PRESET);
  ed.convertHumanReadableToFullPresetData = () => ({ converted: true });
  ed.applyPresetState = () => {};
  ed.updatePresetModifiedUI = () => {};
  ed.showToast = () => {};
  ed.isConnected = false;
  let synced = false;
  ed.syncPresetStateToDevice = async () => { synced = true; };

  const result = await ed.applyPresetJsonFromEditor({ sendToDevice: true });

  assert.equal(result, true);
  assert.equal(synced, false);
  assert.match(ed.presetJsonStatus.className, /warning/);
});
