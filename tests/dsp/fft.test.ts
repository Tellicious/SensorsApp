import { describe, it, expect } from 'vitest';
import { FftProcessor, dominantFrequencies, FFT_SIZES } from '../../src/lib/dsp/fft';

/** Build a Float32Array of N samples of a unit-amplitude sine at f Hz, fs Hz sample rate. */
function makeSine(N: number, f: number, fs: number, amplitude = 1): Float32Array {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = amplitude * Math.sin(2 * Math.PI * f * i / fs);
  return out;
}

describe('FftProcessor', () => {
  it('produces a peak at the bin matching a pure-sine input', () => {
    const N = 1024;
    const fs = 8000;
    // Choose a frequency that lands exactly on a bin (avoid scalloping):
    // bin = f*N/fs ⇒ f = bin*fs/N. Pick bin 100 ⇒ f = 781.25 Hz.
    const targetBin = 100;
    const f = targetBin * fs / N;
    const fft = new FftProcessor({ size: N, window: 'rectangular', overlapPct: 0, sampleRate: fs });
    const frame = makeSine(N, f, fs);

    const { mag } = fft.compute(frame);

    // The peak should be at targetBin
    let maxIdx = 0;
    for (let i = 1; i < mag.length; i++) {
      if (mag[i] > mag[maxIdx]) maxIdx = i;
    }
    expect(maxIdx).toBe(targetBin);

    // And the peak magnitude should be near the sine amplitude (1.0)
    expect(mag[targetBin]).toBeCloseTo(1.0, 1);
  });

  it('DC input puts energy in bin 0 only', () => {
    const N = 512;
    const fft = new FftProcessor({ size: N, window: 'rectangular', overlapPct: 0, sampleRate: 1000 });
    const frame = new Float32Array(N).fill(0.5);

    const { mag } = fft.compute(frame);
    expect(mag[0]).toBeCloseTo(0.5, 2);
    // Other bins should be essentially zero
    for (let k = 1; k < mag.length; k++) {
      expect(mag[k]).toBeLessThan(1e-6);
    }
  });

  it('frequency bins are spaced correctly', () => {
    const N = 1024;
    const fs = 4000;
    const fft = new FftProcessor({ size: N, window: 'hann', overlapPct: 50, sampleRate: fs });
    expect(fft.freqs.length).toBe(N / 2);
    expect(fft.freqs[0]).toBe(0);
    expect(fft.freqs[1]).toBeCloseTo(fs / N, 6);
    expect(fft.freqs[fft.freqs.length - 1]).toBeCloseTo((N / 2 - 1) * fs / N, 4);
  });

  it('throws if frame size mismatches FFT size', () => {
    const fft = new FftProcessor({ size: 256, window: 'rectangular', overlapPct: 0, sampleRate: 1000 });
    expect(() => fft.compute(new Float32Array(128))).toThrow();
  });

  it('supports every advertised FFT_SIZES', () => {
    // Just instantiate each one with rectangular window and a zero frame
    for (const sz of FFT_SIZES) {
      const fft = new FftProcessor({ size: sz, window: 'rectangular', overlapPct: 0, sampleRate: 48000 });
      const { mag, db } = fft.compute(new Float32Array(sz));
      expect(mag.length).toBe(sz / 2);
      expect(db.length).toBe(sz / 2);
    }
  });
});

describe('dominantFrequencies', () => {
  it('returns the top-N peaks sorted by magnitude desc', () => {
    const N = 1024;
    const fs = 8000;
    const fft = new FftProcessor({ size: N, window: 'hann', overlapPct: 0, sampleRate: fs });

    // Build a signal with three sines at known frequencies
    const f1 = 500, f2 = 1500, f3 = 2500;
    const frame = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      frame[i] =
        1.0 * Math.sin(2 * Math.PI * f1 * i / fs) +
        0.5 * Math.sin(2 * Math.PI * f2 * i / fs) +
        0.25 * Math.sin(2 * Math.PI * f3 * i / fs);
    }
    const { mag } = fft.compute(frame);
    const tops = dominantFrequencies(mag, fft.freqs, 3);

    expect(tops).toHaveLength(3);
    // Sorted descending by magnitude
    expect(tops[0].mag).toBeGreaterThan(tops[1].mag);
    expect(tops[1].mag).toBeGreaterThan(tops[2].mag);
    // Found frequencies should be within one bin width of the targets
    const bw = fs / N;
    expect(Math.abs(tops[0].freq - f1)).toBeLessThan(bw);
    expect(Math.abs(tops[1].freq - f2)).toBeLessThan(bw);
    expect(Math.abs(tops[2].freq - f3)).toBeLessThan(bw);
  });

  it('returns an empty array when there are no peaks', () => {
    const mag = new Float32Array(64);
    const freqs = new Float32Array(64);
    for (let i = 0; i < 64; i++) freqs[i] = i * 10;
    const tops = dominantFrequencies(mag, freqs, 5);
    expect(tops).toEqual([]);
  });

  it('parabolic interpolation yields sub-bin precision', () => {
    const N = 2048;
    const fs = 8000;
    const fft = new FftProcessor({ size: N, window: 'hann', overlapPct: 0, sampleRate: fs });
    // Pick a frequency deliberately between two bins
    const bw = fs / N;             // ≈ 3.9 Hz
    const f = 12 * bw + 0.5 * bw;  // exactly halfway between bin 12 and 13
    const frame = makeSine(N, f, fs);
    const { mag } = fft.compute(frame);
    const tops = dominantFrequencies(mag, fft.freqs, 1);
    expect(tops).toHaveLength(1);
    // With interpolation we should beat the bin-quantization error
    expect(Math.abs(tops[0].freq - f)).toBeLessThan(bw / 2);
  });
});
