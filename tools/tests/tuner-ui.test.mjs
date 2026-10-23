import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { tuner: PocketTuner, document, sandbox } = loadApp();
const { TunerController } = PocketTuner;

// ---- fake Web Audio + mediaDevices -----------------------------------------
function makeNode() {
  return { connect() { return this; }, disconnect() {}, gain: { value: 1 }, channelCount: 1, channelCountMode: '', channelInterpretation: '', frequency: { value: 0 }, type: '' };
}

function makeTrack(label, deviceId) {
  const track = {
    label,
    stopped: false,
    stop() { this.stopped = true; },
    getSettings: () => ({ deviceId }),
    onended: null,
  };
  return track;
}

function makeEnv({ devices, permissionError = null } = {}) {
  const created = { contexts: 0, streams: [] };
  const tracks = devices.map((d) => makeTrack(d.label, d.deviceId));

  const ctx = {
    sampleRate: 48000,
    state: 'running',
    destination: makeNode(),
    resume: async () => { ctx.state = 'running'; },
    close: async () => { ctx.state = 'closed'; },
    suspend: async () => { ctx.state = 'suspended'; },
    createMediaStreamSource: () => makeNode(),
    createGain: () => makeNode(),
    createBiquadFilter: () => makeNode(),
    createAnalyser: () => {
      const analyser = makeNode();
      analyser.fftSize = 8192;
      analyser.getFloatTimeDomainData = () => {};
      return analyser;
    },
    audioWorklet: { addModule: async () => {} },
  };

  const env = {
    localStorage: {
      _s: new Map(),
      getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
      setItem(k, v) { this._s.set(k, String(v)); },
    },
    performance: { now: () => 0 },
    document: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      createElement: (tag) => document.createElement(tag),
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearInterval,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: class { constructor(parts) { this.parts = parts; } },
    AudioWorkletNode: class {
      constructor() { this.port = { onmessage: null }; }
      connect() { return this; }
      disconnect() {}
    },
    AudioContext: function AudioContext() {
      created.contexts++;
      return ctx;
    },
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          if (permissionError) throw permissionError;
          created.lastConstraints = constraints;
          const stream = {
            getTracks: () => tracks,
            getAudioTracks: () => tracks,
          };
          created.streams.push(stream);
          return stream;
        },
        async enumerateDevices() {
          return devices.map((d) => ({ kind: 'audioinput', deviceId: d.deviceId, label: d.label }));
        },
      },
    },
  };
  return { env, created, tracks, ctx };
}

const DEVICES = [
  { deviceId: 'mic-1', label: 'Built-in Audio' },
  { deviceId: 'pm-1', label: 'Pocket Master' },
];

function makeElements() {
  const el = (id) => {
    const node = document.getElementById(id);
    node.id = id;
    return node;
  };
  return {
    panel: el('tunerPanel'),
    backdrop: el('tunerBackdrop'),
    closeButton: el('tunerCloseBtn'),
    note: el('tunerNote'),
    frequency: el('tunerFrequency'),
    needle: el('tunerNeedle'),
    cents: el('tunerCents'),
    verdict: el('tunerVerdict'),
    announcer: el('tunerAnnouncer'),
    level: el('tunerLevel'),
    levelBar: el('tunerLevelBar'),
    confidence: el('tunerConfidence'),
    confidenceText: el('tunerConfidenceText'),
    inputSelect: el('tunerInputSelect'),
    a4Input: el('tunerA4'),
    prevNote: el('tunerPrevNote'),
    nextNote: el('tunerNextNote'),
    ticks: el('tunerTicks'),
    status: el('tunerStatus'),
  };
}

function makeController(options = {}) {
  const { env, created, tracks, ctx } = makeEnv(options);
  const elements = makeElements();
  elements.inputSelect.options = [];
  elements.inputSelect.appendChild = function (child) { this.options.push(child); this.children?.push?.(child); return child; };
  elements.inputSelect.textContent = '';
  const controller = new TunerController({ env, elements, ...options.controllerOptions });
  return { controller, created, tracks, ctx, elements, env };
}

async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

// ---- tests -----------------------------------------------------------------
test('opening requests audio and prefers the Pocket Master input', async () => {
  const { controller, created, elements } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  assert.equal(created.streams.length, 1, 'getUserMedia called once');
  assert.equal(created.lastConstraints.audio.echoCancellation, false);
  assert.equal(created.lastConstraints.audio.noiseSuppression, false);
  assert.equal(created.lastConstraints.audio.autoGainControl, false);
  const labels = elements.inputSelect.options.map((o) => o.textContent);
  assert.ok(labels.includes('Pocket Master'), labels.join(','));
  assert.equal(elements.panel.hidden, false, 'panel visible');
  assert.equal(elements.backdrop.hidden, false);
  await controller.close();
});

test('closing stops every track and closes the context', async () => {
  const { controller, tracks, ctx } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  await controller.close();
  assert.ok(tracks.every((t) => t.stopped), 'all tracks stopped');
  assert.equal(ctx.state, 'closed', 'context closed');
  assert.equal(controller.stream, null);
  assert.equal(controller.audioContext, null);
});

