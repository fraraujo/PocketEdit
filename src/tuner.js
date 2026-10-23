// Audio tuner for PocketEdit.
//
// Loaded before src/app.js and injected into the single-file build by
// tools/build.mjs. Everything lives in one IIFE because the build produces a
// single inline script: no imports/exports.
//
// Layers:
//   PitchDetector  - YIN on a Float32Array, no DOM and no Web Audio
//   TunerMath      - frequency <-> note/cents, reference A4
//   TunerState     - smoothing, hysteresis and signal states
//   TunerController- audio capture, lifecycle, device selection and the UI
const PocketTuner = (() => {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // ---------------------------------------------------------------- TunerMath
  const TunerMath = {
    frequencyToMidi(frequency, a4 = 440) {
      return 69 + 12 * Math.log2(frequency / a4);
    },

    midiToFrequency(midi, a4 = 440) {
      return a4 * Math.pow(2, (midi - 69) / 12);
    },

    // Nearest equal-tempered note for a frequency, with the deviation in cents.
    frequencyToNote(frequency, a4 = 440) {
      const midiFloat = TunerMath.frequencyToMidi(frequency, a4);
      const midi = Math.round(midiFloat);
      const target = TunerMath.midiToFrequency(midi, a4);
      const cents = 1200 * Math.log2(frequency / target);
      const name = NOTE_NAMES[((midi % 12) + 12) % 12];
      const octave = Math.floor(midi / 12) - 1;
      return { midi, name, octave, note: `${name}${octave}`, target, cents };
    },

    // Note name for an arbitrary MIDI number (used for the neighbour labels).
    midiToNoteName(midi) {
      const value = Math.round(midi);
      return `${NOTE_NAMES[((value % 12) + 12) % 12]}${Math.floor(value / 12) - 1}`;
    },

    clampA4(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      if (numeric < 430 || numeric > 450) return null;
      return Math.round(numeric * 2) / 2; // 0.5 Hz steps
    },

    dbfs(amplitude) {
      return 20 * Math.log10(Math.max(amplitude, 1e-9));
    },
  };

  // ------------------------------------------------------------ PitchDetector
  // YIN (de Cheveigné & Kawahara) with cumulative mean normalised difference.
  class PitchDetector {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate || 44100;
      this.minFrequency = options.minFrequency ?? 40;
      this.maxFrequency = options.maxFrequency ?? 1500;
      this.threshold = options.threshold ?? 0.12;
      this.fallbackThreshold = options.fallbackThreshold ?? 0.30;
      this.silenceDb = options.silenceDb ?? -50;
      this.weakDb = options.weakDb ?? -38;
      this.clippingLevel = options.clippingLevel ?? 0.98;
    }

    setSampleRate(sampleRate) {
      if (Number.isFinite(sampleRate) && sampleRate > 4000) this.sampleRate = sampleRate;
    }

    // Returns:
    //   { state, frequency, confidence, rms, dbfs, peak, level,
    //     silent, weak, clipping, reason }
    // state is one of: silent | weak | clipping | unstable | ok
    detect(input) {
      const length = input ? input.length : 0;
      if (!length) {
        return this._empty('silent', { reason: 'no-samples' });
      }

      // 1) DC removal + RMS + peak
      let mean = 0;
      for (let i = 0; i < length; i++) mean += input[i];
      mean /= length;

      const samples = new Float32Array(length);
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < length; i++) {
        const value = input[i] - mean;
        samples[i] = value;
        sumSquares += value * value;
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
      }

      const rms = Math.sqrt(sumSquares / length);
      const dbfs = TunerMath.dbfs(rms);
      const silent = dbfs < this.silenceDb;
      const weak = !silent && dbfs < this.weakDb;
      const clipping = peak >= this.clippingLevel;

      if (silent) {
        return this._empty('silent', { rms, dbfs, peak, silent, weak, clipping, reason: 'below-silence' });
      }

      const pitch = this._yin(samples, length);
      if (!pitch) {
        return this._empty(weak ? 'weak' : 'unstable', {
          rms, dbfs, peak, silent, weak, clipping, reason: 'no-periodicity',
        });
      }

      // Clipping pushes the waveform towards a square wave; YIN still works but the
      // reading is less trustworthy, so lower the confidence a bit.
      const confidence = clipping ? pitch.confidence * 0.8 : pitch.confidence;
      let state = 'ok';
      if (weak) state = 'weak';
      else if (clipping) state = 'clipping';

      return {
        state,
        frequency: pitch.frequency,
        confidence,
        rms,
        dbfs,
        peak,
        level: this._levelFromDbfs(dbfs),
        silent,
        weak,
        clipping,
        reason: null,
      };
    }

    _empty(state, extra = {}) {
      return {
        state,
        frequency: null,
        confidence: 0,
        rms: 0,
        dbfs: TunerMath.dbfs(0),
        peak: 0,
        level: 0,
        silent: state === 'silent',
        weak: state === 'weak',
        clipping: false,
        reason: null,
        ...extra,
      };
    }

    _levelFromDbfs(dbfs) {
      // -60 dBFS..0 dBFS -> 0..1
      return Math.max(0, Math.min(1, (dbfs + 60) / 60));
    }

    _yin(samples, length) {
      const sampleRate = this.sampleRate;
      const minLag = Math.max(2, Math.floor(sampleRate / this.maxFrequency));
      const maxLag = Math.min(length - 2, Math.ceil(sampleRate / this.minFrequency));
      if (maxLag <= minLag + 2) return null;

      // Fixed analysis window: enough samples for the largest lag. It is capped so a
      // 4096-sample frame at 48 kHz stays affordable at ~20 detections/second.
      const windowSize = Math.min(length - maxLag, 2048);
      if (windowSize < 64) return null;

      const difference = new Float32Array(maxLag + 2);
      for (let tau = 1; tau <= maxLag; tau++) {
        let sum = 0;
        for (let j = 0; j < windowSize; j++) {
          const delta = samples[j] - samples[j + tau];
          sum += delta * delta;
        }
        difference[tau] = sum;
      }

      // Cumulative mean normalised difference
      const cmnd = new Float32Array(maxLag + 2);
      cmnd[0] = 1;
      let runningSum = 0;
      for (let tau = 1; tau <= maxLag; tau++) {
        runningSum += difference[tau];
        cmnd[tau] = runningSum === 0 ? 1 : (difference[tau] * tau) / runningSum;
      }

      // First local minimum under the strict threshold…
      let candidate = -1;
      for (let tau = minLag; tau < maxLag; tau++) {
        if (cmnd[tau] < this.threshold && cmnd[tau] <= cmnd[tau - 1] && cmnd[tau] <= cmnd[tau + 1]) {
          candidate = tau;
          break;
        }
      }

      // …otherwise the global minimum, accepted only below the fallback threshold.
      if (candidate === -1) {
        let bestLag = -1;
        let bestValue = Infinity;
        for (let tau = minLag; tau < maxLag; tau++) {
          if (cmnd[tau] < bestValue) {
            bestValue = cmnd[tau];
            bestLag = tau;
          }
        }
        if (bestLag === -1 || bestValue >= this.fallbackThreshold) return null;
        candidate = bestLag;
      }

      // Octave correction: YIN can latch onto a sub-harmonic when the true period is
      // shorter than minLag (e.g. a 2 kHz input showing up as 1 kHz). If a fraction of
      // the chosen lag is also periodic, prefer it; the range check below then
      // rejects the signal instead of reporting a wrong note.
      for (const divisor of [2, 3]) {
        const shorter = Math.round(candidate / divisor);
        if (shorter >= 2 && cmnd[shorter] < this.threshold && cmnd[shorter] < cmnd[candidate]) {
          candidate = shorter;
        }
      }

      const refinedLag = this._interpolate(cmnd, candidate);
      if (!Number.isFinite(refinedLag) || refinedLag <= 0) return null;

      const frequency = sampleRate / refinedLag;
      if (frequency < this.minFrequency || frequency > this.maxFrequency) return null;

      return { frequency, confidence: Math.max(0, Math.min(1, 1 - cmnd[candidate])) };
    }

    // Parabolic interpolation around the minimum for sub-sample precision.
    _interpolate(cmnd, tau) {
      const left = cmnd[tau - 1];
      const centre = cmnd[tau];
      const right = cmnd[tau + 1];
      const denominator = 2 * (2 * centre - left - right);
      if (!Number.isFinite(denominator) || denominator === 0) return tau;
      let offset = (right - left) / denominator;
      offset = Math.max(-1, Math.min(1, offset));
      return tau + offset;
    }
  }

  // ---------------------------------------------------------------- TunerState
  // Turns detections into something stable enough to display: median of the last
  // frequencies, note hysteresis, needle smoothing and the signal-state machine.
  class TunerState {
    constructor(options = {}) {
      this.a4 = options.a4 ?? 440;
      this.inTuneCents = options.inTuneCents ?? 1.5;
      this.historySize = options.historySize ?? 5;
      this.confidenceThreshold = options.confidenceThreshold ?? 0.6;
      this.holdMs = options.holdMs ?? 400;
      this.silenceMs = options.silenceMs ?? 300;
      this.needleAlpha = options.needleAlpha ?? 0.35;
      this.maxCents = options.maxCents ?? 50;
      this.reset();
    }

    reset() {
      this._history = [];
      this._note = null;
      this._pendingNote = null;
      this._pendingCount = 0;
      this._needle = 0;
      this._silentSince = null;
      this._heldSince = null;
      this._lastState = 'silent';
    }

    setA4(value) {
      const a4 = TunerMath.clampA4(value);
      if (a4 === null) return false;
      this.a4 = a4;
      return true;
    }

    update(result, now = 0) {
      const level = result.level ?? 0;
      const base = {
        note: null,
        octave: null,
        midi: null,
        frequency: null,
        cents: 0,
        needleCents: this._needle,
        confidence: result.confidence || 0,
        dbfs: result.dbfs ?? -120,
        level,
        clipping: Boolean(result.clipping),
        held: false,
      };

      // Silence (or no usable frequency at all)
      if (!result.frequency) {
        if (this._silentSince === null) this._silentSince = now;
        const silentFor = now - this._silentSince;

        if (this._note && silentFor < this.holdMs) {
          // Keep the last note visible for a moment, greyed out.
          this._lastState = 'silent';
          return {
            ...base,
            state: 'silent',
            note: this._note.note,
            octave: this._note.octave,
            midi: this._note.midi,
            frequency: this._note.frequency,
            cents: this._needle,
            held: true,
          };
        }

        if (silentFor >= this.holdMs) {
          this._note = null;
          this._history = [];
          this._needle = 0;
        }
        this._lastState = 'silent';
        return { ...base, state: 'silent', needleCents: this._needle };
      }

      this._silentSince = null;

      // Numeric history + median
      this._history.push(result.frequency);
      if (this._history.length > this.historySize) this._history.shift();
      const sorted = [...this._history].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      const info = TunerMath.frequencyToNote(median, this.a4);

      // Hysteresis: only change the displayed note after two consecutive readings
      // agree on it, so a wobbling reading does not make the note flicker.
      if (!this._note) {
        this._note = { midi: info.midi, note: info.note, octave: info.octave, frequency: median };
      } else if (info.note !== this._note.note) {
        if (this._pendingNote === info.note) this._pendingCount += 1;
        else { this._pendingNote = info.note; this._pendingCount = 1; }
        if (this._pendingCount >= 2) {
          this._note = { midi: info.midi, note: info.note, octave: info.octave, frequency: median };
          this._pendingNote = null;
          this._pendingCount = 0;
        }
      } else {
        this._pendingNote = null;
        this._pendingCount = 0;
      }
      this._note.frequency = median;

      const target = TunerMath.midiToFrequency(this._note.midi, this.a4);
      const cents = 1200 * Math.log2(median / target);
      const clamped = Math.max(-this.maxCents, Math.min(this.maxCents, cents));
      this._needle += this.needleAlpha * (clamped - this._needle);

      let state;
      if (result.confidence < this.confidenceThreshold) state = 'unstable';
      else if (result.clipping) state = 'clipping';
      else if (result.weak) state = 'weak';
      else if (Math.abs(cents) <= this.inTuneCents) state = 'in-tune';
      else state = 'ok';

      this._lastState = state;

      return {
        ...base,
        state,
        note: this._note.note,
        octave: this._note.octave,
        midi: this._note.midi,
        frequency: median,
        cents,
        needleCents: this._needle,
        held: false,
      };
    }
  }

  // UI strings for every state the panel can show.
  const STATE_TEXT = {
    silent: 'Play a string',
    weak: 'Weak signal',
    clipping: 'Signal too hot',
    unstable: 'Unstable signal',
    ok: 'Reading',
    'in-tune': 'IN TUNE',
    error: 'Audio input unavailable',
    disconnected: 'Input disconnected',
    paused: 'Paused',
  };

  const WORKLET_SOURCE = `
class PocketTunerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frameSize = opts.frameSize || 4096;
    this.hopSize = opts.hopSize || 1024;
    this.buffer = new Float32Array(this.frameSize);
    this.writeIndex = 0;
    this.filled = 0;
    this.hopCounter = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex] = channel[i];
      this.writeIndex = (this.writeIndex + 1) % this.frameSize;
      this.filled = Math.min(this.filled + 1, this.frameSize);
      this.hopCounter++;
      if (this.filled === this.frameSize && this.hopCounter >= this.hopSize) {
        this.hopCounter = 0;
        const frame = new Float32Array(this.frameSize);
        for (let j = 0; j < this.frameSize; j++) {
          frame[j] = this.buffer[(this.writeIndex + j) % this.frameSize];
        }
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('pocket-tuner', PocketTunerProcessor);
`;

  const STORAGE_KEYS = {
    inputLabel: 'pocketedit.tuner.inputLabel',
    a4: 'pocketedit.tuner.a4',
  };

  // ------------------------------------------------------------- TunerController
  // Owns the microphone stream, the Web Audio graph and the panel. DOM nodes are
  // passed in, so this can run (and be tested) outside the browser.
  class TunerController {
    // Must match the SVG paths in src/template.html.
    // halfSpan 90 = a full half circle: +-50 cents reaches the horizontal diameter.
    static GAUGE = { cx: 140, cy: 140, radius: 104, halfSpan: 90, tail: 12 };

    constructor(options = {}) {
      this.env = options.env || (typeof window !== 'undefined' ? window : globalThis);
      this.elements = options.elements || {};
      this.onState = options.onState || (() => {});
      this.frameSize = options.frameSize || 4096;
      this.hopSize = options.hopSize || 1024;

      this.detector = new PitchDetector({ sampleRate: 44100 });
      this.state = new TunerState({
        a4: this._readStoredA4(),
      });

      this.stream = null;
      this.audioContext = null;
      this.sourceNode = null;
      this.workletNode = null;
      this.analyserNode = null;
      this._nodes = [];
      this._fallbackTimer = null;
      this._track = null;
      this._devices = [];
      this._opened = false;
      this._lastAnnounce = 0;
      this._lastAnnouncedText = '';
      this._onVisibilityChange = () => this._handleVisibilityChange();
      this._onPageHide = () => this.close();
      this._currentDeviceId = null;

      this._syncA4Controls();
      this._buildGauge();
    }

    // Tick marks for the curved cents scale. The arc itself is static markup; the
    // ticks are generated from the same geometry (centre 120,100, radius 86,
    // +-60 degrees for +-50 cents).
    _buildGauge() {
      const group = this.elements.ticks;
      const doc = this.env.document;
      if (!group || typeof doc?.createElementNS !== 'function') return;

      const NS = 'http://www.w3.org/2000/svg';
      while (group.firstChild) group.removeChild(group.firstChild);

      const geometry = TunerController.GAUGE;
      const point = (degrees, r) => ({
        x: geometry.cx + r * Math.cos((degrees * Math.PI) / 180),
        y: geometry.cy + r * Math.sin((degrees * Math.PI) / 180),
      });

      // 5-cent steps: majors (and labels) land on -50, -25, 0, +25, +50.
      for (let cents = -50; cents <= 50; cents += 5) {
        const degrees = 270 + (cents / 50) * geometry.halfSpan;
        const major = cents % 25 === 0;
        const outer = point(degrees, geometry.radius);
        const inner = point(degrees, geometry.radius - (major ? 13 : 7));

        const line = doc.createElementNS(NS, 'line');
        line.setAttribute('x1', outer.x.toFixed(2));
        line.setAttribute('y1', outer.y.toFixed(2));
        line.setAttribute('x2', inner.x.toFixed(2));
        line.setAttribute('y2', inner.y.toFixed(2));
        line.setAttribute('class', cents === 0 ? 'centre' : major ? 'major' : 'minor');
        group.appendChild(line);

        // Every 25 cents gets a numeric label outside the arc.
        if (major) {
          const labelPoint = point(degrees, geometry.radius + 16);
          const text = doc.createElementNS(NS, 'text');
          text.setAttribute('x', labelPoint.x.toFixed(2));
          text.setAttribute('y', labelPoint.y.toFixed(2));
          text.setAttribute('class', cents === 0 ? 'centre' : 'major');
          text.textContent = cents === 0 ? '0' : cents > 0 ? `+${cents}` : String(cents);
          group.appendChild(text);
        }
      }
    }

    // ------------------------------------------------------------ persistence
    _storageGet(key) {
      try { return this.env.localStorage?.getItem(key) ?? null; } catch { return null; }
    }

    _storageSet(key, value) {
      try { this.env.localStorage?.setItem(key, value); } catch { /* ignore */ }
    }

    _readStoredA4() {
      const stored = this._storageGet(STORAGE_KEYS.a4);
      const parsed = stored === null ? null : TunerMath.clampA4(stored);
      return parsed === null ? 440 : parsed;
    }

    getStoredInputLabel() {
      return this._storageGet(STORAGE_KEYS.inputLabel);
    }

    // The MIDI/BLE connection already knows which hardware is in use; Web MIDI does
    // not expose its audio endpoint, so the device name is the only link between the
    // two. Prefer the matching audio input over the system default.
    setPreferredDeviceName(name) {
      this.preferredDeviceName = name ? String(name) : null;
      return this.preferredDeviceName;
    }

    _normalizeLabel(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/\b(midi|usb|audio|input|output|port|interface|1|2|3)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    // --------------------------------------------------------------- lifecycle
    async open() {
      this._opened = true;
      this._showPanel(true);
      if (this.env.location?.protocol === 'file:') {
        this.elements.help && (this.elements.help.textContent =
          'Running from file://. Browsers often forget the microphone permission after a reload; '
          + 'serve the folder over http://localhost to stop the prompt. No audio leaves the browser.');
      }
      this._setStatus('requesting', 'Requesting audio input...');
      try {
        await this.start();
      } catch (error) {
        this._handleStartError(error);
      }
    }

    async close() {
      this._opened = false;
      this.stop();
      this._showPanel(false);
    }

    async start(deviceId = null) {
      const mediaDevices = this.env.navigator?.mediaDevices;
      if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
        const error = new Error('Audio input is not available in this context.');
        error.code = 'unsupported';
        throw error;
      }
      const AudioContextClass = this.env.AudioContext || this.env.webkitAudioContext;
      if (!AudioContextClass) {
        const error = new Error('Web Audio is not available in this browser.');
        error.code = 'unsupported';
        throw error;
      }

      this._teardown();

      const constraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      };

      let stream;
      try {
        stream = await mediaDevices.getUserMedia(constraints);
      } catch (error) {
        // A stale persisted device id must not make the tuner unusable.
        if (deviceId && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
          this._setStatus('error', 'Saved input not found, using the default device.');
          stream = await mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
          deviceId = null;
        } else {
          throw error;
        }
      }

      // The panel may have been closed while the permission prompt was open.
      if (!this._opened) {
        for (const track of stream.getTracks?.() || []) {
          try { track.stop(); } catch { /* already stopped */ }
        }
        return false;
      }

      this.stream = stream;
      this._track = stream.getAudioTracks?.()[0] || null;
      this._attachTrackEvents();

      this.audioContext = new AudioContextClass();
      if (this.audioContext.state === 'suspended') await this.audioContext.resume?.();
      this.detector.setSampleRate(this.audioContext.sampleRate || 44100);

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);

      // Force mono by summing L/R: the pedal streams processed stereo and one side
      // may be silent.
      const mono = this.audioContext.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';

      const highpass = this.audioContext.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 35;

      this._nodes = [mono, highpass];
      this.sourceNode.connect(mono);
      mono.connect(highpass);

      const workletReady = await this._startWorklet(highpass);
      if (!workletReady) this._startAnalyserFallback(highpass);

      await this._refreshDevices(deviceId);
      this._currentDeviceId = deviceId || this._track?.getSettings?.().deviceId || null;

      this._installGlobalListeners();
      this._setStatus('running', 'Listening...');
      return true;
    }

    stop() {
      this._teardown();
      this.state.reset();
      this._renderIdle();
    }

    _teardown() {
      this._removeGlobalListeners();
      if (this._fallbackTimer !== null) {
        this.env.clearInterval?.(this._fallbackTimer);
        this._fallbackTimer = null;
      }
      for (const node of [this.workletNode, this.analyserNode, ...this._nodes]) {
        try { node?.disconnect?.(); } catch { /* already gone */ }
      }
      this.workletNode = null;
      this.analyserNode = null;
      this._nodes = [];

      try { this.sourceNode?.disconnect?.(); } catch { /* already gone */ }
      this.sourceNode = null;

      if (this.stream) {
        // Detach the handler first: some engines fire onended from stop(), which
        // would re-enter _teardown().
        if (this._track) this._track.onended = null;
        for (const track of this.stream.getTracks?.() || []) {
          try { track.stop(); } catch { /* already stopped */ }
        }
      }
      this.stream = null;
      this._track = null;

      if (this.audioContext) {
        try { this.audioContext.close?.(); } catch { /* already closed */ }
      }
      this.audioContext = null;
      this._currentDeviceId = null;
    }

    async _startWorklet(destination) {
      const AudioWorkletNodeClass = this.env.AudioWorkletNode;
      const createObjectURL = this.env.URL?.createObjectURL;
      if (!AudioWorkletNodeClass || !this.audioContext?.audioWorklet || typeof createObjectURL !== 'function') {
        return false;
      }
      try {
        const blob = new this.env.Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const url = createObjectURL.call(this.env.URL, blob);
        await this.audioContext.audioWorklet.addModule(url);
        this.env.URL.revokeObjectURL?.(url);

        const node = new AudioWorkletNodeClass(this.audioContext, 'pocket-tuner', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: { frameSize: this.frameSize, hopSize: this.hopSize },
        });
        node.port.onmessage = (event) => this._handleSamples(event.data);
        destination.connect(node);
        // Keep the graph pulling audio without producing audible output.
        const silentGain = this.audioContext.createGain();
        silentGain.gain.value = 0;
        node.connect(silentGain);
        silentGain.connect(this.audioContext.destination);
        this._nodes.push(silentGain);
        this.workletNode = node;
        return true;
      } catch (error) {
        this._log(`AudioWorklet unavailable, using AnalyserNode: ${error.message}`);
        return false;
      }
    }

    _startAnalyserFallback(destination) {
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 8192;
      destination.connect(analyser);
      this.analyserNode = analyser;
      this._analyserBuffer = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (!this.analyserNode) return;
        this.analyserNode.getFloatTimeDomainData(this._analyserBuffer);
        this._handleSamples(this._analyserBuffer);
        this._fallbackTimer = this.env.setTimeout?.(tick, 50) ?? null;
      };
      tick();
    }

    _handleSamples(samples) {
      if (!this._opened || !this.stream) return;
      const result = this.detector.detect(samples);
      const model = this.state.update(result, this.env.performance?.now?.() ?? Date.now());
      this._render(model);
      this.onState(model);
    }

    async _refreshDevices(preferredDeviceId) {
      const mediaDevices = this.env.navigator?.mediaDevices;
      if (!mediaDevices?.enumerateDevices) return;

      try {
        const devices = await mediaDevices.enumerateDevices();
        this._devices = devices.filter((device) => device.kind === 'audioinput');
      } catch {
        this._devices = [];
      }

      const select = this.elements.inputSelect;
      if (select) {
        select.textContent = '';
        const defaultOption = this.env.document?.createElement?.('option');
        if (defaultOption) {
          defaultOption.value = '';
          defaultOption.textContent = 'System default';
          select.appendChild(defaultOption);
        }
        for (const device of this._devices) {
          const option = this.env.document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Input ${select.options.length}`;
          select.appendChild(option);
        }
      }

      const preferredLabel = this.getStoredInputLabel();
      const target = this._pickDevice(preferredDeviceId, preferredLabel);
      if (select && target?.deviceId) select.value = target.deviceId;
      return target;
    }

    // Priority: the device already connected over USB/BLE MIDI, then PocketMaster by
    // name, then the user's stored choice, then the system default.
    _pickDevice(preferredDeviceId, preferredLabel) {
      if (!this._devices.length) return null;
      if (preferredDeviceId) {
        const exact = this._devices.find((device) => device.deviceId === preferredDeviceId);
        if (exact) return exact;
      }

      const connected = this._matchConnectedDevice();
      if (connected) return connected;

      const pocket = this._devices.find((device) => /pocket\s*master|pocketmaster|pocket|sonic\s*master/i.test(device.label || ''));
      if (pocket) return pocket;

      if (preferredLabel) {
        const stored = this._devices.find((device) => device.label === preferredLabel);
        if (stored) return stored;
      }
      return this._devices.find((device) => device.deviceId === 'default') || this._devices[0];
    }

    _matchConnectedDevice() {
      const wanted = this._normalizeLabel(this.preferredDeviceName);
      if (!wanted) return null;

      const candidates = this._devices.filter((device) => device.label);
      // 1) same normalised name
      const exact = candidates.find((device) => this._normalizeLabel(device.label) === wanted);
      if (exact) return exact;
      // 2) one contains the other ("Pocket Master" vs "Pocket Master USB Audio")
      const partial = candidates.find((device) => {
        const label = this._normalizeLabel(device.label);
        return label && wanted && (label.includes(wanted) || wanted.includes(label));
      });
      if (partial) return partial;
      // 3) the distinctive words match ("pocket", "master", "sonicake")
      const tokens = wanted.split(' ').filter((token) => token.length > 3);
      if (!tokens.length) return null;
      return candidates.find((device) => {
        const label = this._normalizeLabel(device.label);
        return tokens.every((token) => label.includes(token));
      }) || null;
    }

    async selectInput(deviceId) {
      const device = this._devices.find((entry) => entry.deviceId === deviceId);
      if (device?.label) this._storageSet(STORAGE_KEYS.inputLabel, device.label);
      await this.start(deviceId || null);
      this._opened = true;
      this._showPanel(true);
    }

    async refreshDevices() {
      await this._refreshDevices(this._currentDeviceId);
    }

    setA4(value) {
      const accepted = this.state.setA4(value);
      if (!accepted) {
        this._setStatus('error', 'Reference must be between 430 and 450 Hz.');
        this._syncA4Controls();
        return false;
      }
      this._storageSet(STORAGE_KEYS.a4, String(this.state.a4));
      this._syncA4Controls();
      this._setStatus('running', `Reference A4 = ${this.state.a4.toFixed(1)} Hz`);
      return true;
    }

    _syncA4Controls() {
      if (this.elements.a4Input) this.elements.a4Input.value = this.state.a4.toFixed(1);
    }

    // -------------------------------------------------------------------- UI
    _showPanel(visible) {
      const { panel, backdrop } = this.elements;
      if (panel) panel.hidden = !visible;
      if (backdrop) backdrop.hidden = !visible;
      if (visible) {
        this.elements.closeButton?.focus?.();
        this._installGlobalListeners();
      } else {
        this._removeGlobalListeners();
      }
    }

    _installGlobalListeners() {
      const doc = this.env.document;
      if (!doc) return;
      if (!this._listenersInstalled) {
        doc.addEventListener('visibilitychange', this._onVisibilityChange);
        this.env.addEventListener?.('pagehide', this._onPageHide);
        this._listenersInstalled = true;
      }
    }

    _removeGlobalListeners() {
      const doc = this.env.document;
      if (!doc || !this._listenersInstalled) return;
      doc.removeEventListener('visibilitychange', this._onVisibilityChange);
      this.env.removeEventListener?.('pagehide', this._onPageHide);
      this._listenersInstalled = false;
    }

    _handleVisibilityChange() {
      const hidden = this.env.document?.hidden;
      if (!this.audioContext) return;
      if (hidden) {
        this.audioContext.suspend?.();
        this._setStatus('paused', 'Paused (tab hidden)');
      } else if (this._opened) {
        this.audioContext.resume?.();
        this._setStatus('running', 'Listening...');
      }
    }

    _attachTrackEvents() {
      if (!this._track) return;
      this._track.onended = () => {
        this._teardown();
        this._setStatus('disconnected', 'Input disconnected. Reconnect the device.');
        this.onState({ state: 'disconnected' });
      };
    }

    _handleStartError(error) {
      const name = error?.name || '';
      let message;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        message = 'Microphone permission denied. Allow it in the browser (lock icon) and try again.';
      } else if (name === 'NotFoundError') {
        message = 'No audio input found. Connect the device and try again.';
      } else if (error?.code === 'unsupported') {
        message = error.message;
      } else {
        message = `Audio input unavailable: ${error?.message || error}`;
      }
      this.stop();
      this._setStatus('error', message);
      this.onState({ state: 'error', message });
    }

    _setStatus(state, text) {
      this._status = { state, text };
      const { status } = this.elements;
      if (status) {
        status.textContent = text;
        status.dataset.state = state;
      }
      this._statusText = text;
      const announce = this.elements.announcer;
      if (announce) {
        const now = this.env.performance?.now?.() ?? Date.now();
        if (text !== this._lastAnnouncedText && now - this._lastAnnounce > 400) {
          announce.textContent = text;
          this._lastAnnounce = now;
          this._lastAnnouncedText = text;
        }
      }
      this._applyPanelState(state);
    }

    _applyPanelState(state) {
      const panel = this.elements.panel;
      if (!panel?.classList) return;
      panel.dataset.state = state;
      for (const name of ['ok', 'in-tune', 'silent', 'weak', 'clipping', 'unstable', 'error', 'disconnected', 'paused']) {
        panel.classList.toggle(`tuner-state-${name}`, state === name);
      }
    }

    // Places the needle line so its tail always sits on the pivot and its tip lies
    // on the arc for the given cents value.
    _positionNeedle(line, cents) {
      const geometry = TunerController.GAUGE;
      const degrees = 270 + cents * (geometry.halfSpan / 50);
      const radians = (degrees * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const tipRadius = geometry.radius - 16;
      const tailRadius = geometry.tail;

      line.setAttribute('x1', (geometry.cx - cos * tailRadius).toFixed(2));
      line.setAttribute('y1', (geometry.cy - sin * tailRadius).toFixed(2));
      line.setAttribute('x2', (geometry.cx + cos * tipRadius).toFixed(2));
      line.setAttribute('y2', (geometry.cy + sin * tipRadius).toFixed(2));
      line.removeAttribute?.('transform');
    }

    _render(model) {
      const e = this.elements;
      const noteText = model.note || '--';
      if (e.note) {
        e.note.textContent = noteText;
        e.note.classList.toggle('held', Boolean(model.held));
      }
      if (e.frequency) {
        e.frequency.textContent = model.frequency ? `${model.frequency.toFixed(1)} Hz` : '-- Hz';
      }
      if (e.needle) {
        // Draw the needle from explicit end points instead of rotating it: a CSS
        // transform-origin and an SVG rotate() attribute combine differently across
        // engines (the needle drifted away from the pivot), while coordinates cannot.
        this._positionNeedle(e.needle, Math.max(-50, Math.min(50, model.needleCents || 0)));
      }
      if (e.cents) {
        e.cents.textContent = model.frequency
          ? `${model.cents > 0 ? '+' : ''}${model.cents.toFixed(1)} cents`
          : '--';
      }
      if (e.level) e.level.style.width = `${Math.round((model.level || 0) * 100)}%`;
      if (e.levelBar) e.levelBar.dataset.hot = model.clipping ? 'true' : 'false';
      if (e.confidence) e.confidence.style.width = `${Math.round((model.confidence || 0) * 100)}%`;
      if (e.confidenceText) e.confidenceText.textContent = `${Math.round((model.confidence || 0) * 100)}%`;

      // The notes one semitone below/above, shown at the ends of the scale.
      if (e.prevNote || e.nextNote) {
        if (Number.isFinite(model.midi)) {
          if (e.prevNote) e.prevNote.textContent = `♭ ${TunerMath.midiToNoteName(model.midi - 1)}`;
          if (e.nextNote) e.nextNote.textContent = `${TunerMath.midiToNoteName(model.midi + 1)} ♯`;
        } else {
          if (e.prevNote) e.prevNote.textContent = '--';
          if (e.nextNote) e.nextNote.textContent = '--';
        }
      }

      const stateName = model.state === 'ok' ? 'ok' : model.state;
      const verdict = STATE_TEXT[stateName] || STATE_TEXT.ok;
      if (e.verdict) {
        e.verdict.textContent = model.state === 'ok' && model.frequency
          ? `${model.cents > 0 ? 'SHARP +' : 'FLAT '}${Math.abs(model.cents).toFixed(1)} cents`
          : verdict;
        e.verdict.dataset.state = stateName;
      }
      this._applyPanelState(stateName);
      this._statusText = verdict;

      // Polite announcements, throttled so a screen reader is not flooded.
      const announce = e.announcer;
      if (announce) {
        const now = this.env.performance?.now?.() ?? Date.now();
        if (verdict !== this._lastAnnouncedText && now - this._lastAnnounce > 400) {
          announce.textContent = verdict;
          this._lastAnnounce = now;
          this._lastAnnouncedText = verdict;
        }
      }
    }

    _renderIdle() {
      const e = this.elements;
      if (e.note) e.note.textContent = '--';
      if (e.frequency) e.frequency.textContent = '-- Hz';
      if (e.cents) e.cents.textContent = '--';
      if (e.needle) this._positionNeedle(e.needle, 0);
      if (e.prevNote) e.prevNote.textContent = '--';
      if (e.nextNote) e.nextNote.textContent = '--';
      if (e.level) e.level.style.width = '0%';
      if (e.confidence) e.confidence.style.width = '0%';
      if (e.confidenceText) e.confidenceText.textContent = '--';
      this._applyPanelState('idle');
    }

    _log(message) {
      this.onLog?.(message);
    }
  }

  return { PitchDetector, TunerMath, TunerState, TunerController, STATE_TEXT, STORAGE_KEYS, WORKLET_SOURCE };
})();

// The build inlines this file into the page; expose the namespace for src/app.js.
if (typeof window !== 'undefined') window.PocketTuner = PocketTuner;
