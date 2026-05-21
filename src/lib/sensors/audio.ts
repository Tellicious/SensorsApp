/**
 * Audio sensor wrapper.
 *
 * Uses MediaStream + AudioContext + AnalyserNode. We deliberately disable
 * the browser's audio DSP (echo cancellation, noise suppression, automatic
 * gain control) so the displayed levels reflect the true acoustic input —
 * otherwise dB SPL calibration is meaningless.
 *
 * AudioWorklet would be the cleanest way to get raw frame buffers, but it
 * requires a separate worklet file. AnalyserNode is sufficient here: it
 * exposes both `getFloatTimeDomainData` (waveform) and
 * `getFloatFrequencyData` (FFT in dB), which is exactly what we need.
 */

export interface AudioController {
  /**
   * Start mic acquisition. Triggers the iOS permission prompt the first
   * time. MUST be invoked from a user-gesture handler.
   */
  start(): Promise<void>;
  /** Stop, release the mic, and close the AudioContext. */
  stop(): Promise<void>;
  /** Fill `out` with the current time-domain frame (range ~[-1, 1]). */
  getTimeDomain(out: Float32Array): void;
  /** Fill `out` with the current frequency-domain frame in dB. */
  getFrequencyData(out: Float32Array): void;
  /**
   * Fill `out` with linear magnitudes (dB → 10^(dB/20)).
   * Avoids the caller having to convert back from dB just to apply
   * frequency weighting in the linear domain.
   */
  getFrequencyMag(out: Float32Array): Float32Array;
  /** Change the FFT size on the fly. Mainly used from Settings. */
  setFftSize(size: number): void;
  readonly fftSize: number;
  /** The browser-decided sample rate (48 kHz on most iPhones). */
  readonly sampleRate: number;
  readonly running: boolean;
}

/**
 * Factory: build a new audio controller. Caller decides initial FFT size;
 * everything else is wired on `start()`.
 */
export async function createAudioController(initialFftSize = 4096): Promise<AudioController> {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let _fftSize = initialFftSize;
  let _running = false;

  // Scratch buffer reused for the AnalyserNode → linear-magnitude conversion.
  // Reallocated only when FFT size changes.
  let dbScratch: Float32Array | null = null;

  async function start() {
    if (_running) return;
    // Request the mic with all browser DSP disabled — we want raw audio.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });
    // Safari requires the AudioContext to be constructed in a user-gesture;
    // the page calls start() from a click handler so we're fine here.
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = _fftSize;
    // smoothingTimeConstant > 0 averages successive FFTs into the readout —
    // we want raw frames, so zero. The dB range matches what AnalyserNode
    // exposes by default; tuning this doesn't affect our linear math.
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    source.connect(analyser);
    _running = true;
  }

  async function stop() {
    _running = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (source) { try { source.disconnect(); } catch { /* */ } source = null; }
    analyser = null;
    if (ctx) { try { await ctx.close(); } catch { /* */ } ctx = null; }
  }

  return {
    start,
    stop,
    getTimeDomain(out) { if (analyser) analyser.getFloatTimeDomainData(out); },
    getFrequencyData(out) { if (analyser) analyser.getFloatFrequencyData(out); },
    /**
     * AnalyserNode only exposes dB values directly. To do power-domain math
     * (e.g. weighted broadband integration), we need linear magnitudes:
     * mag = 10^(dB / 20). We do this conversion once per call and return
     * the same buffer the caller passed in.
     */
    getFrequencyMag(out) {
      if (!analyser) return out;
      const bins = analyser.frequencyBinCount;
      if (!dbScratch || dbScratch.length !== bins) dbScratch = new Float32Array(bins);
      analyser.getFloatFrequencyData(dbScratch);
      for (let i = 0; i < bins; i++) out[i] = Math.pow(10, dbScratch[i] / 20);
      return out;
    },
    setFftSize(size) {
      _fftSize = size;
      if (analyser) analyser.fftSize = size;
    },
    get fftSize() { return _fftSize; },
    get sampleRate() { return ctx ? ctx.sampleRate : 0; },
    get running() { return _running; }
  };
}
