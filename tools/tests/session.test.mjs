import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor } = loadApp();

function primedEditor() {
  const ed = makeEditor();
  ed.nameSyncTimeoutId = setTimeout(() => {}, 10000);
  ed.syncTimeoutId = setTimeout(() => {}, 10000);
  ed.isSyncing = true;
  ed.isWaitingForPresetDump = true;
  ed.isWaitingForPresetNumber = true;
  ed.isWaitingForGlobals = true;
  ed.isSyncingState = true;
  ed.isInitialSyncing = true;
  ed._updatePatchInfoBusy = true;
  ed.usbMidiBuffer = new Uint8Array([0xf0]);
  ed.usbMultiPacketResponses = { '0_2': { packets: {} } };
  let releasedGlobals = false;
  ed.globalSettingsPromiseResolve = () => { releasedGlobals = true; };
  ed.patchListContainer = { classList: { _s: new Set(['locked']), remove(c) { this._s.delete(c); }, add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } } };
  ed.lockingOverlay = { style: {}, querySelector: () => null };
  return { ed, releasedGlobals: () => releasedGlobals };
}

test('resetSessionState clears flags, timers, buffers and pending waits', () => {
  const { ed, releasedGlobals } = primedEditor();
  const acks = [];
  ed.waitForAck('8080F00B02000100000003010400080000F7', 10000).then((v) => acks.push(v));

  ed.resetSessionState('disconnect');

  assert.equal(ed.isSyncing, false);
  assert.equal(ed.isWaitingForPresetDump, false);
  assert.equal(ed.isWaitingForPresetNumber, false);
  assert.equal(ed.isWaitingForGlobals, false);
  assert.equal(ed.isSyncingState, false);
  assert.equal(ed.isInitialSyncing, false);
  assert.equal(ed._updatePatchInfoBusy, false);
  assert.equal(ed.usbMidiBuffer, null);
  assert.equal(Object.keys(ed.usbMultiPacketResponses).length, 0, 'usb buffers cleared');
  assert.equal(ed.nameSyncTimeoutId, null);
  assert.equal(ed.syncTimeoutId, null);
  assert.equal(releasedGlobals(), true, 'global settings waiter released');
  assert.equal(ed._ackWaiters.length, 0, 'ACK waiters released');
  assert.equal(ed.patchListContainer.classList.contains('locked'), false, 'patch list unlocked');
  return new Promise((resolve) => setTimeout(() => {
    assert.deepEqual(acks, [false], 'pending ACK resolves false');
    resolve();
  }, 10));
});

test('resetSessionState is re-entrancy safe and idempotent', () => {
  const { ed } = primedEditor();
  ed.resetSessionState('a');
  ed.resetSessionState('b');
  assert.equal(ed.sessionResetInProgress, false);
});

test('finishInitialSync hides the overlay and is idempotent', () => {
  const ed = makeEditor();
  ed.patchListContainer = { classList: { remove() {}, add() {}, contains() { return false; } } };
  let display = 'flex';
  const title = { textContent: 'Performing Initial Sync...' };
  ed.lockingOverlay = {
    get style() { return { set display(v) { display = v; }, get display() { return display; } }; },
    querySelector: (sel) => (sel.includes('first') ? title : { textContent: '' }),
  };
  ed.isInitialSyncing = true;
  ed.finishInitialSync();
  assert.equal(display, 'none');
  assert.equal(ed.isInitialSyncing, false);
  ed.finishInitialSync(); // must not throw or change anything
  assert.equal(display, 'none');
});
