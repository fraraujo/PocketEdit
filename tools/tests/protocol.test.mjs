import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { EditorClass, makeEditor, modules, commands } = loadApp();

test('data files are structurally sound', () => {
  assert.ok(modules.effectLibrary['1'].name === 'Gate');
  assert.ok(modules.modules.find((m) => m.moduleId === 7).tapTempo === true, 'DLY declares tapTempo');
  for (const mod of modules.modules) {
    for (const fxId of mod.effects) assert.ok(modules.effectLibrary[fxId], `${mod.name} -> ${fxId}`);
  }
  for (const key of ['effectTypes', 'parameters', 'chainOrderCommands', 'moduleStates', 'ampModes', 'globalCommands', 'presetCommands']) {
    assert.ok(commands[key], `commands.${key}`);
  }
  assert.match(commands._comment, /0ff7/, 'FIXME knowledge kept in the data');
  for (const value of Object.values(commands.moduleStates).flatMap((m) => Object.values(m))) {
    assert.match(value, /^8080f0[0-9a-f]+f7$/i);
  }
});

test('CRC-8/SMBus known vectors', () => {
  const ed = makeEditor();
  assert.equal(ed.calculateSMBusPEC('00'), '00');
  assert.equal(ed.calculateSMBusPEC('01'), '07');
  assert.match(ed.calculateSMBusPEC('0102030405'), /^[0-9A-F]{2}$/);
});

test('dB encode/decode round-trip', () => {
  const ed = makeEditor();
  for (let v = -20; v <= 30; v++) {
    const hex = ed.encodeDbValue(String(v));
    assert.equal(ed.decodeDbValue(hex.slice(0, 2), hex.slice(2, 4)), v, `dB ${v}`);
  }
});

test('name encode/decode round-trip', () => {
  const ed = makeEditor();
  for (const name of ['Clean', 'A B', 'Zz09_-', 'abcdefghij']) {
    assert.equal(ed.encodeNameForSave(name).length, 40);
    assert.equal(ed.decodeName(ed.encodeNameForSave(name)), name);
  }
  assert.equal(ed.decodeName(ed.encodeNameForSave('abcdefghijkl')), 'abcdefghij', 'truncated to 10');
});

test('name block validation', () => {
  const ed = makeEditor();
  assert.equal(ed.isValidNameBlock('0401040204030404040504060407040804090000'), true);
  assert.equal(ed.isValidNameBlock('0000000000000000000000000000000000000000'), false);
});

test('preset save payload keeps its exact wire format', async () => {
  const ed = makeEditor();
  const sent = [];
  ed.isConnected = true;
  ed.connectionType = 'ble';
  ed.characteristic = { writeValueWithoutResponse: async (bytes) => sent.push(Buffer.from(bytes).toString('hex')) };
  ed.hideSaveModal = () => {};
  ed.lockingOverlay = { style: {}, querySelector: () => null };
  ed.presetNameInput = { value: 'MY TONE' };
  ed.presetNumberInput = { value: '42' };
  ed.updateUIAfterSave = () => {};
  ed.updatePresetModifiedUI = () => {};
  ed.waitForAck = async () => true;
  await ed.saveCurrentPreset();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], '8080f004010001000001030101040a0209000000000000040d050902000504040f040e0405000000000000000000000000f7');
});

test('waitForAck only accepts the expected packet', async () => {
  const ed = makeEditor();
  const pending = ed.waitForAck(EditorClass.SUCCESS_ACK_CODE, 1000);
  assert.equal(ed._dispatchAck('8080F0070A000100000003010204050001F7'), false, 'unrelated packets are not ACKs');
  assert.equal(ed._ackWaiters.length, 1);
  ed._dispatchAck(EditorClass.SUCCESS_ACK_CODE);
  assert.equal(await pending, true);
});

test('writeCommand serializes writes and honours isApplyingState', async () => {
  const ed = makeEditor();
  ed.isConnected = true;
  ed.connectionType = 'ble';
  const order = [];
  let active = 0;
  let maxActive = 0;
  ed.characteristic = {
    writeValueWithoutResponse: async (bytes) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(bytes[3]);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    },
  };
  await Promise.all([ed.writeCommand('8080F001F7'), ed.writeCommand('8080F002F7'), ed.writeCommand('8080F003F7')]);
  assert.equal(maxActive, 1, 'writes never overlap');
  assert.deepEqual(order, [1, 2, 3], 'writes keep order');

  const suppressed = ed.writeCommand('8080F004F7');
  ed.isApplyingState = true;
  await suppressed;
  ed.isApplyingState = false;
  assert.ok(!order.includes(4), 'suppressed command is dropped');
});

test('tap tempo is data-driven', () => {
  const ed = makeEditor();
  assert.equal(ed.supportsTapTempo(7), true);
  for (const id of [0, 1, 2, 3, 4, 5, 6, 8, 9]) assert.equal(ed.supportsTapTempo(id), false, `module ${id}`);
});
