import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor, sandbox } = loadApp();
const KEY = 'pocketedit.presetBackups.v1';

function editorWithBackups() {
  sandbox.localStorage.clear();
  const ed = makeEditor();
  ed.logs = [];
  ed.log = (m, t = 'info') => ed.logs.push({ m, t });
  ed.downloaded = [];
  ed.downloadJson = (json, file) => ed.downloaded.push({ json, file });
  ed.fullPresetDataToExportJson = (entry) => ({ presetName: entry.name, marker: entry.data.marker });
  return ed;
}

const entry = (baseName, name, marker) => ({ baseName, name, data: { marker } });

test('backups are stored silently (no download) and counted', () => {
  const ed = editorWithBackups();
  const added = ed.saveBackupsLocally([entry('P02', 'Two', 1), entry('P03', 'Three', 2)], 'swap');
  assert.equal(added.length, 2);
  assert.equal(ed.getBackupCount(), 2);
  assert.equal(ed.downloaded.length, 0, 'nothing was downloaded');
  const stored = ed.readBackupStore();
  assert.equal(stored[0].json.presetName, 'Two', 'newest first');
  assert.equal(stored[0].reason, 'swap');
});

test('store is capped and drops the oldest entries', () => {
  const ed = editorWithBackups();
  for (let i = 0; i < 50; i++) ed.saveBackupsLocally([entry('P01', `N${i}`, i)], 'swap');
  assert.equal(ed.getBackupCount(), 40, 'capped at MAX_BACKUPS');
  const names = ed.readBackupStore().map((b) => b.json.presetName);
  assert.equal(names[0], 'N49', 'newest first');
  assert.ok(!names.includes('N0'), 'oldest entries were dropped');
});

test('downloadBackup writes the stored JSON on demand', () => {
  const ed = editorWithBackups();
  const [saved] = ed.saveBackupsLocally([entry('P05', 'Five', 5)], 'swap');
  ed.downloadBackup(saved.id);
  assert.equal(ed.downloaded.length, 1);
  assert.match(ed.downloaded[0].file, /^backup_P05_/);
  assert.equal(ed.downloaded[0].json.presetName, 'Five');
});

test('deleteBackup and clearBackups empty the store', () => {
  const ed = editorWithBackups();
  const [a, b] = ed.saveBackupsLocally([entry('P01', 'A', 1), entry('P02', 'B', 2)], 'swap');
  ed.deleteBackup(a.id);
  assert.equal(ed.getBackupCount(), 1);
  sandbox.confirm = () => true;
  ed.clearBackups();
  assert.equal(ed.getBackupCount(), 0);
});

test('storage failure falls back to downloading the backups', () => {
  const ed = editorWithBackups();
  const original = sandbox.localStorage.setItem;
  sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    const added = ed.saveBackupsLocally([entry('P09', 'Nine', 9)], 'swap');
    assert.equal(added, null, 'reports failure');
    assert.equal(ed.downloaded.length, 1, 'backup written to a file instead');
  } finally {
    sandbox.localStorage.setItem = original;
  }
});

test('swap stores backups instead of downloading two files', async () => {
  const ed = editorWithBackups();
  ed.isConnected = true;
  ed.userPatchesData = [
    { baseName: 'P01', decodedName: 'One' },
    { baseName: 'P02', decodedName: 'Two' },
  ];
  ed.readPresetState = async (i) => ({ index: i, baseName: `P0${i + 1}`, name: ed.userPatchesData[i].decodedName, data: { marker: i } });
  ed.writePresetState = async () => {};
  ed.syncPresetNames = async () => {};
  ed.renderPatchList = () => {};
  ed.showToast = () => {};
  ed.lockingOverlay = { style: {} };
  sandbox.confirm = () => true;

  await ed.swapUserPresets(0, 1);
  assert.equal(ed.getBackupCount(), 2);
  assert.equal(ed.downloaded.length, 0, 'no automatic downloads');
});
