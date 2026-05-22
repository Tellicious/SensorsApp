/**
 * Audio capture controller.
 *
 * Wraps Web Audio + AnalyserNode to expose:
 *   - getTimeDomain(buf)        → fills with current time-domain samples
 *   - getFrequencyDataDb(buf)   → fills with current FFT magnitudes (dB)
 *   - start() / stop()
 *
 * iOS Safari notes (caused "Audio not working at all" symptom):
 *   - AudioContext must be created from a user gesture, and may start
 *     in 'suspended' state — we call resume() defensively.
 *   - getUserMedia constraints with channelCount:1 are rejected on
 *     several iOS Safari versions (returns OverconstrainedError). We
 *     omit channelCount and let the system pick.
 *   - sampleRate hints are also unreliable on iOS — omitting them
 *     means we get whatever the device offers (usually 44100 or 48000).
 *   - echoCancellation / noiseSuppression / autoGainControl are set
 *     to false because they wreck the spectrum and SPL readings.
 */

export interface AudioController {
  start(): Promise<void>;
  stop(): void;
  getTimeDomain(out: Float32Array): void;
  getFrequencyDataDb(out: Float32Array): void;
  readonly sampleRate: number;
  readonly fftSize: number;
}

export async function createAudioController(fftSize: number): Promise<AudioController> {
  // Validate fftSize is a power of 2 in the analyser's accepted range
  const validSize = (() => {
    const allowed = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    return allowed.includes(fftSize) ? fftSize : 4096;
  })();

  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let started = false;

  return {
    get sampleRate() { return ctx?.sampleRate ?? 48000; },
    get fftSize() { return validSize; },

    async start() {
      if (started) return;
      // iOS-safe constraints: omit channelCount / sampleRate hints
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
      } catch (e) {
        // Fall back to the simplest possible constraint
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e2) {
          throw new Error('Microphone access denied or unavailable: ' + (e2 as Error).message);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      ctx = new AC();
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* */ }
      }

      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = validSize;
      analyser.smoothingTimeConstant = 0;  // we smooth ourselves where wanted
      analyser.minDecibels = -120;
      analyser.maxDecibels = 0;
      source.connect(analyser);
      started = true;
    },

    stop() {
      started = false;
      try { source?.disconnect(); } catch { /* */ }
      try { analyser?.disconnect(); } catch { /* */ }
      try { stream?.getTracks().forEach(t => t.stop()); } catch { /* */ }
      try { ctx?.close(); } catch { /* */ }
      source = null; analyser = null; stream = null; ctx = null;
    },

    getTimeDomain(out: Float32Array) {
      if (!analyser) { out.fill(0); return; }
      analyser.getFloatTimeDomainData(out);
    },

    getFrequencyDataDb(out: Float32Array) {
      if (!analyser) { out.fill(-120); return; }
      analyser.getFloatFrequencyData(out);
    }
  };
}
