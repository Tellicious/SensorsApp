import { describe, it, expect } from 'vitest';
import {
  makeWindow,
  coherentGain,
  enbw,
  WINDOW_NAMES
} from '../../src/lib/dsp/windowing';

describe('makeWindow', () => {
  it('rectangular: all ones', () => {
    const w = makeWindow('rectangular', 8);
    expect(w.length).toBe(8);
    for (const v of w) expect(v).toBe(1);
  });

  it('hann: zeros at endpoints, peak in middle', () => {
    const w = makeWindow('hann', 8);
    expect(w[0]).toBeCloseTo(0, 5);
    expect(w[7]).toBeCloseTo(0, 5);
    // Peak is near the middle samples
    const max = Math.max(...w);
    const argmax = Array.from(w).indexOf(max);
    expect(argmax).toBeGreaterThanOrEqual(3);
    expect(argmax).toBeLessThanOrEqual(4);
  });

  it('hann: symmetric', () => {
    const w = makeWindow('hann', 16);
    for (let i = 0; i < 8; i++) {
      expect(w[i]).toBeCloseTo(w[15 - i], 6);
    }
  });

  it('hamming: endpoint value is 0.08', () => {
    const w = makeWindow('hamming', 16);
    expect(w[0]).toBeCloseTo(0.08, 4);
    expect(w[15]).toBeCloseTo(0.08, 4);
  });

  it('blackman: symmetric and bounded in [0,1]', () => {
    const w = makeWindow('blackman', 32);
    for (let i = 0; i < w.length; i++) {
      expect(w[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(w[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
    for (let i = 0; i < 16; i++) expect(w[i]).toBeCloseTo(w[31 - i], 6);
  });

  it('flat-top: contains expected coefficient pattern', () => {
    // Flat-top dips slightly negative in its side lobes — sanity check the
    // central value is the largest by far.
    const w = makeWindow('flat-top', 64);
    const middle = w[32];
    expect(middle).toBeGreaterThan(0.9);
  });

  it('every named window has the requested length', () => {
    for (const name of WINDOW_NAMES) {
      const w = makeWindow(name, 128);
      expect(w.length).toBe(128);
    }
  });
});

describe('coherentGain', () => {
  it('rectangular has coherentGain == 1', () => {
    const w = makeWindow('rectangular', 1024);
    expect(coherentGain(w)).toBeCloseTo(1, 6);
  });

  it('hann has coherentGain == 0.5', () => {
    // For Hann the sum is (N-1)/2 ≈ N/2 for large N
    const w = makeWindow('hann', 1024);
    expect(coherentGain(w)).toBeCloseTo(0.5, 2);
  });
});

describe('enbw', () => {
  it('rectangular has enbw == 1', () => {
    const w = makeWindow('rectangular', 1024);
    expect(enbw(w)).toBeCloseTo(1, 6);
  });

  it('hann has enbw == 1.5', () => {
    const w = makeWindow('hann', 1024);
    expect(enbw(w)).toBeCloseTo(1.5, 2);
  });

  it('blackman has enbw ≈ 1.73', () => {
    const w = makeWindow('blackman', 1024);
    expect(enbw(w)).toBeCloseTo(1.73, 1);
  });
});
