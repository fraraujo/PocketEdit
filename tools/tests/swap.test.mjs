import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor, sandbox } = loadApp();

function swapEditor() {
  const ed = makeEditor();
  ed.isConnected = true;
  ed.userPatchesData = [
    { baseName: 'P01', decodedName: 'One' },
    { baseName: 'P02', decodedName: 'Two' },
    { baseName: 'P03', decodedName: 'Three' },
  ];
  ed.commands = { presetCommands: { user: { P01: 'c1', P02: 'c2', P03: 'c3' } } };
  ed.calls = [];
  ed.toasts = [];
  ed.showToast = (m, t) => ed.toasts.push({ m, t });
  ed.readPresetState = async (i) => {
    ed.calls.push(['read', i]);
    return { index: i, baseName: `P0${i + 1}`, name: ed.userPatchesData[i].decodedName, data: { marker: i } };
  };
  ed.writePresetState = async (i, name, data) => { ed.calls.push(['write', i, name, data.marker]); };
  sandbox.localStorage.clear();
  ed.downloadJson = (json, file) => ed.calls.push(['download', json.presetName, file]);
  ed.renderPatchList = () => {};
  ed.syncPresetNames = async () => ed.calls.push(['resync']);
  ed.lockingOverlay = { style: {} };
  ed.fullPresetDataToExportJson = (entry) => ({ presetName: entry.name });
  return ed;
}

test('swap reads both slots, backs them up and writes them crossed', async () => {
  const ed = swapEditor();
  sandbox.confirm = () => true;
  const ok = await ed.swapUserPresets(1, 2); // P02 <-> P03
  assert.equal(ok, true);
  assert.deepEqual(ed.calls.map((c) => c[0]), ['read', 'read', 'write', 'write', 'resync']);
  assert.equal(ed.getBackupCount(), 2, 'both presets stored as local backups');
  assert.equal(ed.downloaded === undefined || ed.downloaded.length === 0, true, 'no automatic downloads');
  // P02's content (marker 1, "Two") goes into slot 2 (P03); P03's content into slot 1 (P02)
  assert.deepEqual(ed.calls[2], ['write', 2, 'Two', 1]);
  assert.deepEqual(ed.calls[3], ['write', 1, 'Three', 2]);
  // local list reflects the swap
  assert.equal(ed.userPatchesData[1].decodedName, 'Three');
  assert.equal(ed.userPatchesData[2].decodedName, 'Two');
});

test('swap is aborted when the user declines the confirmation', async () => {
  const ed = swapEditor();
  sandbox.confirm = () => false;
  const ok = await ed.swapUserPresets(0, 1);
  assert.equal(ok, false);
  assert.deepEqual(ed.calls, [], 'nothing was read or written');
});

test('a failed write stops the swap and reports it', async () => {
  const ed = swapEditor();
  sandbox.confirm = () => true;
  ed.writePresetState = async (i) => {
    ed.calls.push(['write', i]);
    if (i === 2) throw new Error('device did not acknowledge');
  };
  const ok = await ed.swapUserPresets(1, 2);
  assert.equal(ok, false);
  const writes = ed.calls.filter((c) => c[0] === 'write');
  assert.equal(writes.length, 1, 'second write is not attempted');
  assert.ok(ed.toasts.some((t) => t.t === 'error'), 'error toast shown');
  assert.equal(ed.isSwappingPresets, false, 'guard released');
});

test('swap requires a connection and different slots', async () => {
  const ed = swapEditor();
  ed.isConnected = false;
  assert.equal(await ed.swapUserPresets(0, 1), false);
  ed.isConnected = true;
  assert.equal(await ed.swapUserPresets(1, 1), false);
  assert.deepEqual(ed.calls, []);
});

test('beginPresetSwap arms and Esc cancels it', () => {
  const ed = swapEditor();
  ed.beginPresetSwap('P02');
  assert.equal(ed._swapSource, 'P02');
  ed.cancelPresetSwap();
  assert.equal(ed._swapSource, null);
  assert.ok(ed.toasts.some((t) => /cancelled/i.test(t.m)));
});

test('swap without connection warns instead of arming', () => {
  const ed = swapEditor();
  ed.isConnected = false;
  ed.beginPresetSwap('P02');
  assert.equal(ed._swapSource, null);
  assert.ok(ed.toasts.some((t) => t.t === 'warning'));
});
