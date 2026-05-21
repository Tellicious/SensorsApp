// FFT wrapper. Uses fft.js (radix-2). Operates on a fixed-size frame,
// applies the chosen window, returns magnitude (linear) and dB spectra.

import FFT from 'fft.js';
import { coherentGain, enbw, makeWindow, type WindowName } from './windowing';

export const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768] as const;
export type FftSize = (typeof FFT_SIZES)[number];

export interface FftConfig {
  size: FftSize;
  window: WindowName;
  overlapPct: 0 | 25 | 50 | 75;
  /** sample rate of the input data, in Hz */
  sampleRate: number;
}

export class FftProcessor {
  readonly size: number;
  readonly sampleRate: number;
  readonly window: Float32Array;
  readonly bins: number;
  readonly freqs: Float32Array;
  readonly cg: number;
  private fft: FFT;
  private out: Float64Array;
  private windowed: Float64Array;

  constructor(cfg: FftConfig) {
    this.size = cfg.size;
    this.sampleRate = cfg.sampleRate;
    this.window = makeWindow(cfg.window, cfg.size);
    this.cg = coherentGain(this.window);
    this.bins = cfg.size / 2;
    this.freqs = new Float32Array(this.bins);
    for (let k = 0; k < this.bins; k++) {
      this.freqs[k] = (k * cfg.sampleRate) / cfg.size;
    }
    this.fft = new FFT(cfg.size);
    this.out = this.fft.createComplexArray() as unknown as Float64Array;
    this.windowed = new Float64Array(cfg.size);
  }

  /**
   * Compute magnitude spectrum for a real-valued frame of length `size`.
   * Output is amplitude-corrected (divided by N * coherentGain), single-sided.
   * `magOut` and `dbOut`, if provided, are filled and returned to avoid alloc.
   */
  compute(
    frame: Float32Array,
    magOut?: Float32Array,
    dbOut?: Float32Array
  ): { mag: Float32Array; db: Float32Array } {
    const N = this.size;
    if (frame.length !== N) throw new Error(`frame length ${frame.length} != ${N}`);
    // window
    for (let i = 0; i < N; i++) this.windowed[i] = frame[i] * this.window[i];
    // fft
    this.fft.realTransform(this.out, this.windowed);
    this.fft.completeSpectrum(this.out);
    // single-sided magnitude
    const mag = magOut ?? new Float32Array(this.bins);
    const db = dbOut ?? new Float32Array(this.bins);
    const norm = 1 / (N * this.cg);
    for (let k = 0; k < this.bins; k++) {
      const re = this.out[2 * k];
      const im = this.out[2 * k + 1];
      // single-sided: multiply by 2 except DC and Nyquist
      const scale = (k === 0 || k === this.bins - 1) ? norm : 2 * norm;
      const m = Math.sqrt(re * re + im * im) * scale;
      mag[k] = m;
      // dBFS-ish: 20*log10(m). Floor at -200 dB to keep finite.
      db[k] = m > 1e-12 ? 20 * Math.log10(m) : -200;
    }
    return { mag, db };
  }
}

/**
 * Find the top-N dominant frequencies from a magnitude spectrum.
 * Uses simple local-max detection + sort by magnitude.
 * Skips DC (k=0). Returns array of { freq, mag } sorted by mag desc.
 */
export function dominantFrequencies(
  mag: Float32Array,
  freqs: Float32Array,
  n: number,
  minBin = 1
): Array<{ freq: number; mag: number; binIdx: number }> {
  const peaks: Array<{ freq: number; mag: number; binIdx: number }> = [];
  for (let k = Math.max(1, minBin); k < mag.length - 1; k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
      // Parabolic interpolation for better frequency estimate
      const a = mag[k - 1], b = mag[k], c = mag[k + 1];
      const denom = a - 2 * b + c;
      const p = denom !== 0 ? 0.5 * (a - c) / denom : 0;
      const df = freqs[1] - freqs[0];
      peaks.push({
        freq: freqs[k] + p * df,
        mag: b - 0.25 * (a - c) * p,
        binIdx: k
      });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, n);
}
