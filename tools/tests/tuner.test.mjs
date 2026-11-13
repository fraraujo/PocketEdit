import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load-app.mjs';

const { tuner } = loadApp();
const { PitchDetector, TunerMath, TunerState } = tuner;

const SR = 44100;
const N = 4096;

function sine(freq, { amp = 0.3, sampleRate = SR, length = N, phase = 0 } = {}) {
  const buffer = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buffer[i] = amp * Math.sin(2 * Math.PI * freq * (i / sampleRate) + phase);
  }
  return buffer;
}

function centsBetween(a, b) {
  return 1200 * Math.log2(a / b);
}

const NOTES = [41.2, 55, 61.74, 82.41, 110, 146.83, 196, 246.94, 329.63, 440, 659.25, 880];

test('detects guitar/bass notes within 1 cent at 44.1 and 48 kHz', () => {
  for (const sampleRate of [44100, 48000]) {
    const detector = new PitchDetector({ sampleRate });
    for (const freq of NOTES) {
      const result = detector.detect(sine(freq, { sampleRate }));
      assert.equal(result.state, 'ok', `${freq} Hz state`);
      assert.ok(Math.abs(centsBetween(result.frequency, freq)) <= 1, `${freq} Hz error`);
      assert.ok(result.confidence > 0.8, `${freq} Hz confidence`);
    }
  }
});

test('amplitude does not change the reading', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  for (const amp of [0.05, 0.5]) {
    const result = detector.detect(sine(110, { amp }));
    assert.ok(Math.abs(centsBetween(result.frequency, 110)) <= 1, `amp ${amp}`);
  }
});

test('a quiet signal is reported as weak', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  const result = detector.detect(sine(110, { amp: 0.012 })); // ~ -41 dBFS
  assert.equal(result.state, 'weak');
  assert.ok(result.frequency, 'still detects the pitch');
});

test('noise at 20 dB SNR stays within 3 cents', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  const signal = sine(146.83, { amp: 0.3 });
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const noiseAmp = 0.3 / Math.pow(10, 20 / 20);
  for (let i = 0; i < signal.length; i++) signal[i] += noiseAmp * random();
  const result = detector.detect(signal);
  assert.equal(result.state, 'ok');
  assert.ok(Math.abs(centsBetween(result.frequency, 146.83)) <= 3, 'accuracy with noise');
  assert.ok(result.confidence > 0.5, 'confidence above the unstable threshold');
});

test('harmonics do not produce an octave error', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  const buffer = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    buffer[i] = 0.2 * Math.sin(2 * Math.PI * 110 * t)
      + 0.1 * Math.sin(2 * Math.PI * 220 * t)
      + 0.05 * Math.sin(2 * Math.PI * 330 * t);
  }
  const result = detector.detect(buffer);
  assert.ok(Math.abs(centsBetween(result.frequency, 110)) <= 2, `got ${result.frequency}`);
});

test('clipping is flagged and the note is still detected', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  const buffer = sine(110, { amp: 1.4 }); // hard clip at +-1
  for (let i = 0; i < buffer.length; i++) buffer[i] = Math.max(-1, Math.min(1, buffer[i]));
  const result = detector.detect(buffer);
  assert.equal(result.clipping, true);
  assert.equal(result.state, 'clipping');
  assert.ok(Math.abs(centsBetween(result.frequency, 110)) <= 3, `got ${result.frequency}`);
});

test('a DC offset does not shift the reading', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  const buffer = sine(196, { amp: 0.25 });
  for (let i = 0; i < buffer.length; i++) buffer[i] += 0.2;
  const result = detector.detect(buffer);
  assert.ok(Math.abs(centsBetween(result.frequency, 196)) <= 1);
});

test('silence and out-of-range signals are rejected', () => {
  const detector = new PitchDetector({ sampleRate: SR });
  assert.equal(detector.detect(new Float32Array(N)).state, 'silent');
  assert.equal(detector.detect(sine(20)).state, 'unstable');
  assert.equal(detector.detect(sine(2000)).state, 'unstable');
});

test('note math: equal temperament, A4 reference and cents', () => {
  let info = TunerMath.frequencyToNote(440, 440);
  assert.deepEqual([info.note, Math.round(info.cents)], ['A4', 0]);

  info = TunerMath.frequencyToNote(466.1638, 440);
  assert.equal(info.note, 'A#4');
  assert.ok(Math.abs(info.cents) < 0.1);

  info = TunerMath.frequencyToNote(432, 440);
  assert.ok(Math.abs(info.cents - -31.77) < 0.05, `got ${info.cents}`);

  info = TunerMath.frequencyToNote(432, 432);
  assert.equal(info.cents, 0);

  // Boundary B3 (246.94) / C4 (261.63)
  assert.equal(TunerMath.frequencyToNote(246.94).note, 'B3');
  assert.equal(TunerMath.frequencyToNote(261.63).note, 'C4');

  for (const a4 of [430, 432, 440, 442, 450]) {
    assert.equal(TunerMath.frequencyToNote(a4, a4).cents, 0, `A4 ${a4}`);
  }
});

test('A4 validation accepts 430-450 in 0.5 steps only', () => {
  assert.equal(TunerMath.clampA4(430), 430);
  assert.equal(TunerMath.clampA4(440.25), 440.5);
  assert.equal(TunerMath.clampA4(429.9), null);
  assert.equal(TunerMath.clampA4(450.1), null);
  assert.equal(TunerMath.clampA4('abc'), null);
});

test('state machine: silent, weak, ok and in-tune', () => {
  const state = new TunerState({ a4: 440 });
  const detector = new PitchDetector({ sampleRate: SR });

  // in-tune A4
  let model;
  for (let i = 0; i < 6; i++) model = state.update(detector.detect(sine(440)), i * 50);
  assert.equal(model.state, 'in-tune');
  assert.equal(model.note, 'A4');

  // silence clears the note after the hold window
  for (let i = 0; i < 20; i++) model = state.update({ ...detector.detect(new Float32Array(N)), dbfs: -90 }, 400 + i * 50);
  assert.equal(model.state, 'silent');
  assert.equal(model.note, null);

  // weak signal
  model = state.update(detector.detect(sine(110, { amp: 0.012 })), 2000);
  assert.ok(['weak', 'in-tune', 'ok'].includes(model.state));
  if (model.state === 'weak') assert.ok(model.frequency);
});

test('note hysteresis avoids flicker between two neighbours', () => {
  const state = new TunerState({ a4: 440 });
  const detector = new PitchDetector({ sampleRate: SR });
  let now = 0;
  let model;
  // Settle on A4
  for (let i = 0; i < 6; i++) model = state.update(detector.detect(sine(440)), (now += 50));
  assert.equal(model.note, 'A4');
  // A single reading near A#4 must not switch the displayed note
  model = state.update(detector.detect(sine(466.16)), (now += 50));
  assert.equal(model.note, 'A4', 'single outlier ignored');
  // The median window has to move first, then two consecutive readings are needed.
  for (let i = 0; i < 6; i++) model = state.update(detector.detect(sine(466.16)), (now += 50));
  assert.equal(model.note, 'A#4', 'switches once the reading is consistently A#4');
});

test('needle is clamped to +-50 cents and smoothed', () => {
  const state = new TunerState({ a4: 440 });
  const detector = new PitchDetector({ sampleRate: SR });
  let model;
  for (let i = 0; i < 8; i++) model = state.update(detector.detect(sine(452)), i * 50);
  assert.ok(Math.abs(model.needleCents) <= 50);
  assert.ok(model.cents > 40, 'raw cents are not clamped');
});