test('selecting another input restarts capture with that deviceId', async () => {
  const { controller, created } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  await controller.selectInput('mic-1');
  await drain();
  assert.equal(created.streams.length, 2, 'stream re-acquired');
  assert.equal(created.lastConstraints.audio.deviceId.exact, 'mic-1');
  assert.equal(controller.env.localStorage.getItem('pocketedit.tuner.inputLabel'), 'Built-in Audio');
  await controller.close();
});

test('permission denied shows an error and leaves no running loop', async () => {
  const error = new Error('denied');
  error.name = 'NotAllowedError';
  const { controller, elements } = makeController({ devices: DEVICES, permissionError: error });
  await controller.open();
  await drain();
  assert.equal(controller.stream, null);
  assert.equal(controller.audioContext, null);
  assert.match(elements.status.textContent, /permission/i);
  assert.ok(elements.panel.dataset.state === 'error' || elements.verdict.dataset.state === 'error');
});

test('a disappeared input is reported as disconnected', async () => {
  const { controller, tracks } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  const states = [];
  controller.onState = (model) => states.push(model.state);
  tracks[0].onended?.(); // the device went away
  assert.ok(states.includes('disconnected'), states.join(','));
  assert.match(controller.elements.status.textContent, /disconnected/i);
});

test('A4 is validated, persisted and reflected in the input', async () => {
  const { controller, elements, env } = makeController({ devices: DEVICES });
  assert.equal(controller.state.a4, 440);
  assert.equal(controller.setA4(442), true);
  assert.equal(controller.state.a4, 442);
  assert.equal(env.localStorage.getItem('pocketedit.tuner.a4'), '442');
  assert.equal(elements.a4Input.value, '442.0');

  assert.equal(controller.setA4(500), false, 'out of range rejected');
  assert.equal(controller.state.a4, 442, 'previous value kept');
  assert.match(elements.status.textContent, /430 and 450/);
});

test('missing mediaDevices reports the secure-context hint', async () => {
  const elements = makeElements();
  const controller = new TunerController({ env: { navigator: {}, localStorage: { getItem: () => null } }, elements });
  await controller.open();
  await drain();
  assert.match(elements.status.textContent, /not available/i);
});

test('controller renders a detection into the panel', async () => {
  const { controller, elements } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  const SR = controller.detector.sampleRate;
  const buffer = new Float32Array(4096);
  for (let i = 0; i < buffer.length; i++) buffer[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR);
  for (let i = 0; i < 8; i++) controller._handleSamples(buffer);
  assert.equal(elements.note.textContent, 'A4');
  assert.match(elements.frequency.textContent, /^44[01]\.\d Hz$/);
  assert.equal(elements.verdict.dataset.state, 'in-tune');
  await controller.close();
});

test('silence clears the reading', async () => {
  const { controller, elements } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  for (let i = 0; i < 4; i++) controller._handleSamples(new Float32Array(4096));
  assert.equal(elements.note.textContent, '--');
  assert.equal(elements.verdict.dataset.state, 'silent');
  await controller.close();
});


test('the device already connected over USB MIDI is preferred over the system default', async () => {
  const devices = [
    { deviceId: 'default', label: 'Default Audio' },
    { deviceId: 'builtin', label: 'Built-in Audio Analog Stereo' },
    { deviceId: 'pm', label: 'Pocket Master USB Audio' },
  ];
  const { controller, env } = makeController({ devices });
  controller._devices = devices; // as set by _refreshDevices() after permission
  env.localStorage.setItem('pocketedit.tuner.inputLabel', 'Built-in Audio Analog Stereo');
  controller.setPreferredDeviceName('Pocket Master MIDI 1');
  const picked = controller._pickDevice(null, 'Built-in Audio Analog Stereo');
  assert.equal(picked.deviceId, 'pm', 'connected device wins over the stored choice');
});

test('connected device matching is tolerant to suffixes and separators', async () => {
  const devices = [
    { deviceId: 'builtin', label: 'Built-in Audio' },
    { deviceId: 'pm', label: 'Sonicake Pocket-Master' },
  ];
  const { controller } = makeController({ devices });
  controller._devices = devices;
  controller.setPreferredDeviceName('Pocket Master');
  assert.equal(controller._pickDevice(null, null).deviceId, 'pm');
  controller.setPreferredDeviceName('Sonicake Pocket Master MIDI 1');
  assert.equal(controller._pickDevice(null, null).deviceId, 'pm');
});

test('needle follows the cents value on the arc', async () => {
  const { controller, elements } = makeController({ devices: DEVICES });
  await controller.open();
  await drain();
  const SR = controller.detector.sampleRate;
  const buffer = new Float32Array(4096);
  for (let i = 0; i < buffer.length; i++) buffer[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR);
  for (let i = 0; i < 8; i++) controller._handleSamples(buffer);
  const transform = elements.needle.getAttribute('transform');
  assert.match(transform, /^rotate\(-?\d+(\.\d+)? 140 140\)$/, transform);
  const degrees = Number(transform.match(/rotate\((-?[\d.]+)/)[1]);
  assert.ok(Math.abs(degrees) < 12, `in-tune needle stays near centre, got ${degrees}`);

  // Neighbour notes at both ends of the scale (A4 -> G#4 / A#4)
  assert.equal(elements.prevNote.textContent, '♭ G#4');
  assert.equal(elements.nextNote.textContent, 'A#4 ♯');
  await controller.close();
});
