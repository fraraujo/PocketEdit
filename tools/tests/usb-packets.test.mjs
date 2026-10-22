import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { makeEditor } = loadApp();

// A USB SysEx message as delivered to handleMidiMessage: no 8080 header.
//   [0]=F0  [1..2]=CRC  [3..4]=total packets  [5..6]=current packet
//   [7..8]=payload length  [9..]=payload  [last]=F7
function makePacket({ total, current, payload = [0x01, 0x02, 0x04] }) {
  const n = (v) => [(v >> 4) & 0x0f, v & 0x0f]; // nibble-expanded, as the device sends
  return new Uint8Array([
    0xf0, 0x00, 0x00,
    ...n(total), ...n(current),
    ...n(payload.length),
    ...payload,
    0xf7,
  ]);
}

function feed(editor, bytes) {
  editor.handleMidiMessage({ data: bytes });
}

test('single packet is processed immediately', () => {
  const ed = makeEditor();
  ed.connectionType = 'usb';
  const seen = [];
  ed.handleNotification = (ev) => seen.push(Buffer.from(ev.target.value.buffer).toString('hex'));

  feed(ed, makePacket({ total: 1, current: 0 }));
  assert.equal(seen.length, 1, 'forwarded once');
  assert.ok(seen[0].startsWith('8080f0'), '8080 header is restored');
});

test('multi-packet responses are reassembled (16 packets, nibble-expanded counters)', () => {
  const ed = makeEditor();
  ed.connectionType = 'usb';
  const seen = [];
  ed.handleNotification = (ev) => seen.push(Buffer.from(ev.target.value.buffer).toString('hex'));

  const TOTAL = 16; // > 15, so the high nibble is non-zero: the <<8 bug failed here
  for (let i = 0; i < TOTAL; i++) {
    feed(ed, makePacket({ total: TOTAL, current: i, payload: [i, i, i] }));
    if (i < TOTAL - 1) assert.equal(seen.length, 0, `no partial assembly after packet ${i}`);
  }
  assert.equal(seen.length, 1, 'assembled exactly once');
  const hex = seen[0];
  // 16 packets x 3 payload bytes, plus 8080 + F0 + 6 header bytes + F7 = 60 bytes
  assert.equal(hex.length, 120, 'all payload bytes reassembled');
  assert.ok(hex.startsWith('8080f0'), '8080 header restored');
  assert.ok(hex.endsWith('f7'), 'SysEx end kept');
  assert.ok(hex.includes('010101'), 'payload of packet 1 kept');
  assert.ok(hex.includes('0f0f0f'), 'payload of the last packet kept');
  assert.equal(Object.keys(ed.usbMultiPacketResponses).length, 0, 'buffer cleaned up');
});

test('out-of-order packets still assemble', () => {
  const ed = makeEditor();
  ed.connectionType = 'usb';
  let delivered = 0;
  ed.handleNotification = () => { delivered++; };

  const TOTAL = 3;
  for (const i of [2, 0, 1]) feed(ed, makePacket({ total: TOTAL, current: i }));
  assert.equal(delivered, 1);
});

test('incomplete multi-packet response does not deliver', () => {
  const ed = makeEditor();
  ed.connectionType = 'usb';
  let delivered = 0;
  ed.handleNotification = () => { delivered++; };
  feed(ed, makePacket({ total: 4, current: 0 }));
  feed(ed, makePacket({ total: 4, current: 2 }));
  assert.equal(delivered, 0);
});
