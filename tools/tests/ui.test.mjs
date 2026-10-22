import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor, document } = loadApp();

function editorWithUi() {
  const ed = makeEditor();
  ed.patchNameEl = document.getElementById('patchName');
  ed.unsavedBadge = document.getElementById('unsavedBadge');
  ed.quickSaveBtn = document.getElementById('quickSaveBtn');
  ed.savePresetBtn = document.getElementById('savePresetBtn');
  ed.syncState = document.getElementById('syncState');
  ed.syncStateText = document.getElementById('syncStateText');
  ed.topStatus = document.getElementById('topStatus');
  ed.topStatusText = document.getElementById('topStatusText');
  return ed;
}

test('unsaved changes are shown as badge, name marker and Save emphasis', () => {
  const ed = editorWithUi();
  ed.patchNameEl.textContent = 'Clean';

  ed.updatePresetModifiedUI(true);
  assert.equal(ed.patchNameEl.textContent, 'Clean*');
  assert.ok(ed.patchNameEl.classList.contains('modified'));
  assert.equal(ed.unsavedBadge.hidden, false, 'badge visible');
  assert.ok(ed.quickSaveBtn.classList.contains('pending'), 'Save button highlighted');
  assert.equal(document.title, 'Pocket Edit *');

  ed.updatePresetModifiedUI(false);
  assert.equal(ed.patchNameEl.textContent, 'Clean', 'asterisk removed');
  assert.ok(!ed.patchNameEl.classList.contains('modified'));
  assert.equal(ed.unsavedBadge.hidden, true, 'badge hidden');
  assert.ok(!ed.quickSaveBtn.classList.contains('pending'));
  assert.equal(document.title, 'Pocket Edit');
});

test('updatePresetModifiedUI is idempotent (no duplicated asterisks)', () => {
  const ed = editorWithUi();
  ed.patchNameEl.textContent = 'Tone';
  ed.updatePresetModifiedUI(true);
  ed.updatePresetModifiedUI(true);
  assert.equal(ed.patchNameEl.textContent, 'Tone*');
});

test('setSyncState drives the sidebar indicator and the top-bar chip', () => {
  const ed = editorWithUi();
  ed.connectionType = 'usb';
  ed.topStatusText.textContent = 'USB connected';

  ed.setSyncState('Syncing preset names...');
  assert.equal(ed.syncState.hidden, false);
  assert.equal(ed.syncStateText.textContent, 'Syncing preset names...');
  assert.ok(ed.topStatus.classList.contains('syncing'));
  assert.equal(ed.topStatusText.textContent, 'Syncing preset names...');

  ed.setSyncState(null);
  assert.equal(ed.syncState.hidden, true);
  assert.ok(!ed.topStatus.classList.contains('syncing'));
  assert.equal(ed.topStatusText.textContent, 'USB connected', 'chip falls back to connection state');
});

test('module power control is separate from selection', () => {
  const ed = makeEditor();
  const tile = document.getElementById('tile-1');
  tile.classList.add('chain-module');
  tile.dataset.moduleId = '1';
  ed.moduleElements = [tile];

  ed.ensureModulePowerControl(tile, 1);
  const pill = tile.children.find((c) => c.classList.contains('module-power'));
  assert.ok(pill, 'power pill created');
  assert.equal(pill.textContent, 'OFF');

  ed.ensureModulePowerControl(tile, 1);
  assert.equal(tile.children.filter((c) => c.classList.contains('module-power')).length, 1, 'not duplicated');

  // updateModuleStatus mirrors the enable toggle into the pill
  const toggle = document.getElementById('module-enable-1');
  toggle.classList.add('on');
  ed.updateModuleStatus(1);
  assert.equal(pill.getAttribute('aria-pressed'), 'true');
  assert.equal(pill.textContent, 'ON');

  toggle.classList.remove('on');
  ed.updateModuleStatus(1);
  assert.equal(pill.getAttribute('aria-pressed'), 'false');
  assert.equal(pill.textContent, 'OFF');
});
